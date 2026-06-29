import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { getBFDSessions } from '../api';
import { colorChip, formatBytes, lossColor, resolveRemoteName } from '../utils';

const PREFERRED_ORDER = [
  'biz-internet',
  'public-internet',
  'mpls',
  'private1',
  'unknown',
];


const COLOR_PAIR_ORDER = {
  'biz-internet|biz-internet':        0,
  'biz-internet|public-internet':     1,
  'public-internet|public-internet':  2,
  'public-internet|biz-internet':     3,
  'mpls|mpls':                        4,
  'mpls|biz-internet':                5,
  'mpls|public-internet':             6,
  'private1|private1':                7,
  'private1|biz-internet':            8,
  'private1|public-internet':         9,
};

function tileSortKey(t) {
  const lc        = t.color;
  const rc        = t.s.rcolor || t.color;
  const pairOrder = COLOR_PAIR_ORDER[`${lc}|${rc}`] ?? 50;
  return pairOrder;
}

function AnimArrow() {
  return (
    <svg className="bfd-anim-arrow" width="18" height="10" viewBox="0 0 18 10" fill="none">
      <line x1="1" y1="5" x2="13" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <polyline points="9,1 13,5 9,9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <line className="bfd-arrow-tail" x1="4" y1="5" x2="8" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}

function SignalBars({ color }) {
  return (
    <span className="signal-bars">
      {[3, 6, 10, 6, 3].map((h, i) => (
        <span
          key={i}
          className="signal-bar"
          style={{ height: h, background: color, animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

export default function BFDTooltip({ device }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const { data, isLoading } = useQuery({
    queryKey: ['bfd', device?.systemIp],
    queryFn: () => getBFDSessions(device.systemIp),
    enabled: !!device?.systemIp,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!device || !ref.current) return;
    const pad = 12;
    const el  = ref.current;
    const w   = el.offsetWidth;
    const h   = el.offsetHeight;
    let left  = device.x + 20;
    let top   = device.y + 20;
    if (left + w > window.innerWidth  - pad) left = Math.max(pad, device.x - w - 12);
    if (top  + h > window.innerHeight - pad) top  = Math.max(pad, device.y - h - 12);
    setPos({ left, top });
  }, [device?.x, device?.y, data]);

  if (!device) return null;

  return createPortal(
    <div
      ref={ref}
      className="bfd-tooltip"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="bfd-header">
        <span className="bfd-title">BFD Sessions</span>
        <span className="bfd-host">{device.hostname}</span>
        <span className="bfd-ip">{device.systemIp}</span>
      </div>

      {isLoading && (
        <div className="bfd-loading">
          <div className="bfd-spinner" />
          Loading sessions...
        </div>
      )}

      {!isLoading && (
        <BFDContent
          sessions={Array.isArray(data) ? data : []}
          hostname={device.hostname}
        />
      )}
    </div>,
    document.body
  );
}

function BFDContent({ sessions, hostname }) {
  if (!sessions.length) {
    return <p className="bfd-empty">No active BFD sessions.</p>;
  }

  const grouped = {};
  sessions.forEach(s => {
    const c = s.color || 'unknown';
    (grouped[c] ||= []).push(s);
  });

  const tiles = [];
  for (const color of PREFERRED_ORDER) {
    if (!grouped[color]) continue;
    for (const s of grouped[color]) {
      const tunnelParts = (s['tunnel-name'] || '').split(':');
      let from = s.hostname || hostname;
      let to   = resolveRemoteName(s['remote-system-ip']);

      if (tunnelParts.length === 3) {
        from = tunnelParts[0];
        const m = tunnelParts[2]?.match(/HUB-[A-Z]{2}/);
        if (m) to = m[0];
      }

      const loss   = Number(s['loss-percentage'] || 0).toFixed(2);
      const lat    = Number(s.latency  || 0).toFixed(2);
      const jitter = Number(s.jitter   || 0).toFixed(2);
      const isDown = (s.state || '').toLowerCase() === 'down';
      const routeColor = colorChip(color);

      tiles.push({ color, from, to, s, loss, lat, jitter, isDown, routeColor });
    }
  }

  tiles.sort((a, b) => tileSortKey(a) - tileSortKey(b));

  const n = tiles.length;
  const cols = n <= 1      ? 1
             : n <= 3      ? n
             : n === 4     ? 2
             : n % 4 === 0 ? 4
             : n % 3 === 0 ? 3
             : Math.min(4, Math.ceil(n / 2));

  return (
    <div className="bfd-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(175px, 1fr))` }}>
      {tiles.map((t, i) => (
        <motion.div
          key={`${t.color}-${t.from}-${t.to}-${i}`}
          className="bfd-tile"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05, duration: 0.2, ease: 'easeOut' }}
        >
          <div className="bfd-tile-colors">
            <ColorPill color={t.color} />
            {t.s.rcolor && t.s.rcolor !== t.color && (
              <>
                <AnimArrow />
                <ColorPill color={t.s.rcolor} />
              </>
            )}
          </div>

          <div className="bfd-route">
            <span className="bfd-node">{t.from}</span>
            <SignalBars color={t.routeColor} />
            <span className="bfd-node">{t.to}</span>
          </div>

          {t.isDown ? (
            <div className="bfd-session-down">DOWN</div>
          ) : (
            <div className="bfd-stats">
              <StatRow label="Tx"      value={formatBytes(t.s.tx_octets)} />
              <StatRow label="Rx"      value={formatBytes(t.s.rx_octets)} />
              <StatRow label="Latency" value={`${t.lat} ms`} />
              <StatRow label="Jitter"  value={`${t.jitter} ms`} />
              <StatRow
                label="Loss"
                value={`${t.loss}%`}
                valueStyle={{ color: lossColor(Number(t.loss)) }}
              />
            </div>
          )}
        </motion.div>
      ))}
    </div>
  );
}

function ColorPill({ color }) {
  const c = colorChip(color);
  return (
    <span className="color-pill" style={{ color: c, borderColor: c }}>
      {color}
    </span>
  );
}

function StatRow({ label, value, valueStyle }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={valueStyle}>{value}</span>
    </div>
  );
}
