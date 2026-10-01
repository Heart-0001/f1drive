// node devtests/track-audit/eu-south-central/osm-list.js <id> [all]
// Lists the cached Overpass objects of a circuit: raceway ways (tags, length), relations, nodes, bridges / tunnels
// (only those within 40 m of the game centreline unless 'all').
'use strict';
const fs = require('fs'), path = require('path');
const id = process.argv[2], all = process.argv[3] === 'all';
const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'overpass', id + '.json'), 'utf8'));
const game = require(path.join(__dirname, 'out', `game-${id}.json`));
const lat0 = game.points[0][0], KX = 111320 * Math.cos(lat0 * Math.PI / 180), KZ = 110540;
const G = game.points.map((p) => [p[1] * KX, p[0] * KZ, p[2]]);
function nearGame(lat, lon) {
  const x = lon * KX, z = lat * KZ; let best = Infinity, bs = 0;
  for (let i = 0; i < G.length; i++) {
    const a = G[i], b = G[(i + 1) % G.length], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2)) : 0;
    const d = Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z);
    if (d < best) { best = d; bs = a[2] + t * Math.sqrt(l2); }
  }
  return { d: best, s: bs };
}
const wlen = (w) => { let L = 0; for (let i = 1; i < w.geometry.length; i++) L += Math.hypot((w.geometry[i].lon - w.geometry[i - 1].lon) * KX, (w.geometry[i].lat - w.geometry[i - 1].lat) * KZ); return L; };
for (const e of j.elements) {
  if (e.type === 'relation') { console.log(`REL ${e.id} ${JSON.stringify(e.tags)} members ${e.members.length} (${e.members.filter((m) => m.type === 'way').map((m) => m.ref + (m.role ? ':' + m.role : '')).join(' ')})`); continue; }
  if (e.type === 'node') { const ng = nearGame(e.lat, e.lon); console.log(`NODE ${e.id} ${e.lat},${e.lon} ${JSON.stringify(e.tags)} | game d ${ng.d.toFixed(1)} m s ${ng.s.toFixed(0)}`); continue; }
  if (!e.geometry) continue;
  const t = e.tags || {};
  const mid = e.geometry[Math.floor(e.geometry.length / 2)], a = e.geometry[0], b = e.geometry[e.geometry.length - 1];
  const na = nearGame(a.lat, a.lon), nm = nearGame(mid.lat, mid.lon), nb = nearGame(b.lat, b.lon);
  const isRace = t.highway === 'raceway' || t.raceway;
  const close = Math.min(na.d, nm.d, nb.d) < 40;
  if (!isRace && !all && !close) continue;
  console.log(`${isRace ? 'RACE' : 'WAY '} ${e.id} len ${wlen(e).toFixed(0)} m  ${JSON.stringify(t)} | game d ${na.d.toFixed(0)}/${nm.d.toFixed(0)}/${nb.d.toFixed(0)} s ${na.s.toFixed(0)}/${nm.s.toFixed(0)}/${nb.s.toFixed(0)}`);
}
