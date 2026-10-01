// node devtests/track-audit/west/way-on-track.mjs <id> <overpass-cache-name> <wayId|nodeId> ...
// Each listed OSM way (or node) projected on the game centreline: per vertex the game s, distance, side (L/R of the
// direction of travel) - for pit lanes (entry / exit, side), start lines, tunnels.
import { loadGame, gameArrays, loadOverpass, r } from './lib-audit.mjs';
const [id, name, ...ids] = process.argv.slice(2);
const g = loadGame(id), A = gameArrays(g), J = loadOverpass(name);
const near = (x, y) => {
  let b = Infinity, bi = 0; for (let i = 0; i < A.N; i++) { const d = (A.xy[i][0] - x) ** 2 + (A.xy[i][1] - y) ** 2; if (d < b) { b = d; bi = i; } }
  const a = A.xy[bi], c = A.xy[(bi + 1) % A.N], cr = (c[0] - a[0]) * (y - a[1]) - (c[1] - a[1]) * (x - a[0]);
  return { d: Math.sqrt(b), s: A.s[bi], side: cr > 0 ? 'L' : 'R' };
};
for (const want of ids) {
  const e = J.elements.find((q) => String(q.id) === want);
  if (!e) { console.log(want, 'not in cache'); continue; }
  const geom = e.geometry || [{ lat: e.lat, lon: e.lon }];
  const rows = geom.map((p) => { const [x, y] = A.proj.to(p.lat, p.lon); const q = near(x, y); return `${r(q.s, 0)}/${r(q.d, 1)}${q.side}`; });
  let len = 0; for (let i = 1; i < geom.length; i++) { const [x1, y1] = A.proj.to(geom[i - 1].lat, geom[i - 1].lon), [x2, y2] = A.proj.to(geom[i].lat, geom[i].lon); len += Math.hypot(x2 - x1, y2 - y1); }
  console.log(e.type, e.id, JSON.stringify(e.tags || {}).slice(0, 120), 'len', r(len, 0), 'm; s/dist side per vertex:', rows.join(' '));
}
