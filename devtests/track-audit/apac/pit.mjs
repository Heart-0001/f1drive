// node devtests/track-audit/apac/pit.mjs -- the real pit lane from OSM (way ids per circuit), as offsets along the game lap from the
// game's start line (negative = before the line), its side (driver's left / right of the racing direction), the entry / exit points
// (where the lane leaves / rejoins the track: first / last node within 12 m of the centreline), vs the game's track.pit.
import { resolve, } from 'node:path';
import { readFileSync } from 'node:fs';
import { IDS, HERE, CACHE, track, toXZ, project, readJSON, writeJSON } from './common.mjs';
import { loadOSM } from './osmline.mjs';
const PIT_WAYS = { 'jp-1962': [120917578], 'sg-2008': [100484287], 'my-1999': [144359483, 23410526], 'cn-2004': [107371147, 107371138], 'au-1953': [28119448] };
const out = {};
for (const id of IDS) {
  const t = track(id), L = t.lengthKm * 1000, els = loadOSM(id);
  let ways = PIT_WAYS[id];
  let geo;
  if (id === 'au-1953') {
    const xml = readFileSync(resolve(CACHE, 'osmapi', 'way-28119448.xml'), 'utf8');
    const nodes = new Map([...xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"/g)].map((m) => [m[1], { lat: +m[2], lon: +m[3] }]));
    geo = [[...xml.matchAll(/<nd ref="(\d+)"\/>/g)].map((m) => nodes.get(m[1]))];
  } else {
    if (ways === 'auto') // Shanghai: unnamed raceway ways mostly 8-40 m beside the main straight
      ways = els.filter((e) => e.type === 'way' && e.tags && e.tags.highway === 'raceway' && e.id !== 156328670 && e.geometry.length > 2).filter((e) => {
        const d = e.geometry.map((q) => { const [x, z] = toXZ(t, q.lat, q.lon); return project(t.points, x, z); });
        const ss = d.map((p) => { let s = p.s; if (s > L / 2) s -= L; return s; });
        return Math.min(...ss) > -900 && Math.max(...ss) < 900 && d.filter((p) => p.dist > 6 && p.dist < 45).length >= d.length / 2;
      }).map((e) => e.id);
    geo = ways.map((w) => els.find((e) => e.id === w).geometry);
  }
  const rows = [];
  for (const g of geo) for (const q of g) {
    const [x, z] = toXZ(t, q.lat, q.lon), p = project(t.points, x, z);
    let s = p.s; if (s > L / 2) s -= L;
    rows.push({ s, d: p.dist, side: p.side > 0 ? 'right' : 'left', lat: q.lat, lon: q.lon });
  }
  rows.sort((a, b) => a.s - b.s);
  const off = rows.filter((r) => r.d > 8);
  const sides = off.reduce((a, r) => (a[r.side]++, a), { left: 0, right: 0 });
  const beside = off.length ? { from: Math.round(off[0].s), to: Math.round(off[off.length - 1].s) } : null;
  const entry = rows[0], exit = rows[rows.length - 1];
  const game = readJSON(resolve(HERE, 'out', 'game-' + id + '.json')).pit;
  const rel = (s) => Math.round(s > L / 2 ? s - L : s);
  out[id] = { osmWays: ways || [28119448], realSide: sides.left > sides.right ? 'left (+1)' : 'right (-1)', sideNote: 'project().side > 0 is the RIGHT of the racing direction in the game frame (z = south)', sideVotes: sides,
    realEntry: { s: Math.round(entry.s), ll: [entry.lat, entry.lon] }, realExit: { s: Math.round(exit.s), ll: [exit.lat, exit.lon] }, realBesideTrack: beside,
    realLaneLength: Math.round(geo.reduce((a, g) => { let l = 0; for (let i = 1; i < g.length; i++) { const [x0, z0] = toXZ(t, g[i - 1].lat, g[i - 1].lon), [x1, z1] = toXZ(t, g[i].lat, g[i].lon); l += Math.hypot(x1 - x0, z1 - z0); } return a + l; }, 0)),
    game: game ? { side: game.side > 0 ? 'left (+1)' : 'right (-1)', limitKmh: game.limitKmh, from: rel(game.fromS), entry: rel(game.entryS), exit: rel(game.exitS), to: rel(game.toS), length: Math.round(game.length) } : null };
  console.log(id, JSON.stringify(out[id]));
}
writeJSON(resolve(HERE, 'out', 'pit.json'), out, true);
