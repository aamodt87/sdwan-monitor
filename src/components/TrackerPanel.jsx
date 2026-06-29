export default function TrackerPanel({ tracker }) {
  const sorted = [...tracker].sort((a, b) =>
    String(a.Host_name).localeCompare(String(b.Host_name))
  );

  return (
    <aside className="tracker-panel">
      <div className="tracker-header">
        <span className="tracker-title">Tracker DOWN</span>
        <span className="tracker-count">{tracker.length}</span>
      </div>
      <div className="tracker-cards">
        {sorted.map((item, i) => (
          <TrackerCard key={item.Host_name || i} item={item} />
        ))}
      </div>
    </aside>
  );
}

function TrackerCard({ item }) {
  const host = item.Host_name || 'Unknown';
  const iface = item.Interface || 'Unknown';
  const eps = String(item.Endpoints || '')
    .split(/\s*,\s*/)
    .filter(Boolean);

  return (
    <div className="card card--red card--compact">
      <div className="card-header">
        <div className="card-status-dot" />
        <span className="card-hostname">{host}</span>
        <span className="card-badge card-badge--red">DOWN</span>
      </div>
      <div className="card-label">Interface</div>
      <div className="chips">
        <span className="chip chip--iface">{iface}</span>
      </div>
      <div className="card-label">Endpoints</div>
      <div className="chips">
        {eps.length
          ? eps.map(ep => <span key={ep} className="chip chip--endpoint">{ep}</span>)
          : <span className="chip chip--empty">None</span>}
      </div>
    </div>
  );
}
