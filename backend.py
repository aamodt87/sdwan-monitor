import asyncio
import ipaddress
import os
import re
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Set, Tuple

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

# =========================
# Config
# =========================
VMANAGE_URL = os.getenv("VMANAGE_HOST", "").rstrip("/")
VMANAGE_USER = os.getenv("VMANAGE_USER", "")
VMANAGE_PASS = os.getenv("VMANAGE_PASS", "")
CISCO_CLIENT_ID = os.getenv("CISCO_CLIENT_ID", "")
CISCO_CLIENT_SECRET = os.getenv("CISCO_CLIENT_SECRET", "")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5500")
VERIFY_TLS = os.getenv("VERIFY_TLS", "false").lower() == "true"
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "60"))
TRACKER_HOURS = int(os.getenv("TRACKER_HOURS", "1"))
TRACKER_MIN_DOWN = int(os.getenv("TRACKER_MIN_DOWN", "2"))
BFD_CONCURRENCY = int(os.getenv("BFD_CONCURRENCY", "6"))

EXPECTED_SESSIONS: Dict[str, int] = {
    "biz-internet": 4,
    "public-internet": 4,
    "mpls": 2,
    "private1": 2,
}

SINGLE_LINE_HOSTS: Set[str] = {
    # Example:
    # "P45RTR01",
}

IGNORED_COLORS_FOR_SINGLE_LINE: Set[str] = {"mpls"}

EXCLUDED_HOSTNAME_PATTERNS = (
    re.compile(r"^az-sdwan-", re.I),
)

# =========================
# App lifecycle / cache
# =========================
cache_lock = asyncio.Lock()
backend_cache: Dict[str, Any] = {
    "dashboard": {
        "tloc_summary": [],
        "tracker": [],
        "last_update": None,
        "error": None,
    },
    "devices": [],
    "alarms": [],
    "advisories": [],
    "bfd_sessions_by_device": {},
    "capacity": [],
    "last_success": None,
    "last_attempt": None,
    "refresh_running": False,
    "error": None,
}

poller_task: Optional[asyncio.Task] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global poller_task
    poller_task = asyncio.create_task(cache_poller())
    try:
        yield
    finally:
        if poller_task:
            poller_task.cancel()
            try:
                await poller_task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="SD-WAN Dashboard Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN, "http://127.0.0.1:5500", "http://localhost:5500"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# Helpers
# =========================
_IPv4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def is_excluded_hostname(hostname: str) -> bool:
    hn = (hostname or "").strip()
    return any(p.search(hn) for p in EXCLUDED_HOSTNAME_PATTERNS)


def _to_int(v: Any, default: int = 0) -> int:
    try:
        if v in (None, "", "--"):
            return default
        return int(v)
    except Exception:
        return default


