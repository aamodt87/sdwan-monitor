import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { getDashboard, getBFDSessions } from '../api';
import {
  effectiveState,
  isController,
  isHub,
  normalizeText,
} from '../utils';
import SiteCard from './SiteCard';
import BFDTooltip from './BFDTooltip';
import HealthStrip from './HealthStrip';
import DeltaBanner from './DeltaBanner';

const cardMotion = {
  hidden: { opacity: 0, y: 14, scale: 0.97 },
  visible: (i) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { delay: i * 0.035, duration: 0.32, ease: [0.22, 1, 0.36, 1] },
  }),
  exit: { opacity: 0, scale: 0.93, transition: { duration: 0.18 } },
};

function isProblem(row) {
  const state = effectiveState(row);
  return state !== 'up' && state !== 'bfd-loss';
}

export default function Dashboard({ active, onIpMapReady }) {
  const [search,           setSearch]           = useState('');
  const [tooltip,          setTooltip]          = useState(null);
  const [changes,          setChanges]          = useState([]);
  const [changedHostnames, setChangedHostnames] = useState(new Set());
  const [showDelta,        setShowDelta]        = useState(false);
  const hideTimer    = useRef(null);
  const prevStateRef = useRef({});
  const flashTimer   = useRef(null);

  const { data: payload, isLoading, isError, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const raw  = await getDashboard();
      const rows = Array.isArray(raw.tloc_summary) ? raw.tloc_summary : [];
      await Promise.allSettled(
        rows.filter(r => !isHub(r) && !isController(r) && r.system_ip).map(async row => {
          try { row.bfdSessions = await getBFDSessions(row.system_ip); }
          catch { row.bfdSessions = []; }
        })
      );
      return raw;
    },
    refetchInterval: 60_000,
    enabled: active,
  });

  const rows   = payload?.tloc_summary || [];
  const lastTs = payload?.last_update;

  // Build ip→hostname map for capacity view
  useEffect(() => {
    if (!rows.length) return;
    const map = {};
    rows.forEach(r => { if (r.system_ip && r.hostname) map[r.system_ip] = r.hostname; });
    onIpMapReady(map);
  }, [rows, onIpMapReady]);

  // Delta tracking — compare states between refreshes
  useEffect(() => {
    if (!rows.length) return;
    const newMap = {};
    rows.forEach(r => { newMap[r.hostname] = effectiveState(r); });

    const prev = prevStateRef.current;
    if (Object.keys(prev).length > 0) {
      const diffs = Object.entries(newMap)
        .filter(([h, s]) => prev[h] !== undefined && prev[h] !== s)
        .map(([hostname, to]) => ({ hostname, from: prev[hostname], to }))
        .filter(d => d.from !== 'bfd-loss' && d.to !== 'bfd-loss');

      if (diffs.length > 0) {
        setChanges(diffs);
        setShowDelta(true);
        setChangedHostnames(new Set(diffs.map(d => d.hostname)));
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setChangedHostnames(new Set()), 5000);
      }
    }
    prevStateRef.current = newMap;
  }, [rows]);

  const hubs        = useMemo(() => rows.filter(isHub).sort((a, b) => a.hostname.localeCompare(b.hostname)), [rows]);
  const edges       = useMemo(() => rows.filter(r => !isHub(r) && !isController(r)).sort((a, b) => a.hostname.localeCompare(b.hostname)), [rows]);
  const issueEdges  = useMemo(() => edges.filter(isProblem), [edges]);
  const healthyEdges= useMemo(() => edges.filter(r => !isProblem(r)), [edges]);

  const q      = normalizeText(search);
  const filter = (arr) => !q ? arr : arr.filter(r => normalizeText(r.hostname).includes(q));

  const handleHover = useCallback((row, x, y) => {
    if (isHub(row) || isController(row) || !row.system_ip) return;
    clearTimeout(hideTimer.current);
    setTooltip({ systemIp: row.system_ip, hostname: row.hostname, x, y });
  }, []);

  const handleHoverEnd = useCallback(() => {
    hideTimer.current = setTimeout(() => setTooltip(null), 80);
  }, []);

  const handleMouseMove = useCallback((e) => {
    setTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev);
  }, []);

  const lastUpdated = lastTs
    ? new Date(lastTs * 1000).toLocaleString('nb-NO', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : null;

  if (!active) return null;

  return (
    <div className="dashboard" onMouseMove={handleMouseMove}>

      {rows.length > 0 && <HealthStrip rows={rows} />}

      <AnimatePresence>
        {showDelta && (
          <DeltaBanner
            changes={changes}
            onDismiss={() => setShowDelta(false)}
          />
        )}
      </AnimatePresence>

      <div className="toolbar">
        <div className="toolbar-meta">
          <span className="meta-stat"><span className="meta-num">{hubs.length + edges.length}</span> sites</span>
          <span className="meta-sep" />
          <span className="meta-stat"><span className="meta-num">{hubs.length}</span> HUBs</span>
          <span className="meta-sep" />
          <span className="meta-stat"><span className="meta-num">{edges.length}</span> URS</span>
          {lastUpdated && (
            <><span className="meta-sep" /><span className="meta-ts">Updated {lastUpdated}</span></>
          )}
        </div>
        <div className="search-wrap">
          <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            className="search-input"
            type="text"
            placeholder="Search location..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
              <button className="search-clear" onClick={() => setSearch('')}>
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <line x1="1" y1="1" x2="8" y2="8"/><line x1="8" y1="1" x2="1" y2="8"/>
                </svg>
              </button>
            )}
        </div>
      </div>

      {isLoading && <SkeletonGrid />}
      {isError   && <div className="error-banner">Failed to load: {error?.message}</div>}

      {!isLoading && !isError && (
        <div className="grid-container">
          <Section label="HUBs" count={hubs.length} icon={<IconHub />}>
            <CardGrid rows={filter(hubs)} q={q} changed={changedHostnames} onHover={handleHover} onHoverEnd={handleHoverEnd} />
          </Section>

          <Section label="Issues" count={issueEdges.length} icon={<IconAlert />} warn>
            {issueEdges.length === 0
              ? <div className="all-clear">All clear - no issues detected</div>
              : <CardGrid rows={filter(issueEdges)} q={q} changed={changedHostnames} onHover={handleHover} onHoverEnd={handleHoverEnd} />
            }
          </Section>

          <Section label="Sites" count={healthyEdges.length} icon={<IconSite />}>
            <CardGrid rows={filter(healthyEdges)} q={q} changed={changedHostnames} onHover={handleHover} onHoverEnd={handleHoverEnd} />
          </Section>
        </div>
      )}

      <BFDTooltip device={tooltip} />
    </div>
  );
}

function IconHub() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 22 7 22 17 12 22 2 17 2 7"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}

function IconSite() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function Section({ label, icon, count, warn, children }) {
  return (
    <section className={`section ${warn ? 'section-warn' : ''}`}>
      <h2 className="section-title">
        <span className="section-icon">{icon}</span>
        {label}
        <span className="count-pill">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function CardGrid({ rows, q, changed, onHover, onHoverEnd }) {
  return (
    <div className="card-grid">
      <AnimatePresence initial={false}>
        {rows.map((row, i) => (
          <motion.div
            key={row.hostname || row.system_ip || i}
            custom={i}
            variants={cardMotion}
            initial="hidden"
            animate="visible"
            exit="exit"
            layout
          >
            <SiteCard
              row={row}
              dimmed={!!q && !normalizeText(row.hostname).includes(q)}
              flashing={changed.has(row.hostname)}
              onHover={onHover}
              onHoverEnd={onHoverEnd}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="skeleton-wrap">
      {Array.from({ length: 18 }).map((_, i) => (
        <div key={i} className="skeleton-card" style={{ animationDelay: `${i * 0.05}s` }} />
      ))}
    </div>
  );
}
