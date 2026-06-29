import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useQuery } from '@tanstack/react-query';
import { getDashboard, getBFDSessions } from '../api';
import {
  BFD_LOSS_THRESHOLD,
  effectiveState,
  isHub,
  resolveRemoteName,
  stateBadge,
} from '../utils';

const STATE_COLOR = {
  up:         '#22c55e',
  down:       '#ef4444',
  partial:    '#f59e0b',
  'bfd-loss': '#f59e0b',
  unknown:    '#475569',
};

export default function Topology() {
  const svgRef   = useRef(null);
  const wrapRef  = useRef(null);
  const simRef   = useRef(null);
  const [hovered,  setHovered]  = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const { data: payload, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const raw  = await getDashboard();
      const rows = Array.isArray(raw.tloc_summary) ? raw.tloc_summary : [];
      await Promise.allSettled(
        rows.filter(r => !isHub(r) && r.system_ip).map(async row => {
          try { row.bfdSessions = await getBFDSessions(row.system_ip); }
          catch { row.bfdSessions = []; }
        })
      );
      return raw;
    },
    staleTime: 30_000,
  });

  const rows = payload?.tloc_summary || [];

  useEffect(() => {
    if (!rows.length || !svgRef.current || !wrapRef.current) return;

    const W = wrapRef.current.clientWidth  || 1000;
    const H = wrapRef.current.clientHeight || 680;

    const svg   = d3.select(svgRef.current).attr('width', W).attr('height', H);
    svg.selectAll('*').remove();

    // Background grid
    const defs = svg.append('defs');
    defs.append('pattern')
      .attr('id', 'topo-grid').attr('width', 40).attr('height', 40)
      .attr('patternUnits', 'userSpaceOnUse')
      .append('path').attr('d', 'M 40 0 L 0 0 0 40')
      .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.03)').attr('stroke-width', 1);
    svg.append('rect').attr('width', W).attr('height', H).attr('fill', 'url(#topo-grid)');

    const mainG = svg.append('g');

    const zoom = d3.zoom().scaleExtent([0.15, 5])
      .on('zoom', e => mainG.attr('transform', e.transform));
    svg.call(zoom).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2));

    const hubs  = rows.filter(isHub);
    const edges = rows.filter(r => !isHub(r));

    // Nodes — give each a starting position
    const nodes = [
      ...hubs.map((r, i) => {
        const angle = (i / Math.max(hubs.length, 1)) * 2 * Math.PI - Math.PI / 2;
        const hr    = hubs.length > 1 ? 70 : 0;
        return { ...r, _type: 'hub', _state: effectiveState(r), fx: Math.cos(angle) * hr, fy: Math.sin(angle) * hr };
      }),
      ...edges.map((r, i) => {
        const angle = (i / edges.length) * 2 * Math.PI - Math.PI / 2;
        const sp    = Math.min(W, H) * 0.32;
        return { ...r, _type: 'edge', _state: effectiveState(r), x: Math.cos(angle) * sp, y: Math.sin(angle) * sp };
      }),
    ];

    // Links — one per unique (edge → hub) pair, colored by worst BFD session
    const links = [];
    edges.forEach(edge => {
      const sessions = Array.isArray(edge.bfdSessions) ? edge.bfdSessions : [];
      const hubWorst = {};
      sessions.forEach(s => {
        const remote = resolveRemoteName(s['remote-system-ip']);
        const loss   = Number(s['loss-percentage'] || 0);
        if (hubWorst[remote] === undefined || loss > hubWorst[remote]) hubWorst[remote] = loss;
      });

      const edgeState = effectiveState(edge);
      const knownHubs = Object.keys(hubWorst);
      if (!knownHubs.length) {
        hubs.forEach(h => links.push({ source: edge.hostname, target: h.hostname, loss: 0, ok: true, edgeState }));
      } else {
        knownHubs.forEach(hub => {
          links.push({ source: edge.hostname, target: hub, loss: hubWorst[hub], ok: hubWorst[hub] <= BFD_LOSS_THRESHOLD, edgeState });
        });
      }
    });

    // Link color helper
    const linkStroke = (d, edgeState) => {
      if (!d.ok)                      return 'rgba(245,158,11,0.55)';
      if (edgeState === 'down')       return 'rgba(239,68,68,0.45)';
      if (edgeState === 'partial')    return 'rgba(245,158,11,0.35)';
      if (edgeState === 'bfd-loss')   return 'rgba(34,197,94,0.30)';
      return 'rgba(34,197,94,0.10)';
    };

    // Simulation
    if (simRef.current) simRef.current.stop();
    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.hostname).distance(130).strength(0.25))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('collide', d3.forceCollide(22))
      .force('x', d3.forceX(0).strength(0.03))
      .force('y', d3.forceY(0).strength(0.03))
      .alphaDecay(0.018);
    simRef.current = sim;

    // Draw links
    const linkEl = mainG.append('g').selectAll('line').data(links).join('line')
      .attr('stroke-width', d => {
        if (!d.ok)                      return 1.8;
        if (d.edgeState === 'bfd-loss') return 1.4;
        if (d.edgeState === 'down')     return 1.8;
        return 0.7;
      })
      .attr('stroke', d => linkStroke(d, d.edgeState));

    // Draw nodes
    const nodeEl = mainG.append('g').selectAll('g').data(nodes).join('g')
      .attr('cursor', d => d._type === 'edge' ? 'pointer' : 'grab')
      .on('mouseover', function(event, d) {
        if (d._type === 'edge') {
          setHovered(d);
          setMousePos({ x: event.clientX, y: event.clientY });
        }
      })
      .on('mousemove', function(event) { setMousePos({ x: event.clientX, y: event.clientY }); })
      .on('mouseout',  function()      { setHovered(null); })
      .call(
        d3.drag()
          .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
          .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); if (d._type !== 'hub') { d.fx = null; d.fy = null; } })
      );

    // Hub nodes — hexagon-ish using polygon
    nodeEl.filter(d => d._type === 'hub').each(function(d) {
      const g = d3.select(this);
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (i * Math.PI) / 3 - Math.PI / 6;
        return [Math.cos(a) * 26, Math.sin(a) * 26].join(',');
      }).join(' ');
      g.append('polygon')
        .attr('points', pts)
        .attr('fill', 'rgba(59,130,246,0.10)')
        .attr('stroke', '#3b82f6')
        .attr('stroke-width', 1.5);
      g.append('text')
        .attr('text-anchor', 'middle').attr('dy', '0.35em')
        .attr('font-size', '9').attr('font-family', 'IBM Plex Mono')
        .attr('font-weight', '700').attr('fill', '#93c5fd')
        .text(d.hostname);
    });

    // Edge nodes
    nodeEl.filter(d => d._type === 'edge').each(function(d) {
      const g      = d3.select(this);
      const color  = STATE_COLOR[d._state] || '#475569';
      const radius = d._state !== 'up' ? 8 : 5;

      g.append('circle')
        .attr('r', radius)
        .attr('fill', `${color}28`)
        .attr('stroke', color)
        .attr('stroke-width', d._state !== 'up' ? 1.8 : 1);

      // Only label problem sites to avoid clutter
      if (d._state !== 'up') {
        g.append('text')
          .attr('text-anchor', 'middle').attr('dy', '-13')
          .attr('font-size', '8').attr('font-family', 'IBM Plex Mono')
          .attr('font-weight', '700').attr('fill', color)
          .attr('pointer-events', 'none')
          .text(d.hostname);
      }
    });

    // Tick
    sim.on('tick', () => {
      linkEl
        .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      nodeEl.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => { if (simRef.current) simRef.current.stop(); };
  }, [rows]);

  // Legend data
  const legend = [
    { color: STATE_COLOR.up,         label: 'UP' },
    { color: STATE_COLOR.down,       label: 'DOWN' },
    { color: STATE_COLOR['bfd-loss'],label: 'BFD LOSS / PARTIAL' },
    { color: '#3b82f6',              label: 'HUB' },
  ];

  return (
    <div ref={wrapRef} className="topology-wrap">
      {isLoading && <div className="topo-loading">Building topology...</div>}

      <svg ref={svgRef} className="topology-svg" />

      <div className="topo-legend">
        {legend.map(l => (
          <div key={l.label} className="topo-legend-item">
            <span className="topo-legend-dot" style={{ background: l.color }} />
            <span className="topo-legend-label">{l.label}</span>
          </div>
        ))}
      </div>

      <div className="topo-hint">Scroll to zoom / Drag to pan / Drag nodes to rearrange</div>

      {hovered && (
        <TopoTooltip site={hovered} x={mousePos.x} y={mousePos.y} />
      )}
    </div>
  );
}

