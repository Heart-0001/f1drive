// node devtests/track-audit/west/crossings.mjs <id> <overpass-cache-name> [osm-loop label]
// OSM tunnels / bridges / covered ways that CROSS the reference centreline (OSM loop if given, else the game line):
// segment intersections, with the crossing's game s, angle and the way's layer (layer > 0: over the track; < 0: under).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';
import { loadGame, gameArrays, loadOverpass, cumLen, nearestOn, r } from './lib-audit.mjs';
const [id, name, loopLabel] = process.argv.slice(2);
const g = loadGame(id), A = gameArrays(g), J = loadOverpass(name);
const line = loopLabel ? JSON.parse(readFileSync(resolve(HERE, 'res', 'osm-loop-' + loopLabel + '.json'), 'utf8')).loop.map(([la, lo]) => A.proj.to(la, lo)) : A.xy;
const gc = cumLen(A.xy, true);
const X = (p, q, a, b) => {
  const d = (q[0] - p[0]) * (b[1] - a[1]) - (q[1] - p[1]) * (b[0] - a[0]);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0])) / d, u = ((a[0] - p[0]) * (q[1] - p[1]) - (a[1] - p[1]) * (q[0] - p[0])) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] : null;
};
for (const e of J.elements) {
  if (e.type !== 'way' || !e.geometry) continue;
  const W = e.geometry.map((p) => A.proj.to(p.lat, p.lon)), t = e.tags || {};
  for (let i = 0; i < W.length - 1; i++) for (let j = 0; j < line.length; j++) {
    const c = X(W[i], W[i + 1], line[j], line[(j + 1) % line.length]);
    if (!c) continue;
    const q = nearestOn(A.xy, gc, c[0], c[1], true);
    const a1 = Math.atan2(W[i + 1][1] - W[i][1], W[i + 1][0] - W[i][0]), a2 = Math.atan2(line[(j + 1) % line.length][1] - line[j][1], line[(j + 1) % line.length][0] - line[j][0]);
    let ang = Math.abs((a1 - a2) * 180 / Math.PI) % 180; if (ang > 90) ang = 180 - ang;
    console.log(e.id, JSON.stringify({ name: t.name, highway: t.highway, tunnel: t.tunnel, bridge: t.bridge, layer: t.layer, covered: t.covered, man_made: t.man_made }),
      'crosses at gameS', r(q.s, 0), 'angle', r(ang, 0), 'at', A.proj.from(c[0], c[1]).map((v) => +v.toFixed(6)).join(','));
  }
}
