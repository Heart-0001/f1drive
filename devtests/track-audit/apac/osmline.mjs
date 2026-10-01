// Map-matches the game centreline onto OpenStreetMap ways (cache/overpass/<id>-all.json) and returns the OSM
// centreline of the layout as an ordered closed polyline [lat, lon] in the racing direction of the game.
// Candidate ways: highway=raceway (permanent circuits) or motor roads + raceway (street circuits, opts.street).
// Each anchor (every opts.step m of the game lap) snaps to the nearest directed edge whose direction is within 50 deg of the
// game tangent; consecutive anchors are joined by the shortest directed path (Dijkstra) in the graph.
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { CACHE, track, toLL, metric, cumLen } from './common.mjs';

const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|raceway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|road)$/;

export function loadOSM(id) {
  return JSON.parse(readFileSync(resolve(CACHE, 'overpass', id + '-all.json'), 'utf8')).elements;
}

export function osmCentreline(id, opts = {}) {
  const t = track(id), els = loadOSM(id), step = opts.step || 40;
  const M = metric(t.geo.lat0, t.geo.lon0);
  const exclude = opts.exclude || (() => false);
  const ways = els.filter((e) => e.type === 'way' && e.geometry && e.tags && !exclude(e) &&
    (e.tags.highway === 'raceway' || (opts.street && ROADS.test(e.tags.highway || '') && !/^(footway|cycleway|path|steps)$/.test(e.tags.highway))));
  // graph
  const nodeId = new Map(), nodes = [], adj = [];
  const nid = (g) => {
    const k = g.lat.toFixed(7) + ',' + g.lon.toFixed(7);
    let v = nodeId.get(k);
    if (v === undefined) { v = nodes.length; nodeId.set(k, v); const [x, y] = M.xy(g.lat, g.lon); nodes.push({ x, y, lat: g.lat, lon: g.lon }); adj.push([]); }
    return v;
  };
  const edges = [];
  for (const w of ways) {
    const ow = w.tags.oneway === 'yes' || w.tags.oneway === '1' || w.tags.highway === 'motorway' || w.tags.junction === 'roundabout';
    const rev = w.tags.oneway === '-1';
    const ids = w.geometry.map(nid);
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = ids[i], b = ids[i + 1];
      if (a === b) continue;
      const add = (p, q) => { const e = { a: p, b: q, w, len: Math.hypot(nodes[q].x - nodes[p].x, nodes[q].y - nodes[p].y) }; edges.push(e); adj[p].push(e); };
      if (!rev) add(a, b);
      if (!ow || rev) add(b, a);
    }
  }
  // game samples (true metres)
  const P = t.points.map((p) => { const [lat, lon] = toLL(t, p[0], p[1]); return M.xy(lat, lon); });
  const cum = cumLen(P), L = cum[P.length], na = Math.round(L / step);
  const anchors = [];
  for (let k = 0, i = 0; k < na; k++) {
    const s = k * L / na;
    while (i < P.length - 1 && cum[i + 1] <= s) i++;
    const j = (i + 1) % P.length, f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    const x = P[i][0] + (P[j][0] - P[i][0]) * f, y = P[i][1] + (P[j][1] - P[i][1]) * f;
    const tl = Math.hypot(P[j][0] - P[i][0], P[j][1] - P[i][1]) || 1;
    anchors.push({ s, x, y, tx: (P[j][0] - P[i][0]) / tl, ty: (P[j][1] - P[i][1]) / tl });
  }
  // snap
  for (const an of anchors) {
    let best = null, bd = opts.maxSnap || 45;
    for (const e of edges) {
      const A = nodes[e.a], B = nodes[e.b], ex = B.x - A.x, ey = B.y - A.y, l2 = ex * ex + ey * ey;
      if (!l2) continue;
      const cos = (ex * an.tx + ey * an.ty) / Math.sqrt(l2);
      if (cos < 0.64) continue;
      const tt = Math.max(0, Math.min(1, ((an.x - A.x) * ex + (an.y - A.y) * ey) / l2));
      const d = Math.hypot(A.x + ex * tt - an.x, A.y + ey * tt - an.y);
      if (d < bd) { bd = d; best = { e, tt, d }; }
    }
    an.snap = best;
  }
  // Dijkstra between consecutive snapped anchors
  function path(s0, s1) {
    // from point on edge s0.e at tt to point on edge s1.e at tt
    if (s0.e === s1.e && s1.tt >= s0.tt) return [];
    const dist = new Map(), prev = new Map(), start = s0.e.b, goal = s1.e.a;
    dist.set(start, (1 - s0.tt) * s0.e.len);
    const open = [[dist.get(start), start]];
    while (open.length) {
      open.sort((p, q) => p[0] - q[0]);
      const [d, u] = open.shift();
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (u === goal) break;
      if (d > 2000) break;
      for (const e of adj[u]) {
        const nd = d + e.len;
        if (nd < (dist.get(e.b) ?? Infinity)) { dist.set(e.b, nd); prev.set(e.b, u); open.push([nd, e.b]); }
      }
    }
    if (!dist.has(goal)) return null;
    const seq = [goal];
    while (seq[0] !== start) seq.unshift(prev.get(seq[0]));
    return seq;
  }
  const line = [], wayAt = [], gaps = [];
  const pushPt = (x, y, w) => {
    const q = line[line.length - 1];
    if (q && Math.hypot(q[0] - x, q[1] - y) < 0.05) return;
    line.push([x, y]); wayAt.push(w);
  };
  for (let k = 0; k < anchors.length; k++) {
    const a0 = anchors[k], a1 = anchors[(k + 1) % anchors.length];
    if (!a0.snap) { gaps.push({ s: a0.s, why: 'no OSM way within snap distance' }); pushPt(a0.x, a0.y, null); continue; }
    const e0 = a0.snap.e, A = nodes[e0.a], B = nodes[e0.b];
    pushPt(A.x + (B.x - A.x) * a0.snap.tt, A.y + (B.y - A.y) * a0.snap.tt, e0.w);
    if (!a1.snap) continue;
    const seq = path(a0.snap, a1.snap);
    if (seq === null) { gaps.push({ s: a0.s, why: 'no directed path to the next anchor' }); continue; }
    for (const v of seq) pushPt(nodes[v].x, nodes[v].y, null);
  }
  // way per output point: nearest used edge (for naming)
  const llLine = line.map(([x, y]) => M.ll(x, y));
  return { line, llLine, wayAt, anchors, gaps, ways, M, gameXY: P, nodes, edges };
}

// lateral deviation game -> OSM line: per game sample every `step` m
export function deviation(gameXY, osmXY, step = 5) {
  const cum = cumLen(gameXY), L = cum[gameXY.length], m = Math.round(L / step), out = [];
  for (let k = 0, i = 0; k < m; k++) {
    const s = k * L / m;
    while (i < gameXY.length - 1 && cum[i + 1] <= s) i++;
    const j = (i + 1) % gameXY.length, f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    const x = gameXY[i][0] + (gameXY[j][0] - gameXY[i][0]) * f, y = gameXY[i][1] + (gameXY[j][1] - gameXY[i][1]) * f;
    let bd = Infinity;
    for (let u = 0; u < osmXY.length; u++) {
      const a = osmXY[u], b = osmXY[(u + 1) % osmXY.length], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
      const tt = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0;
      const d = Math.hypot(a[0] + ex * tt - x, a[1] + ey * tt - y);
      if (d < bd) bd = d;
    }
    out.push({ s, d: bd, x, y });
  }
  return out;
}