function TopoTooltip({ site, x, y }) {
  const state = site._state;
  const color = STATE_COLOR[state] || '#94a3b8';
  const up    = Array.isArray(site.up)   ? site.up   : [];
  const down  = Array.isArray(site.down) ? site.down : [];
  const ignored = Array.isArray(site.ignoredForOverall) ? site.ignoredForOverall : [];
  const visDown = down.filter(c => !ignored.includes(c));

  const sessions = Array.isArray(site.bfdSessions) ? site.bfdSessions : [];
  const lossySessions = sessions.filter(s => Number(s['loss-percentage'] || 0) > BFD_LOSS_THRESHOLD);

  let left = x + 16, top = y + 16;

  return (
    <div className="topo-tooltip" style={{ left, top }}>
      <div className="topo-tt-header">
        <span className="topo-tt-hostname">{site.hostname}</span>
        <span className="topo-tt-badge" style={{ color, borderColor: color }}>
          {stateBadge(state)}
        </span>
      </div>

      {up.length > 0 && (
        <div className="topo-tt-row">
          <span className="topo-tt-lbl">UP</span>
          <div className="topo-tt-chips">
            {up.map(c => <span key={c} className="topo-chip topo-chip--up">{c}</span>)}
          </div>
        </div>
      )}

      {visDown.length > 0 && (
        <div className="topo-tt-row">
          <span className="topo-tt-lbl">DOWN</span>
          <div className="topo-tt-chips">
            {visDown.map(c => <span key={c} className="topo-chip topo-chip--down">{c}</span>)}
          </div>
        </div>
      )}

      {lossySessions.length > 0 && (
        <div className="topo-tt-loss">
          {lossySessions.map((s, i) => (
            <div key={i} className="topo-tt-loss-row">
              <span style={{ opacity: 0.7 }}>{s.color}</span>
              <svg width="12" height="8" viewBox="0 0 12 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{opacity:0.5,flexShrink:0}}><line x1="0" y1="4" x2="9" y2="4"/><polyline points="6,1 9,4 6,7"/></svg>
              <span>{resolveRemoteName(s['remote-system-ip'])}</span>
              <span style={{ color: '#fae114' }}>{Number(s['loss-percentage']).toFixed(1)}% loss</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
