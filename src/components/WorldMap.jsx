import { useEffect, useRef, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { feature } from 'topojson-client';
import worldTopo from 'world-atlas/countries-110m.json';
import { useQuery } from '@tanstack/react-query';
import { getDashboard } from '../api';
import { effectiveState, isHub, stateBadge, stateVariant } from '../utils';

const STATE_COLOR = {
  up:         '#22c55e',
  down:       '#ef4444',
  partial:    '#f59e0b',
  'bfd-loss': '#f59e0b',
  unknown:    '#475569',
};

const worldCountries = feature(worldTopo, worldTopo.objects.countries);
const worldLand      = feature(worldTopo, worldTopo.objects.land);

export default function WorldMap() {
  const svgRef  = useRef(null);
  const wrapRef = useRef(null);
  const [hovered,  setHovered]  = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [dims,     setDims]     = useState({ w: 0, h: 0 });

  const { data: payload, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const { getDashboard } = await import('../api');
      return getDashboard();
    },
    staleTime: 30_000,
  });

  const sites = useMemo(() => {
    const rows = payload?.tloc_summary || [];
    return rows
      .filter(r => r.lat != null && r.lng != null)
      .map(r => ({ ...r, _state: effectiveState(r) }));
  }, [payload]);

  const noCoords = useMemo(() => {
    const rows = payload?.tloc_summary || [];
    return rows.filter(r => r.lat == null || r.lng == null).length;
  }, [payload]);

  // Resize observer
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDims({ w: width, h: height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!dims.w || !dims.h || !svgRef.current) return;

    const { w, h } = dims;
    const svg = d3.select(svgRef.current).attr('width', w).attr('height', h);
    svg.selectAll('*').remove();

    const projection = d3.geoNaturalEarth1()
      .scale((w / 640) * 100)
      .translate([w / 2, h / 2]);

    const path = d3.geoPath().projection(projection);

    const defs = svg.append('defs');

    // Subtle grid/graticule
    defs.append('path')
      .datum(d3.geoGraticule()())
      .attr('id', 'graticule-path');

    // Sphere background
    svg.append('path')
      .datum({ type: 'Sphere' })
      .attr('d', path)
      .attr('fill', 'rgba(14,26,48,0.9)')
      .attr('stroke', 'rgba(255,255,255,0.04)')
      .attr('stroke-width', 0.5);

    // Graticule lines
    svg.append('use')
      .attr('href', '#graticule-path')
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,0.04)')
      .attr('stroke-width', 0.4);

    // Land fill
    svg.append('path')
      .datum(worldLand)
      .attr('d', path)
      .attr('fill', 'rgba(30,48,80,0.85)')
      .attr('stroke', 'none');

    // Country borders
    svg.append('path')
      .datum(worldCountries)
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,0.08)')
      .attr('stroke-width', 0.4);

    // Zoom + pan
    const zoomG = svg.append('g');
    const zoom = d3.zoom()
      .scaleExtent([0.8, 12])
      .on('zoom', e => zoomG.attr('transform', e.transform));
    svg.call(zoom);

    // Re-draw land + borders inside zoomG so they zoom too
    zoomG.append('path')
      .datum(worldLand)
      .attr('d', path)
      .attr('fill', 'rgba(30,48,80,0.85)')
      .attr('stroke', 'none');
    zoomG.append('path')
      .datum(worldCountries)
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', 'rgba(255,255,255,0.09)')
      .attr('stroke-width', 0.4);

    // Hub sites — larger hexagon markers
    const hubSites  = sites.filter(s => isHub(s));
    const edgeSites = sites.filter(s => !isHub(s));

    // Edge sites
    zoomG.selectAll('.site-dot')
      .data(edgeSites)
      .join('circle')
      .attr('class', 'site-dot')
      .attr('cx', d => {
        const p = projection([d.lng, d.lat]);
        return p ? p[0] : -9999;
      })
      .attr('cy', d => {
        const p = projection([d.lng, d.lat]);
        return p ? p[1] : -9999;
      })
      .attr('r', d => d._state !== 'up' ? 5 : 3.5)
      .attr('fill', d => `${STATE_COLOR[d._state] || STATE_COLOR.unknown}cc`)
      .attr('stroke', d => STATE_COLOR[d._state] || STATE_COLOR.unknown)
      .attr('stroke-width', d => d._state !== 'up' ? 1.5 : 0.8)
      .attr('cursor', 'pointer')
      .on('mouseover', (event, d) => {
        setHovered(d);
        setMousePos({ x: event.clientX, y: event.clientY });
      })
      .on('mousemove', event => setMousePos({ x: event.clientX, y: event.clientY }))
      .on('mouseout', () => setHovered(null));

    // Pulse rings for down/partial sites
    zoomG.selectAll('.site-pulse')
      .data(edgeSites.filter(s => s._state === 'down' || s._state === 'partial'))
      .join('circle')
      .attr('class', 'site-pulse')
      .attr('cx', d => { const p = projection([d.lng, d.lat]); return p ? p[0] : -9999; })
      .attr('cy', d => { const p = projection([d.lng, d.lat]); return p ? p[1] : -9999; })
      .attr('r', 5)
      .attr('fill', 'none')
      .attr('stroke', d => STATE_COLOR[d._state])
      .attr('stroke-width', 1)
      .attr('opacity', 0.6)
      .style('animation', (_, i) => `map-pulse 2s ease-out ${(i % 5) * 0.4}s infinite`);

    // Hub markers — hexagonal
    const hexPts = (cx, cy, r) =>
      Array.from({ length: 6 }, (_, i) => {
        const a = (i * Math.PI) / 3 - Math.PI / 6;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r].join(',');
      }).join(' ');

    hubSites.forEach(d => {
      const p = projection([d.lng, d.lat]);
      if (!p) return;
      const [cx, cy] = p;
      zoomG.append('polygon')
        .datum(d)
        .attr('points', hexPts(cx, cy, 8))
        .attr('fill', 'rgba(59,130,246,0.20)')
        .attr('stroke', '#3b82f6')
        .attr('stroke-width', 1.5)
        .attr('cursor', 'pointer')
        .on('mouseover', (event, d) => {
          setHovered(d);
          setMousePos({ x: event.clientX, y: event.clientY });
        })
        .on('mousemove', event => setMousePos({ x: event.clientX, y: event.clientY }))
        .on('mouseout', () => setHovered(null));

      zoomG.append('text')
        .attr('x', cx)
        .attr('y', cy + 18)
        .attr('text-anchor', 'middle')
        .attr('font-size', 7)
        .attr('font-family', 'IBM Plex Mono')
        .attr('font-weight', 700)
        .attr('fill', '#93c5fd')
        .attr('pointer-events', 'none')
        .text(d.hostname);
    });

    // Labels for problem sites only (avoid clutter)
    zoomG.selectAll('.site-label')
      .data(edgeSites.filter(s => s._state !== 'up' && s._state !== 'bfd-loss'))
      .join('text')
      .attr('class', 'site-label')
      .attr('x', d => { const p = projection([d.lng, d.lat]); return p ? p[0] + 7 : -9999; })
      .attr('y', d => { const p = projection([d.lng, d.lat]); return p ? p[1] + 3 : -9999; })
      .attr('font-size', 7)
      .attr('font-family', 'IBM Plex Mono')
      .attr('font-weight', 700)
      .attr('fill', d => STATE_COLOR[d._state])
      .attr('pointer-events', 'none')
      .text(d => d.hostname);

  }, [dims, sites]);

  // Stats
  const counts = useMemo(() => {
    const total   = sites.length;
    const up      = sites.filter(s => s._state === 'up').length;
    const down    = sites.filter(s => s._state === 'down').length;
    const partial = sites.filter(s => s._state === 'partial' || s._state === 'bfd-loss').length;
    return { total, up, down, partial };
  }, [sites]);

  return (
    <div ref={wrapRef} className="worldmap-wrap" onMouseMove={e => setMousePos({ x: e.clientX, y: e.clientY })}>
      {isLoading && <div className="topo-loading">Loading map...</div>}

      <svg ref={svgRef} className="worldmap-svg" />

      <div className="worldmap-legend">
        {[
          { color: STATE_COLOR.up,      label: `UP (${counts.up})` },
          { color: STATE_COLOR.partial, label: `DEGRADED (${counts.partial})` },
          { color: STATE_COLOR.down,    label: `DOWN (${counts.down})` },
          { color: '#3b82f6',           label: 'HUB' },
        ].map(l => (
          <div key={l.label} className="topo-legend-item">
            <span className="topo-legend-dot" style={{ background: l.color }} />
            <span className="topo-legend-label">{l.label}</span>
          </div>
        ))}
        {noCoords > 0 && (
          <div className="worldmap-no-coords">{noCoords} sites missing coordinates</div>
        )}
      </div>

      <div className="topo-hint">Scroll to zoom / Drag to pan</div>

      {hovered && <MapTooltip site={hovered} x={mousePos.x} y={mousePos.y} />}
    </div>
  );
}

function MapTooltip({ site, x, y }) {
  const state  = site._state;
  const color  = STATE_COLOR[state] || '#94a3b8';
  const up     = Array.isArray(site.up)   ? site.up   : [];
  const down   = Array.isArray(site.down) ? site.down : [];
  const ignored = Array.isArray(site.ignoredForOverall) ? site.ignoredForOverall : [];
  const visDown = down.filter(c => !ignored.includes(c));

  const pad = 12;
  const w   = 200;
  let left  = x + 16;
  let top   = y + 16;
  if (left + w > window.innerWidth - pad) left = x - w - 12;
  if (top + 160 > window.innerHeight - pad) top = y - 160;

  return (
    <div className="topo-tooltip" style={{ left, top, minWidth: w }}>
      <div className="topo-tt-header">
        <span className="topo-tt-hostname">{site.hostname}</span>
        <span className="topo-tt-badge" style={{ color, borderColor: color }}>
          {stateBadge(state)}
        </span>
      </div>

      {site.lat != null && (
        <div className="worldmap-coords">
          {Number(site.lat).toFixed(4)}, {Number(site.lng).toFixed(4)}
        </div>
      )}

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
    </div>
  );
}
