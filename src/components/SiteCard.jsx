import { useCallback, useMemo } from 'react';
import {
  BFD_LOSS_THRESHOLD,
  colorChip,
  effectiveState,
  hasDegradedInternet,
  internetDegradeNote,
  lossColor,
  resolveRemoteName,
  stateBadge,
  stateVariant,
} from '../utils';

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

export default function SiteCard({ row, dimmed, flashing, onHover, onHoverEnd }) {
  const state   = effectiveState(row);
  const variant = stateVariant(state);
  const badge   = stateBadge(state);

  const up      = Array.isArray(row.up) ? row.up : [];
  const down    = Array.isArray(row.down) ? row.down : [];
  const ignored = Array.isArray(row.ignoredForOverall) ? row.ignoredForOverall : [];
  const visDown = down.filter(c => !ignored.includes(c));

  const degradeNote = hasDegradedInternet(row) ? internetDegradeNote(row) : '';

  const lossGroups = useMemo(() => {
    if (!Array.isArray(row.bfdSessions)) return [];
    const relevant = row.bfdSessions.filter(s =>
      (s.state || '').toLowerCase() === 'down' ||
      Number(s['loss-percentage'] || 0) > BFD_LOSS_THRESHOLD
    );
    if (!relevant.length) return [];
    const grouped = {};
    relevant.forEach(s => {
      const tunnel = s.color || 'unknown';
      (grouped[tunnel] ||= []).push(s);
    });
    return Object.entries(grouped).map(([tunnel, sessions]) => ({
      tunnel,
      sessions: sessions.map(s => {
        const sessionDown = (s.state || '').toLowerCase() === 'down';
        const pct      = Number(s['loss-percentage'] || 0).toFixed(1);
        const clr      = sessionDown ? '#ef4444' : lossColor(Number(pct));
        const barColor = sessionDown ? '#ef4444' : colorChip(tunnel);
        const from     = s.hostname || row.hostname || '?';
        const to       = resolveRemoteName(s['remote-system-ip']);
        return { from, to, pct, color: clr, barColor, sessionDown };
      }),
    }));
  }, [row.bfdSessions, row.hostname]);

  const rawDesc  = (row.policyDescription || '').trim();
  const showDesc = rawDesc && rawDesc.toLowerCase() !== 'standard policy';

  const handleEnter = useCallback((e) => {
    onHover?.(row, e.clientX, e.clientY);
  }, [row, onHover]);

  const handleLeave = useCallback(() => {
    onHoverEnd?.();
  }, [onHoverEnd]);

  return (
    <div
      className={`card card--${variant}${dimmed ? ' card--dimmed' : ''}${flashing ? ' card--flash' : ''}`}
      data-hostname={row.hostname}
      data-system-ip={row.system_ip}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="card-header">
        <div className="card-status-dot" />
        <span className="card-hostname">{row.hostname || 'UNKNOWN'}</span>
        <span className={`card-badge card-badge--${variant}`}>{badge}</span>
      </div>

      {showDesc && (
        <div className="card-policy" title={rawDesc}>{rawDesc}</div>
      )}

      {degradeNote && (
        <div className="card-hint card-hint--warn">{degradeNote}</div>
      )}

      {lossGroups.map((group, i) => (
        <div key={i} className="card-loss-group">
          <div className="card-loss-tunnel">{group.tunnel}</div>
          {group.sessions.map((s, j) => (
            <div key={j} className="card-hint card-hint--loss" style={{ color: s.color }}>
              <span>{s.from}</span>
              <SignalBars color={s.barColor} />
              <span>{s.to}</span>
              <span style={{ marginLeft: 4 }}>{s.sessionDown ? 'DOWN' : `loss ${s.pct}%`}</span>
            </div>
          ))}
        </div>
      ))}

      {up.length > 0 && (
        <div className="chips">
          {up.map(c => <span key={c} className="chip chip--up">{c}</span>)}
        </div>
      )}

      {visDown.length > 0 && (
        <div className="chips">
          {visDown.map(c => <span key={c} className="chip chip--down">{c}</span>)}
        </div>
      )}
    </div>
  );
}
