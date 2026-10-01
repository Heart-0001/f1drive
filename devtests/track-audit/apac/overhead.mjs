// node devtests/track-audit/apac/overhead.mjs [id] -- structures the car drives UNDER or OVER: OSM ways tagged bridge / layer>=1 /
// min_height / covered that cross the game centreline (segment intersections, or polygons containing it), whether the
// racing road itself is a bridge / tunnel there, and whether scenery-data.js has a bridge deck covering the spot.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { IDS, ROOT, HERE, track, toXZ, project, writeJSON, readJSON } from './common.mjs';
import { loadOSM } from './osmline.mjs';
const sc = { window: {} };
vm.runInNewContext(readFileSync(resolve(ROOT, 'scenery-data.js'), 'utf8'), sc);
function segX(a, b, c, d) { // intersection param of segments ab, cd
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + r[0] * t, a[1] + r[1] * t] : null;
}
const inPoly = (x, z, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > z) !== (p[j][1] > z) && x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) c = !c; return c; };
for (const id of process.argv[2] ? [process.argv[2]] : IDS) {
  const t = track(id), P = t.points, els = loadOSM(id), out = [];
  const bridges = (sc.window.F1_SCENERY[id] || { buildings: [] }).buildings.filter((b) => b.k === 'bridge');
  for (const e of els) {
    if (e.type !== 'way' || !e.geometry || !e.tags) continue;
    const tg = e.tags, layer = +(tg.layer || 0);
    const over = tg.bridge && tg.bridge !== 'no' || layer >= 1 || tg.min_height || tg['building:min_level'] || tg.man_made === 'bridge' || tg.building === 'bridge' || tg.building === 'roof';
    const under = tg.tunnel && tg.tunnel !== 'no' || layer < 0 || tg.covered === 'yes';
    if (!over && !under) continue;
    if (/^(footway|path|steps|cycleway|corridor)$/.test(tg.highway || '') && !tg.bridge) continue;
    if (tg.railway === 'subway' || tg.waterway || tg.tunnel === 'culvert') continue;
    const G = e.geometry.map((q) => toXZ(t, q.lat, q.lon));
    const closed = G.length > 3 && Math.hypot(G[0][0] - G[G.length - 1][0], G[0][1] - G[G.length - 1][1]) < 0.5;
    const hits = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      for (let k = 0; k + 1 < G.length; k++) { const x = segX(a, b, G[k], G[k + 1]); if (x) hits.push(project(P, x[0], x[1]).s); }
      if (closed && inPoly(a[0], a[1], G)) hits.push(project(P, a[0], a[1]).s);
    }
    // the racing road itself (raceway / road whose geometry runs along the centreline within 4 m for > 20 m)
    let along = 0;
    for (const g of G) if (project(P, g[0], g[1]).dist < 4) along++;
    if (!hits.length && along < 2) continue;
    const s0 = Math.min(...hits), s1 = Math.max(...hits);
    const covered = bridges.some((b) => hits.some((s) => { /* any game vertex near s inside the deck */ return false; }));
    out.push({ way: e.id, tags: Object.fromEntries(Object.entries(tg).filter(([k]) => /^(name|bridge|bridge:name|tunnel|layer|highway|railway|man_made|building|building:part|min_height|height|covered|level|maxheight)$/.test(k))),
      kind: along >= 2 ? (under ? 'racing road in tunnel / covered / below grade' : 'racing road on bridge / elevated') : (over ? 'structure crosses OVER the track' : 'passes UNDER the track'),
      atGameS: hits.length ? [Math.round(s0), Math.round(s1)] : null, hitsS: [...new Set(hits.map((s) => Math.round(s)))].sort((a, b) => a - b), nodesOnCentreline: along });
  }
  // scenery bridge decks the centreline passes through
  const decks = bridges.map((b, i) => { const s = []; for (let k = 0; k < P.length; k++) if (inPoly(P[k][0], P[k][1], b.p)) s.push(project(P, P[k][0], P[k][1]).s); return { deck: i, h: b.h, overTrackAtS: s.length ? [Math.round(Math.min(...s)), Math.round(Math.max(...s))] : null }; });
  writeJSON(resolve(HERE, 'out', 'overhead-' + id + '.json'), { id, crossings: out, sceneryBridgeDecks: decks }, true);
  console.log('=== ' + id);
  for (const o of out) console.log(o.kind.padEnd(40), 'way', o.way, 's', JSON.stringify(o.hitsS), JSON.stringify(o.tags).slice(0, 170));
  console.log('scenery bridge decks:', JSON.stringify(decks));
}