def _to_float(v: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if v in (None, "", "--", "0", 0):
            return default
        f = float(v)
        return f if f != 0.0 else default
    except Exception:
        return default


def _extract_ipv4s(val: Any) -> List[str]:
    results: List[str] = []

    def add_from_string(s: str) -> None:
        for m in _IPv4_RE.findall(str(s)):
            try:
                ipaddress.IPv4Address(m)
                results.append(m)
            except ipaddress.AddressValueError:
                pass

    if isinstance(val, list):
        for v in val:
            if v is None:
                continue
            add_from_string(str(v))
    elif val is not None:
        add_from_string(str(val))
    return results


def clean_version(version: str) -> str:
    match = re.match(r"^(\d+\.\d+\.\d+[a-zA-Z]?)", version or "")
    return match.group(1) if match else (version or "")


def group_advisories(advisories: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped: Dict[str, Dict[str, Any]] = {}
    for item in advisories:
        title = item.get("title", "Untitled Advisory")
        version = item.get("version", "Unknown")
        url = item.get("url", "")
        description = item.get("description", "")
        first_fixed = item.get("firstFixed", [])
        summary = item.get("summary", "No summary")
        if title not in grouped:
            grouped[title] = {
                "title": title,
                "versions": set(),
                "firstFixed": set(),
                "url": url,
                "description": description,
                "summary": summary,
            }
        grouped[title]["versions"].add(version)
        for fix in first_fixed:
            grouped[title]["firstFixed"].add(fix)

    return [
        {
            **data,
            "versions": sorted(list(data["versions"])),
            "firstFixed": sorted(list(data["firstFixed"])),
        }
        for data in grouped.values()
    ]


def color_is_down(color: str, bfd_up: int, bfd_down: int) -> bool:
    c = (color or "").lower()
    if bfd_up <= 0:
        return True
    if c in ("biz-internet", "public-internet"):
        return bfd_down >= 4
    if c in ("mpls", "private1"):
        return bfd_down >= 2
    return bfd_down > 0


# =========================
# vManage / Cisco auth helpers
# =========================
async def get_vmanage_session(client: httpx.AsyncClient) -> List[str]:
    res = await client.post(
        f"{VMANAGE_URL}/j_security_check",
        data={"j_username": VMANAGE_USER, "j_password": VMANAGE_PASS},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    cookies = res.headers.get_list("set-cookie")
    if not cookies:
        raise HTTPException(status_code=401, detail="vManage login failed")
    return cookies


async def build_auth_headers(client: httpx.AsyncClient) -> Dict[str, str]:
    cookies = await get_vmanage_session(client)
    headers = {"Cookie": "; ".join(cookies)}
    tok = await client.get(f"{VMANAGE_URL}/dataservice/client/token", headers=headers)
    tok.raise_for_status()
    headers.update(
        {
            "Content-Type": "application/json",
            "X-XSRF-TOKEN": tok.text.strip(),
        }
    )
    return headers


async def get_cisco_token(client: httpx.AsyncClient) -> str:
    res = await client.post(
        "https://id.cisco.com/oauth2/default/v1/token",
        data={
            "client_id": CISCO_CLIENT_ID,
            "client_secret": CISCO_CLIENT_SECRET,
            "grant_type": "client_credentials",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    res.raise_for_status()
    token = res.json().get("access_token")
    if not token:
        raise HTTPException(status_code=500, detail="Cisco token missing in response")
    return token


# =========================
# Data builders
# =========================
async def fetch_all_devices_with_headers(client: httpx.AsyncClient, headers: Dict[str, str]) -> List[dict]:
    res = await client.get(f"{VMANAGE_URL}/dataservice/device", headers=headers)
    res.raise_for_status()
    return res.json().get("data", []) or []


async def fetch_all_devices() -> List[dict]:
    async with httpx.AsyncClient(verify=VERIFY_TLS, timeout=30.0) as client:
        headers = await build_auth_headers(client)
        return await fetch_all_devices_with_headers(client, headers)


async def get_advisory(version: str, token: str, client: httpx.AsyncClient) -> List[Dict[str, Any]]:
    try:
        res = await client.get(
            f"https://apix.cisco.com/security/advisories/v2/OSType/iosxe?version={version}",
            headers={"Authorization": f"Bearer {token}"},
        )
        res.raise_for_status()
        advisories = res.json().get("advisories", [])
        return [
            {
                "version": version,
                "title": adv.get("advisoryTitle"),
                "firstFixed": adv.get("firstFixed", []),
                "summary": adv.get("summary", ""),
                "description": adv.get("description", ""),
                "url": adv.get("publicationUrl", ""),
            }
            for adv in advisories
        ]
    except Exception:
        return []


async def build_advisories_data() -> List[Dict[str, Any]]:
    return []


async def build_alarms_data(client: httpx.AsyncClient, headers: Dict[str, str]) -> List[Dict[str, Any]]:
    raw_query = {
        "query": {
            "condition": "AND",
            "rules": [
                {"field": "entry_time", "operator": "last_n_hours", "type": "date", "value": ["1"]},
                {"field": "active", "type": "boolean", "value": ["true"], "operator": "equal"},
                {"field": "acknowledged", "type": "boolean", "value": ["false"], "operator": "equal"},
                {"field": "severity", "type": "string", "operator": "not_equal", "value": ["Minor"]},
            ],
        }
    }
    from urllib.parse import quote
    import json

    encoded_query = quote(json.dumps(raw_query))
    url = f"{VMANAGE_URL}/dataservice/alarms?query={encoded_query}"
    res = await client.get(url, headers=headers)
    res.raise_for_status()
    return res.json().get("data", []) or []


async def fetch_policy_map(client: httpx.AsyncClient, headers: Dict[str, str]) -> Dict[str, Dict[str, Any]]:
    pg_res = await client.get(f"{VMANAGE_URL}/dataservice/v1/policy-group", headers=headers)
    pg_res.raise_for_status()
    groups: List[Dict[str, Any]] = pg_res.json() or []

    policy_by_host: Dict[str, Dict[str, Any]] = {}
    sem = asyncio.Semaphore(8)

    async def fetch_assoc(group: Dict[str, Any]) -> None:
        gid = group.get("id")
        if not gid:
            return
        url = f"{VMANAGE_URL}/dataservice/v1/policy-group/{gid}/device/associate"
        async with sem:
            r = await client.get(url, headers=headers)
            if r.status_code == 404:
                return
            r.raise_for_status()
            body = r.json() or {}
            for dev in body.get("devices", []):
                host = dev.get("host-name")
                if not host:
                    continue
                if host in policy_by_host and policy_by_host[host].get("description"):
                    continue
                policy_by_host[host] = {
                    "id": gid,
                    "name": group.get("name"),
                    "description": group.get("description") or "",
                    "upToDate": str(dev.get("policyGroupUpToDate", "")).lower() == "true",
                }

    await asyncio.gather(*(fetch_assoc(g) for g in groups))
    return policy_by_host


async def build_tloc_summary_data(client: httpx.AsyncClient, headers: Dict[str, str]) -> List[Dict[str, Any]]:
    dev_rows = await fetch_all_devices_with_headers(client, headers)

    ip_to_host: Dict[str, str] = {}
    ip_to_site: Dict[str, str] = {}
    ip_to_lat: Dict[str, Optional[float]] = {}
    ip_to_lng: Dict[str, Optional[float]] = {}
    ip_to_personality: Dict[str, str] = {}
    included_ips: Set[str] = set()

    for d in dev_rows:
        sys_ip = d.get("system-ip")
        host = d.get("host-name", sys_ip)
        if not sys_ip:
            continue
        if is_excluded_hostname(host):
            continue
        ip_to_host[sys_ip] = host
        ip_to_site[sys_ip] = d.get("site-id")
        ip_to_personality[sys_ip] = d.get("personality", "")
        included_ips.add(sys_ip)

        # Extract lat/lng — vManage exposes these on the device object.
        # Try multiple field name conventions.
        lat = (
            _to_float(d.get("latitude"))
            or _to_float(d.get("lat"))
            or _to_float(d.get("geo-latitude"))
        )
        lng = (
            _to_float(d.get("longitude"))
            or _to_float(d.get("long"))
            or _to_float(d.get("lon"))
            or _to_float(d.get("geo-longitude"))
        )
        ip_to_lat[sys_ip] = lat
        ip_to_lng[sys_ip] = lng

    tloc_res = await client.get(f"{VMANAGE_URL}/dataservice/device/tloc", headers=headers)
    tloc_res.raise_for_status()
    tloc_rows = tloc_res.json().get("data", []) or []

    up_by_ip: Dict[str, Set[str]] = {ip: set() for ip in included_ips}
    down_by_ip: Dict[str, Set[str]] = {ip: set() for ip in included_ips}
    stats_by_ip_color: Dict[Tuple[str, str], Dict[str, int]] = {}

    for r in tloc_rows:
        sys_ip = r.get("system-ip") or r.get("system_ip")
        if sys_ip not in included_ips:
            continue
        color = (r.get("color") or "unknown").lower()
        bfd_up = _to_int(r.get("bfdSessionsUp"), 0)
        bfd_down = _to_int(r.get("bfdSessionsDown"), 0)
        ctrl_up = _to_int(r.get("controlConnectionsUp"), 0)

        if bfd_up == 0 and bfd_down == 0 and ctrl_up == 0:
            continue

        stats_by_ip_color[(sys_ip, color)] = {
            "up": bfd_up,
            "down": bfd_down,
            "ctrlUp": ctrl_up,
        }

        if color_is_down(color, bfd_up, bfd_down):
            down_by_ip[sys_ip].add(color)
        else:
            up_by_ip[sys_ip].add(color)

    detail_res = await client.get(f"{VMANAGE_URL}/dataservice/device/bfd/tloc/detail", headers=headers)
    detail_res.raise_for_status()
    detail_rows = detail_res.json().get("data", []) or []

    for r in detail_rows:
        sys_ip = r.get("system_ip") or r.get("system-ip")
        if sys_ip not in included_ips:
            continue
        color = (r.get("color") or "unknown").lower()
        state = str(r.get("state", "")).lower()
        if state != "down":
            continue

        down_by_ip[sys_ip].add(color)
        key = (sys_ip, color)
        if key not in stats_by_ip_color:
            stats_by_ip_color[key] = {
                "up": 0,
                "down": EXPECTED_SESSIONS.get(color, 0) or 1,
                "ctrlUp": 0,
            }

    policy_by_host = await fetch_policy_map(client, headers)

    result: List[Dict[str, Any]] = []

    for sys_ip in sorted(included_ips, key=lambda x: (str(ip_to_site.get(x, "")), str(ip_to_host.get(x, x)))):
        hostname = ip_to_host.get(sys_ip, sys_ip)
        site_id = ip_to_site.get(sys_ip)

        up_colors = up_by_ip.get(sys_ip, set())
        down_colors = down_by_ip.get(sys_ip, set())

        ignored_for_overall: Set[str] = IGNORED_COLORS_FOR_SINGLE_LINE if hostname in SINGLE_LINE_HOSTS else set()
        eff_up = {c for c in up_colors if c not in ignored_for_overall}
        eff_down = {c for c in down_colors if c not in ignored_for_overall}

        if eff_down and eff_up:
            overall = "partial"
        elif eff_down and not eff_up:
            overall = "down"
        elif eff_up and not eff_down:
            overall = "up"
        else:
            overall = "up" if up_colors else ("down" if down_colors else "unknown")

        tloc_stats: Dict[str, Dict[str, Any]] = {}
        present_colors: Set[str] = set()
        for (ip, color), vals in stats_by_ip_color.items():
            if ip != sys_ip:
                continue
            present_colors.add(color)
            expected = EXPECTED_SESSIONS.get(color)
            up_ct = int(vals.get("up", 0))
            down_ct = int(vals.get("down", 0))
            ctrl_up = int(vals.get("ctrlUp", 0))
            missing = max((expected or 0) - up_ct, 0) if expected is not None else 0

            if color in down_colors:
                st = "down"
            elif expected is not None and missing > 0:
                st = "degraded"
            else:
                st = "ok"

            tloc_stats[color] = {
                "expected": expected,
                "up": up_ct,
                "down": down_ct,
                "ctrlUp": ctrl_up,
                "missing": missing,
                "status": st,
                "ignored": color in ignored_for_overall,
            }

        if not tloc_stats:
            overall = "down"

        is_single_line = hostname in SINGLE_LINE_HOSTS
        internet_missing = (not is_single_line) and (
            "biz-internet" not in present_colors and "public-internet" not in present_colors
        )
        if internet_missing and overall == "up":
            overall = "partial"

        pol = policy_by_host.get(hostname, {})

        result.append(
            {
                "system_ip": sys_ip,
                "hostname": hostname,
                "site_id": site_id,
                "overall": overall,
                "up": sorted(up_colors),
                "down": sorted(down_colors),
                "ignoredForOverall": sorted(ignored_for_overall) if ignored_for_overall else [],
                "tlocStats": tloc_stats,
                "present": sorted(present_colors),
                "internetMissing": internet_missing,
                "policyId": pol.get("id"),
                "policyName": pol.get("name"),
                "policyDescription": pol.get("description") or None,
                "policyUpToDate": pol.get("upToDate"),
                "lat": ip_to_lat.get(sys_ip),
                "lng": ip_to_lng.get(sys_ip),
                "personality": ip_to_personality.get(sys_ip, ""),
            }
        )

    return result


async def build_tracker_data(
    client: httpx.AsyncClient,
    headers: Dict[str, str],
    device_id: Optional[str] = None,
    hours: int = TRACKER_HOURS,
) -> List[Dict[str, Any]]:
    dev_rows = await fetch_all_devices_with_headers(client, headers)
    ip2host = {d.get("system-ip"): d.get("host-name", d.get("system-ip")) for d in dev_rows}

    raw_query: Dict[str, Any] = {
        "query": {
            "condition": "AND",
            "rules": [
                {
                    "field": "entry_time",
                    "operator": "last_n_hours",
                    "type": "date",
                    "value": [str(hours)],
                },
                {
                    "field": "tracker_status",
                    "operator": "in",
                    "type": "string",
                    "value": ["DOWN", "Down", "down"],
                },
            ],
        },
        "size": 1000,
    }

    if device_id:
        raw_query["query"]["rules"].append(
            {
                "field": "vdevice_name",
                "operator": "in",
                "type": "string",
                "value": [device_id],
            }
        )

    res = await client.post(
        f"{VMANAGE_URL}/dataservice/statistics/endpointTracker",
        json=raw_query,
        headers=headers,
    )
    res.raise_for_status()
    rows = res.json().get("data", []) or []

    def pick_host(item: Dict[str, Any]) -> str:
        return item.get("host_name") or ip2host.get(item.get("vdevice_name"), item.get("vdevice_name") or "UNKNOWN")

    def pick_iface(item: Dict[str, Any]) -> str:
        return (
            item.get("if_name")
            or item.get("interface")
            or item.get("intf_name")
            or item.get("dst_if_name")
            or "UNKNOWN"
        )

    def pick_endpoints(item: Dict[str, Any]) -> List[str]:
        ip_fields = (
            "endpoint",
            "endpoints",
            "destination_ip",
            "target_ip",
            "dst_ip",
            "dest_ip",
            "dstAddress",
            "dst_address",
        )
        ips: List[str] = []
        for k in ip_fields:
            ips.extend(_extract_ipv4s(item.get(k)))

        seen, out = set(), []
        for ip in ips:
            if ip not in seen:
                seen.add(ip)
                out.append(ip)
        return out

    def pick_tracker_id(item: Dict[str, Any]) -> str:
        ips = pick_endpoints(item)
        if ips:
            return "|".join(sorted(ips))
        return (
            str(item.get("tracker_name") or "")
            or str(item.get("record_name") or "")
            or str(item.get("tracker_id") or "")
            or str(item.get("object_id") or "")
            or str(item.get("name") or "")
            or "UNKNOWN_TRACKER"
        )

    grouped_eps: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    grouped_trackers: Dict[Tuple[str, str], Set[str]] = defaultdict(set)

    for it in rows:
        status = str(it.get("tracker_status") or "").strip().upper()
        if status != "DOWN":
            continue

        host = pick_host(it)
        iface = pick_iface(it)
        pair = (host, iface)

        tracker_id = pick_tracker_id(it)
        grouped_trackers[pair].add(tracker_id)

        for ip in pick_endpoints(it):
            grouped_eps[pair].add(ip)

    result: List[Dict[str, Any]] = []
    seen_hosts: Set[str] = set()

    for host, iface in sorted(grouped_trackers.keys(), key=lambda x: (x[0], x[1])):
        if host in seen_hosts:
            continue

        down_count = len(grouped_trackers[(host, iface)])
        if down_count < TRACKER_MIN_DOWN:
            continue

        ips = sorted(grouped_eps.get((host, iface), []))
        result.append(
            {
                "Host_name": host,
                "Interface": iface,
                "tracker_status": "DOWN",
                "Down_Trackers": down_count,
                "Endpoints": ", ".join(ips) if ips else "-",
            }
        )
        seen_hosts.add(host)

    return result


async def fetch_bfd_sessions_for_device(
    client: httpx.AsyncClient,
    headers: Dict[str, str],
    device_id: str,
    device_map: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    device_info = device_map.get(device_id)
    if not device_info:
        return []

    site_id = device_info.get("site-id")
    if not site_id:
        return []

    health_res = await client.get(
        f"{VMANAGE_URL}/dataservice/statistics/tunnelhealth/history?last_n_hours=1&site={site_id}",
        headers=headers,
    )
    health_res.raise_for_status()
    tunnel_health = health_res.json() or []

    sessions: List[Dict[str, Any]] = []
    for tunnel in tunnel_health:
        summary = tunnel.get("summary", {})
        sessions.append(
            {
                "system-ip": tunnel.get("local_system_ip"),
                "remote-system-ip": tunnel.get("remote_system_ip"),
                "hostname": tunnel.get("name", "").split(":")[0],
                "color": tunnel.get("local_color"),
                "rcolor": tunnel.get("remote_color"),
                "state": summary.get("state", "unknown"),
                "tunnel-name": tunnel.get("name", ""),
                "latency": summary.get("latency", 0.0),
                "jitter": summary.get("jitter", 0.0),
                "loss-percentage": summary.get("loss_percentage", 0.0),
                "tx_octets": summary.get("tx_octets"),
                "rx_octets": summary.get("rx_octets"),
            }
        )

    return sessions


async def build_all_bfd_sessions_data(
    client: httpx.AsyncClient,
    headers: Dict[str, str],
    devices: List[dict],
) -> Dict[str, List[Dict[str, Any]]]:
    device_map = {d.get("system-ip"): d for d in devices if d.get("system-ip")}
    result: Dict[str, List[Dict[str, Any]]] = {}
    sem = asyncio.Semaphore(BFD_CONCURRENCY)

    async def fetch_one(device_id: str) -> None:
        async with sem:
            try:
                result[device_id] = await fetch_bfd_sessions_for_device(client, headers, device_id, device_map)
            except Exception:
                result[device_id] = []

    await asyncio.gather(*(fetch_one(device_id) for device_id in device_map.keys()))
    return result


async def build_capacity_data(
    client: httpx.AsyncClient,
    headers: Dict[str, str],
) -> List[Dict[str, Any]]:
    res = await client.get(
        f"{VMANAGE_URL}/dataservice/statistics/interface/ccapacity/distribution",
        headers=headers,
    )
    res.raise_for_status()
    return res.json().get("data", []) or []


async def build_dashboard_snapshot() -> Dict[str, Any]:
    async with httpx.AsyncClient(verify=VERIFY_TLS, timeout=45.0) as client:
        headers = await build_auth_headers(client)
        devices = await fetch_all_devices_with_headers(client, headers)

        tloc_summary, tracker, alarms, bfd_sessions_by_device, capacity = await asyncio.gather(
            build_tloc_summary_data(client, headers),
            build_tracker_data(client, headers, hours=TRACKER_HOURS),
            build_alarms_data(client, headers),
            build_all_bfd_sessions_data(client, headers, devices),
            build_capacity_data(client, headers),
        )

    snapshot = {
        "tloc_summary": tloc_summary,
        "tracker": tracker,
        "last_update": int(time.time()),
        "error": None,
    }
    return {
        "dashboard": snapshot,
        "devices": devices,
        "alarms": alarms,
        "bfd_sessions_by_device": bfd_sessions_by_device,
        "capacity": capacity,
    }


# =========================
# Background refresh
# =========================
async def refresh_backend_cache() -> None:
    async with cache_lock:
        if backend_cache["refresh_running"]:
            return
        backend_cache["refresh_running"] = True
        backend_cache["last_attempt"] = int(time.time())

    try:
        payload = await build_dashboard_snapshot()
        advisories = await build_advisories_data()

        async with cache_lock:
            backend_cache["dashboard"] = payload["dashboard"]
            backend_cache["devices"] = payload["devices"]
            backend_cache["alarms"] = payload["alarms"]
            backend_cache["bfd_sessions_by_device"] = payload["bfd_sessions_by_device"]
            backend_cache["capacity"] = payload["capacity"]
            backend_cache["advisories"] = advisories
            backend_cache["last_success"] = int(time.time())
            backend_cache["error"] = None
    except Exception as e:
        async with cache_lock:
            backend_cache["error"] = str(e)
            backend_cache["dashboard"]["error"] = str(e)
    finally:
        async with cache_lock:
            backend_cache["refresh_running"] = False


async def cache_poller() -> None:
    await refresh_backend_cache()
    while True:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        await refresh_backend_cache()


# =========================
# API endpoints
# =========================
@app.get("/health")
async def health() -> Dict[str, Any]:
    async with cache_lock:
        return {
            "status": "ok",
            "refresh_running": backend_cache["refresh_running"],
            "last_success": backend_cache["last_success"],
            "error": backend_cache["error"],
        }


@app.get("/cache/status")
async def cache_status() -> Dict[str, Any]:
    async with cache_lock:
        return {
            "last_attempt": backend_cache["last_attempt"],
            "last_success": backend_cache["last_success"],
            "refresh_running": backend_cache["refresh_running"],
            "error": backend_cache["error"],
            "counts": {
                "tloc_summary": len(backend_cache["dashboard"].get("tloc_summary", [])),
                "tracker": len(backend_cache["dashboard"].get("tracker", [])),
                "devices": len(backend_cache.get("devices", [])),
                "alarms": len(backend_cache.get("alarms", [])),
                "advisories": len(backend_cache.get("advisories", [])),
                "bfd_devices": len(backend_cache.get("bfd_sessions_by_device", {})),
                "capacity": len(backend_cache.get("capacity", [])),
            },
        }


@app.post("/cache/refresh")
async def cache_refresh() -> Dict[str, Any]:
    await refresh_backend_cache()
    async with cache_lock:
        return {
            "ok": True,
            "last_success": backend_cache["last_success"],
            "error": backend_cache["error"],
        }


@app.get("/dashboard")
async def get_dashboard() -> Dict[str, Any]:
    async with cache_lock:
        return backend_cache["dashboard"]


@app.get("/tloc-summary")
async def tloc_summary() -> List[Dict[str, Any]]:
    async with cache_lock:
        return backend_cache["dashboard"].get("tloc_summary", [])


@app.get("/tracker")
async def get_tracker() -> List[Dict[str, Any]]:
    async with cache_lock:
        return backend_cache["dashboard"].get("tracker", [])


@app.get("/devices")
async def get_devices() -> List[Dict[str, Any]]:
    async with cache_lock:
        return backend_cache.get("devices", [])


@app.get("/alarms")
async def get_alarms() -> List[Dict[str, Any]]:
    async with cache_lock:
        return backend_cache.get("alarms", [])


@app.get("/advisories")
async def get_advisories() -> List[Dict[str, Any]]:
    async with cache_lock:
        return backend_cache.get("advisories", [])


@app.get("/capacity")
async def get_capacity(
    sort: Optional[str] = Query("max_up", description="Sort by: max_up, max_down, avg_up, avg_down"),
    limit: int = Query(50, ge=1, le=500),
) -> List[Dict[str, Any]]:
    sort_map = {
        "max_up":   "max_up_capacity_percentage",
        "max_down": "max_down_capacity_percentage",
        "avg_up":   "avg_up_capacity_percentage",
        "avg_down": "avg_down_capacity_percentage",
    }
    key = sort_map.get(sort, "max_up_capacity_percentage")

    async with cache_lock:
        data = list(backend_cache.get("capacity", []))

    data.sort(key=lambda x: float(x.get(key) or 0), reverse=True)
    return data[:limit]


@app.get("/tracker/debug")
async def tracker_debug(deviceId: Optional[str] = Query(None), hours: int = Query(1, ge=1, le=24)) -> Dict[str, Any]:
    async with httpx.AsyncClient(verify=VERIFY_TLS, timeout=45.0) as client:
        headers = await build_auth_headers(client)
        dev_rows = await fetch_all_devices_with_headers(client, headers)
        ip2host = {d.get("system-ip"): d.get("host-name", d.get("system-ip")) for d in dev_rows}

        raw_query: Dict[str, Any] = {
            "query": {
                "condition": "AND",
                "rules": [
                    {"field": "entry_time", "operator": "last_n_hours", "type": "date", "value": [str(hours)]},
                    {
                        "field": "tracker_status",
                        "operator": "in",
                        "type": "string",
                        "value": ["DOWN", "Down", "down"],
                    },
                ],
            },
            "size": 1000,
        }
        if deviceId:
            raw_query["query"]["rules"].append(
                {"field": "vdevice_name", "operator": "in", "type": "string", "value": [deviceId]}
            )

        res = await client.post(
            f"{VMANAGE_URL}/dataservice/statistics/endpointTracker",
            json=raw_query,
            headers=headers,
        )
        res.raise_for_status()
        rows = res.json().get("data", []) or []

        seen_hosts: Set[str] = set()
        unique_rows: List[Dict[str, Any]] = []
        for row in rows:
            host_name = row.get("host_name") or ip2host.get(row.get("vdevice_name"), row.get("vdevice_name"))
            if host_name and host_name not in seen_hosts:
                seen_hosts.add(host_name)
                unique_rows.append(row)

        return {
            "query": raw_query,
            "count": len(unique_rows),
            "data": unique_rows,
        }


@app.get("/bfd-sessions")
async def get_bfd_sessions(deviceId: str) -> List[Dict[str, Any]]:
    async with cache_lock:
        return backend_cache.get("bfd_sessions_by_device", {}).get(deviceId, [])


@app.get("/bfd-sessions/all")
async def get_all_bfd_sessions() -> Dict[str, List[Dict[str, Any]]]:
    async with cache_lock:
        return backend_cache.get("bfd_sessions_by_device", {})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend:app", host="0.0.0.0", port=8000, reload=True)
