import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTip,
  XAxis,
  YAxis,
} from 'recharts';
import { getCapacity } from '../api';
import { capBarColor } from '../utils';

const SORT_OPTIONS = [
  { key: 'max_up',   field: 'max_up_capacity_percentage',   label: 'Max UP' },
  { key: 'max_down', field: 'max_down_capacity_percentage', label: 'Max DOWN' },
  { key: 'avg_up',   field: 'avg_up_capacity_percentage',   label: 'Avg UP' },
  { key: 'avg_down', field: 'avg_down_capacity_percentage', label: 'Avg DOWN' },
];

const HISTOGRAM_BUCKETS = [
  { label: '0-20%',   min: 0,  max: 20,  color: '#22c55e' },
  { label: '20-50%',  min: 20, max: 50,  color: '#3b82f6' },
  { label: '50-80%',  min: 50, max: 80,  color: '#f59e0b' },
  { label: '80-100%', min: 80, max: 101, color: '#ef4444' },
];

export default function Capacity({ ipToHostname }) {
  const [sortKey, setSortKey] = useState('max_down');

  const { data: raw = [], isLoading, isError, error } = useQuery({
    queryKey: ['capacity'],
    queryFn: getCapacity,
    refetchInterval: 120_000,
  });

  const sortOpt  = SORT_OPTIONS.find(o => o.key === sortKey);
  const sortField = sortOpt?.field || 'max_down_capacity_percentage';

  const sorted = useMemo(
    () => [...raw].sort((a, b) => parseFloat(b[sortField] || 0) - parseFloat(a[sortField] || 0)),
    [raw, sortField]
  );

  const histogram = useMemo(() => {
    const buckets = HISTOGRAM_BUCKETS.map(b => ({ ...b, count: 0 }));
    raw.forEach(row => {
      const v = parseFloat(row[sortField] || 0);
      const bucket = buckets.find(b => v >= b.min && v < b.max);
      if (bucket) bucket.count++;
    });
    return buckets;
  }, [raw, sortField]);

  return (
    <div className="capacity-view">
      <div className="toolbar">
        <div className="toolbar-meta">
          <span className="meta-stat">
            <span className="meta-num">{raw.length}</span> interfaces
          </span>
        </div>
        <div className="seg-control">
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.key}
              className={`seg-btn${sortKey === opt.key ? ' active' : ''}`}
              onClick={() => setSortKey(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <div className="loader">Loading capacity data...</div>}
      {isError   && <div className="error-banner">Failed to load: {error?.message}</div>}

      {!isLoading && !isError && (
        <>
          <div className="cap-summary">
            <div className="cap-summary-label">
              {sortOpt?.label} utilisation - distribution across {raw.length} interfaces
            </div>
            <ResponsiveContainer width="100%" height={72}>
              <BarChart data={histogram} barCategoryGap="24%" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#64748b', fontSize: 11, fontFamily: 'IBM Plex Mono' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <RechartsTip
                  cursor={false}
                  contentStyle={{
                    background: '#0d1929',
                    border: '1px solid #1e3050',
                    borderRadius: 8,
                    fontSize: 12,
                    fontFamily: 'IBM Plex Sans',
                    color: '#e2e8f0',
                  }}
                  formatter={(v) => [`${v} interfaces`, '']}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {histogram.map((b, i) => (
                    <Cell key={i} fill={b.color} fillOpacity={0.75} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="cap-table-wrap">
            <table className="cap-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Interface</th>
                  {SORT_OPTIONS.map(o => (
                    <th
                      key={o.key}
                      className={`cap-th-bar${sortKey === o.key ? ' sorted' : ''}`}
                      onClick={() => setSortKey(o.key)}
                    >
                      {o.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 500).map((row, i) => {
                  const hostname = ipToHostname[row.vdevice_name] || row.vdevice_name || '-';
                  return (
                    <CapRow
                      key={`${row.vdevice_name}-${row.interface}-${i}`}
                      row={row}
                      hostname={hostname}
                      sortKey={sortKey}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function CapRow({ row, hostname, sortKey }) {
  const vals = {
    max_up:   parseFloat(row.max_up_capacity_percentage   || 0),
    max_down: parseFloat(row.max_down_capacity_percentage || 0),
    avg_up:   parseFloat(row.avg_up_capacity_percentage   || 0),
    avg_down: parseFloat(row.avg_down_capacity_percentage || 0),
  };

  return (
    <tr>
      <td className="cap-td-hostname">
        <div className="cap-device-name">{hostname}</div>
        <div className="cap-device-ip">{row.vdevice_name}</div>
      </td>
      <td className="cap-td-iface">{row.interface || '-'}</td>
      {SORT_OPTIONS.map(o => (
        <td key={o.key} className={`cap-td-bar${sortKey === o.key ? ' sorted' : ''}`}>
          <CapBar pct={vals[o.key]} />
        </td>
      ))}
    </tr>
  );
}

function CapBar({ pct }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const color   = capBarColor(clamped);
  return (
    <div className="bar-wrap">
      <div className="bar-track">
        <div
          className="bar-fill"
          style={{ width: `${clamped}%`, background: color }}
        />
      </div>
      <span className="bar-val" style={{ color }}>{clamped.toFixed(1)}%</span>
    </div>
  );
}
