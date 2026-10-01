// node devtests/track-audit/east/corners.mjs <id>
// Corners of the game centreline (true-metre frame of out/game-<id>.json): stretches with radius < 250 m, same hand,
// merged across gaps < 25 m; per corner: hand, game s range, turned angle, minimum radius, the game's bank at the
// tightest point (js/track.js: derived from curvature, max 6 deg, sign = inside lower) and grade there.
import { resolve } from 'node:path';
import { EAST, game, projector, r1 } from './core.mjs';

export function corners(id, rMax = 250, mergeGap = 25) {
  const G = game(id), S = G.samples, N = S.length, pr = projector(G.geo.lat0, G.geo.lon0);
  const P = S.map((q) => pr.f(q.lat, q.lon));
  const hd = P.map((_, i) => { const a = P[i], b = P[(i + 1) % N]; return Math.atan2(b[1] - a[1], b[0] - a[0]); });
  const seg = P.map((_, i) => Math.hypot(P[(i + 1) % N][0] - P[i][0], P[(i + 1) % N][1] - P[i][1]));
  const w = 4; // curvature over +-4 samples (~16 m)
  const k = P.map((_, i) => {
    let d = hd[(i + w) % N] - hd[(i - w + N) % N]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    let L = 0; for (let j = -w; j < w; j++) L += seg[(i + j + N) % N];
    return d / (L || 1);                                  // > 0: turning left (anticlockwise in the east / north frame)
  });
  const out = [];
  let cur = null;
  for (let i = 0; i < N; i++) {
    const on = Math.abs(k[i]) > 1 / rMax, sg = Math.sign(k[i]);
    if (on && cur && cur.sg === sg && i - cur.b <= Math.round(mergeGap / 2)) cur.b = i;
    else if (on) { if (cur) out.push(cur); cur = { sg, a: i, b: i }; }
  }
  if (cur) out.push(cur);
  return out.map((c, n) => {
    let ang = 0, mi = c.a;
    for (let i = c.a; i <= c.b; i++) { let d = hd[(i + 1) % N] - hd[i]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; ang += d; if (Math.abs(k[i]) > Math.abs(k[mi])) mi = i; }
    return { n: n + 1, hand: c.sg > 0 ? 'L' : 'R', fromS: Math.round(S[c.a].s), toS: Math.round(S[c.b].s), angleDeg: Math.round(ang * 180 / Math.PI),
      minRadiusM: Math.round(1 / Math.abs(k[mi])), apex: [S[mi].lat, S[mi].lon], apexS: Math.round(S[mi].s), bankDeg: r1(S[mi].bank), gradePct: r1(S[mi].grade * 100), y: r1(S[mi].y) };
  }).filter((c) => Math.abs(c.angleDeg) >= 15);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(EAST, 'corners.mjs')) {
  for (const id of process.argv.slice(2)) {
    console.log('==', id);
    for (const c of corners(id)) console.log(`${String(c.n).padStart(2)} ${c.hand} s ${String(c.fromS).padStart(4)}-${String(c.toS).padStart(4)} apex ${String(c.apexS).padStart(4)} ang ${String(c.angleDeg).padStart(4)} Rmin ${String(c.minRadiusM).padStart(4)} bank ${String(c.bankDeg).padStart(5)} grade ${String(c.gradePct).padStart(5)}% y ${c.y}  ${c.apex.join(',')}`);
  }
}
