const BASE = '/sdwan';

export async function getDashboard() {
  const res = await fetch(`${BASE}/dashboard`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Dashboard HTTP ${res.status}`);
  return res.json();
}

export async function getBFDSessions(deviceId) {
  const res = await fetch(
    `${BASE}/bfd-sessions?deviceId=${encodeURIComponent(deviceId)}`,
    { credentials: 'include' }
  );
  if (!res.ok) throw new Error(`BFD HTTP ${res.status}`);
  return res.json();
}

export async function getCapacity() {
  const res = await fetch(`${BASE}/capacity?limit=500`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Capacity HTTP ${res.status}`);
  return res.json();
}
