// node devtests/track-audit/west/near-track.mjs <id> <overpass-cache-name> [maxDist=25]
// Lists OSM ways of a cached Overpass answer that run along / across the game centreline: for each way, the part of
// it within maxDist metres of the centreline (game s range, mean distance), and where it crosses it.
import { loadGame, gameArrays, loadOverpass, r } from './lib-audit.mjs';
const [id, name, maxD = '25'] = process.argv.slice(2);
const g = loadGame(id), A = gameArrays(g), J = loadOverpass(name);
const near = (x, y) => { let b = Infinity, bi = 0; for (let i = 0; i < A.N; i++) { const d = (A.xy[i][0] - x) ** 2 + (A.xy[i][1] - y) ** 2; if (d < b) { b = d; bi = i; } } return { d: Math.sqrt(b), i: bi }; };
for (const e of J.elements) {
  if (e.type !== 'way' || !e.geometry) continue;
  const pts = e.geometry.map((p) => { const [x, y] = A.proj.to(p.lat, p.lon); return Object.assign(near(x, y), { lat: p.lat, lon: p.lon }); });
  const close = pts.filter((p) => p.d <= +maxD);
  if (!close.length) continue;
  const ss = close.map((p) => A.s[p.i]);
  const t = e.tags || {};
  console.log(e.id, JSON.stringify({ name: t.name, highway: t.highway, tunnel: t.tunnel, bridge: t.bridge, layer: t.layer, covered: t.covered, raceway: t.raceway, service: t.service }),
    'n', pts.length, 'close', close.length, 's', r(Math.min(...ss), 0) + '..' + r(Math.max(...ss), 0), 'meanD', r(close.reduce((a, p) => a + p.d, 0) / close.length, 1),
    'ends', JSON.stringify([[pts[0].lat, pts[0].lon], [pts[pts.length - 1].lat, pts[pts.length - 1].lon]]));
}
