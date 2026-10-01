// node bridges.js <id> ...  -> the scenery bridges the game builds over the road (js/scenery.js debug footprints,
// over = deck spans the road), with their lap position and the matching OSM man_made=bridge way (if the lap itself is
// that bridge, the deck is a phantom drawn over the road where the real road is ON the bridge).
'use strict';
const path = require('path'), ROOT = path.resolve(__dirname, '..', '..', '..');
global.window = global; global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js')); require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js')); require(path.join(ROOT, 'js', 'scenery.js'));
F1.SCENERY_DEBUG = true;
for (const id of process.argv.slice(2)) {
  const td = F1_TRACKS.find((t) => t.id === id), tr = F1.buildTrack(td), S = tr.samples, N = S.length, g = td.geo;
  const sc = F1.buildScenery(tr, td, F1_SCENERY[id]);
  for (const f of sc.debug.footprints.filter((q) => q.k === 'bridge')) {
    let cx = 0, cz = 0; for (const p of f.p) { cx += p[0]; cz += p[1]; } cx /= f.p.length; cz /= f.p.length;
    let bi = 0, bd = 1e9; for (let i = 0; i < N; i++) { const d = Math.hypot(S[i].x - cx, S[i].z - cz); if (d < bd) { bd = d; bi = i; } }
    console.log(id, 'bridge', f.over ? 'OVER THE ROAD' : 'beside', 'lap s', S[bi].s.toFixed(0), 'dist', bd.toFixed(0), 'deck underside', (f.minY - S[bi].y).toFixed(1), 'm above the road',
      'lat/lon', (g.lat0 + cz / g.kz).toFixed(6), (g.lon0 + cx / g.kx).toFixed(6));
  }
  sc.dispose && sc.dispose(); tr.dispose && tr.dispose();
}
