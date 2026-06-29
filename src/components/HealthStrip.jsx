import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { effectiveState, isHub } from '../utils';

export default function HealthStrip({ rows }) {
  const stats = useMemo(() => {
    const edges = rows.filter(r => !isHub(r));
    const total = edges.length;
    if (!total) return null;
    const up      = edges.filter(r => effectiveState(r) === 'up').length;
    const down    = edges.filter(r => effectiveState(r) === 'down').length;
    const partial = edges.filter(r => effectiveState(r) === 'partial').length;
    const bfdLoss = edges.filter(r => effectiveState(r) === 'bfd-loss').length;
    const pct     = Math.round((up / total) * 100);
    return { total, up, down, partial, bfdLoss, pct };
  }, [rows]);

  if (!stats) return null;

  const r    = 18;
  const circ = 2 * Math.PI * r;
  const ringColor =
    stats.pct >= 95 ? '#22c55e' :
    stats.pct >= 75 ? '#f59e0b' : '#ef4444';

  return (
    <div className="health-strip">
      <div className="health-ring-wrap">
        <svg width="48" height="48" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
          <motion.circle
            cx="24" cy="24" r={r}
            fill="none"
            stroke={ringColor}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circ}
            initial={{ strokeDashoffset: circ }}
            animate={{ strokeDashoffset: circ * (1 - stats.pct / 100) }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
            transform="rotate(-90 24 24)"
          />
        </svg>
        <span className="health-ring-pct" style={{ color: ringColor }}>
          {stats.pct}%
        </span>
      </div>

      <div className="health-sep" />

      <Stat count={stats.up}      label="UP"       color="#22c55e" />
      <Stat count={stats.down}    label="DOWN"     color="#ef4444" pulse={stats.down > 0} />
      <Stat count={stats.partial} label="PARTIAL"  color="#f59e0b" />
      <Stat count={stats.bfdLoss} label="BFD LOSS" color="#f59e0b" />

      <div className="health-sep" />

      <div className="health-total">
        <span className="health-total-n">{stats.total}</span>
        <span className="health-total-lbl">sites</span>
      </div>
    </div>
  );
}

function Stat({ count, label, color, pulse }) {
  return (
    <div className="health-stat">
      <AnimatePresence mode="wait">
        <motion.span
          key={count}
          className="health-stat-n"
          style={{ color }}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.2 }}
        >
          {count}
        </motion.span>
      </AnimatePresence>
      <span className="health-stat-lbl" style={pulse && count > 0 ? { color, opacity: 0.85 } : undefined}>
        {label}
      </span>
    </div>
  );
}
