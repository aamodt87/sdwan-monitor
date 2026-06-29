import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export default function TopBar({ view, onNavigate }) {
  const [time, setTime] = useState(() => new Date());
  const qc = useQueryClient();

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = () => {
    if (view === 'dashboard' || view === 'topology') qc.invalidateQueries({ queryKey: ['dashboard'] });
    if (view === 'capacity')  qc.invalidateQueries({ queryKey: ['capacity'] });
  };

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="brand-hexagon">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <path
              d="M14 2L24.4 8v12L14 26 3.6 20V8L14 2z"
              stroke="#3b82f6" strokeWidth="1.5"
              fill="rgba(59,130,246,0.12)"
            />
            <circle cx="14" cy="14" r="3" fill="#60a5fa" />
          </svg>
        </div>
        <span className="brand-name">SD-WAN Monitor</span>
        <span className="live-pulse" />
      </div>

      <nav className="topbar-nav">
        {[
          { key: 'dashboard', label: 'Dashboard' },
          { key: 'topology',  label: 'Topology'  },
          { key: 'capacity',  label: 'Capacity'  },
        ].map(({ key, label }) => (
          <button
            key={key}
            className={`nav-btn ${view === key ? 'active' : ''}`}
            onClick={() => onNavigate(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <button className="icon-btn" onClick={refresh} title="Refresh now">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
        <div className="clock">
          <span className="clock-time">
            {time.toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
        </div>
      </div>
    </header>
  );
}
