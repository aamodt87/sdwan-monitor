export const BFD_LOSS_THRESHOLD = 2;

export function isController(row) {
  const p = String(row?.personality || '').toLowerCase();
  return p === 'vsmart' || p === 'vbond' || p === 'vmanage';
}

// Hub routers must have hostnames starting with "HUB-" (e.g. HUB-OSLO, HUB-LON)
export function isHub(row) {
  if (isController(row)) return false;
  return String(row?.hostname || '').toUpperCase().startsWith('HUB-');
}

export function hasDegradedInternet(row) {
  const s = row?.tlocStats || {};
  return ['biz-internet', 'public-internet'].some(c => {
    const t = s[c];
    return t && !t.ignored && t.expected && t.status === 'degraded';
  });
}

export function hasBfdSessionDown(row) {
  if (!Array.isArray(row?.bfdSessions)) return false;
  return row.bfdSessions.some(s => (s.state || '').toLowerCase() === 'down');
}

export function hasBfdLoss(row) {
  if (!Array.isArray(row?.bfdSessions)) return false;
  return row.bfdSessions.some(s => Number(s['loss-percentage'] || 0) > BFD_LOSS_THRESHOLD);
}

export function effectiveState(row) {
  if (row.overall === 'up' && hasDegradedInternet(row)) return 'partial';
  if (row.overall === 'up' && hasBfdSessionDown(row)) return 'partial';
  if (row.overall === 'up' && hasBfdLoss(row)) return 'bfd-loss';
  return row.overall || 'unknown';
}

export function internetDegradeNote(row) {
  const s = row?.tlocStats || {};
  return ['biz-internet', 'public-internet']
    .filter(c => {
      const t = s[c];
      return t && !t.ignored && t.expected && t.status === 'degraded';
    })
    .map(c => {
      const t = s[c];
      return `${c} ${t.up}/${t.expected} UP (${t.missing} down)`;
    })
    .join('  |  ');
}

export function lossColor(v) {
  const n = Number(v);
  if (n > 10) return '#ff2828';
  if (n > 5)  return '#ff8d8d';
  if (n > 2)  return '#fae114';
  return '#e2e8f0';
}

export function colorChip(transport) {
  const map = {
    'mpls':            '#facc15',
    'biz-internet':    '#7dd3fc',
    'public-internet': '#fb923c',
    'private1':        '#facc15',
  };
  return map[transport] || '#94a3b8';
}

export function stateVariant(state) {
  if (state === 'up')                       return 'green';
  if (state === 'down')                     return 'red';
  if (state === 'partial' || state === 'bfd-loss') return 'yellow';
  return 'gray';
}

export function stateBadge(state) {
  const labels = {
    up: 'UP',
    down: 'DOWN',
    partial: 'PARTIAL',
    'bfd-loss': 'BFD LOSS',
  };
  return labels[state] || 'UNKNOWN';
}

export function formatBytes(bytes) {
  const b = Number(bytes || 0);
  if (!b) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

export function normalizeText(v) {
  return String(v || '').trim().toLowerCase();
}

export function resolveRemoteName(ip) {
  return ip || '?';
}

export function capBarColor(pct) {
  if (pct > 80) return '#ef4444';
  if (pct > 50) return '#f59e0b';
  if (pct > 20) return '#3b82f6';
  return '#22c55e';
}
