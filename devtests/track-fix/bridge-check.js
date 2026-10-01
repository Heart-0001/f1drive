// node devtests/track-fix/bridge-check.js [track id]   (default jp-1962)
// A grade-separated crossing (track.bridges: Suzuka's crossover since 2026-10-01) checked on both levels: the two
// checks of devtests/3d-test/build.js that locate mesh vertices in plan only, repeated with the vertex height passed to
// track.locate(x, z, -1, y) (the level-aware lookup), plus the bridge itself:
//   surfaceY   every road / runoff / paint vertex abeam a sample lies on surfaceY of the level it belongs to (< 0.03 m)
//   walls      no wall / deck / abutment vertex stands inside the road of the level it is on (>= halfW + 0.5 m)
//   deck       the deck's underside is above the lower road's surface everywhere over its corridor (clearance), the
//              lower road's walls and the abutment tops stay under the deck
//   terrain    the terrain is under both roads at every cross-section point near the crossing
//   queries    locate / nearest / groundY / inCorridor with y on a grid around the crossing pick the level closest to y
// Ends with "bridge checks passed" or "FAILED n" (exit code).
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
const id = process.argv[2] || 'jp-1962';
const td = window.F1_TRACKS.find((t) => t.id === id), tr = F1.buildTrack(td), S = tr.samples, N = S.length;
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const cyc = (a, b) => { const d = Math.abs(a - b); return Math.min(d, N - d); };
check(tr.bridges && tr.bridges.length > 0, id + ': ' + (tr.bridges || []).length + ' bridge(s) ' + JSON.stringify(tr.bridges));
const B = tr.bridges[0];
const near = (i) => cyc(i, B.up) < 120 || cyc(i, B.lo) < 120;

// surfaceY, level-aware (as devtests/3d-test/build.js, with y)
let maxErr = 0, n = 0;
for (const [name, lift] of [['road', 0.012], ['runoff', 0], ['paint', 0.03]]) {
  const p = tr.group.children.find((m) => m.name === name).geometry.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) {
    const loc = tr.locate(p[i], p[i + 2], -1, p[i + 1]), s = S[loc.index];
    if (!near(loc.index)) continue;
    if (Math.hypot(p[i] - s.x - s.nx * loc.d, p[i + 2] - s.z - s.nz * loc.d) > 0.05) continue;
    const e = Math.abs(p[i + 1] - tr.surfaceY(loc.index, loc.d)) - (name === 'paint' ? 0.04 : lift);
    maxErr = Math.max(maxErr, e); n++;
  }
}
check(maxErr < 0.03, 'surfaceY on both levels: ' + n + ' vertices near the crossing, worst ' + maxErr.toFixed(3) + ' m');

// walls: no vertex of the walls mesh (walls, parapets, deck, abutments) inside the road of its own level
const wp = tr.group.children.find((m) => m.name === 'walls').geometry.attributes.position.array;
let inRoad = 0, minClr = 1e9, cnt = 0;
for (let i = 0; i < wp.length; i += 9) {
  const loc = tr.locate(wp[i], wp[i + 2], -1, wp[i + 1]), s = S[loc.index];
  if (!near(loc.index)) continue;
  // a vertex is "in the road" only at road level: from the surface to 1 m above it (the deck's underside is under the
  // upper road, the parapets' tops above the lower one: not in either)
  const sy = tr.surfaceY(loc.index, loc.d), dy = wp[i + 1] - sy;
  if (dy < -0.05 || dy > 1.0) continue;
  const dist = Math.hypot(wp[i] - s.x, wp[i + 2] - s.z);
  minClr = Math.min(minClr, dist - s.halfW); cnt++;
  if (dist < s.halfW + 0.5) inRoad++;
}
check(inRoad === 0, 'walls / deck / abutments: ' + cnt + ' vertices at road level near the crossing, ' + inRoad + ' inside a road, closest ' + minClr.toFixed(2) + ' m from the edge');

// the deck over the lower road: clearance over its whole corridor, nothing of the walls mesh in the space between
const lo = S[B.lo];
let minClear = Infinity, intrude = 0;
for (let q = -30; q <= 30; q++) {
  const i = (B.lo + q + N) % N, s = S[i];
  for (let d = -s.wallNegDist + 0.3; d <= s.wallPosDist - 0.3; d += 0.5) {
    const x = s.x + s.nx * d, z = s.z + s.nz * d, yl = tr.surfaceY(i, d), up = tr.locate(x, z, -1, yl + 6);
    if (cyc(up.index, B.up) > 40) continue;
    const su = S[up.index], du = up.d;
    if (du < -su.wallNegDist - 0.5 || du > su.wallPosDist + 0.5) continue;   // not under the upper road
    minClear = Math.min(minClear, tr.surfaceY(up.index, du) - 0.9 - yl);
  }
}
for (let i = 0; i < wp.length; i += 3) {     // walls-mesh vertices inside the lower road's clearance envelope
  const loc = tr.locate(wp[i], wp[i + 2], B.lo, wp[i + 1] - 3);
  if (cyc(loc.index, B.lo) > 30) continue;
  const s = S[loc.index], hw = s.halfW;
  if (Math.abs(loc.d) < hw && wp[i + 1] > tr.surfaceY(loc.index, loc.d) + 0.05 && wp[i + 1] < tr.surfaceY(loc.index, loc.d) + 4.0) intrude++;
}
check(minClear >= 4.8, 'clearance under the deck over the lower road (wall to wall): ' + minClear.toFixed(2) + ' m');
check(intrude === 0, 'nothing of the walls mesh in the lower road\'s headroom (4 m over the road): ' + intrude + ' vertices');

// terrain under both roads around the crossing
let worst = Infinity;
for (const c of [B.up, B.lo]) for (let q = -60; q <= 60; q++) {
  const i = (c + q + N) % N, s = S[i];
  for (let d = -s.wallNegDist; d <= s.wallPosDist; d += 0.5) {
    const m = tr.surfaceY(i, d) - tr.terrainY(s.x + s.nx * d, s.z + s.nz * d);
    worst = Math.min(worst, m);
  }
}
check(worst > 0.05, 'terrain under both roads (closest ' + worst.toFixed(2) + ' m)');

// queries on a grid around the crossing
let bad = 0, total = 0;
for (let gx = -30; gx <= 30; gx += 3) for (let gz = -30; gz <= 30; gz += 3) {
  const x = lo.x + gx, z = lo.z + gz;
  for (const [c, other] of [[B.lo, B.up], [B.up, B.lo]]) {
    const own = tr.locate(x, z, c);                       // the hinted road (as the car on it sees it)
    const s = S[own.index];
    if (Math.abs(own.d) > Math.min(s.halfW, 7) || cyc(own.index, c) > 40) continue;
    const y = tr.surfaceY(own.index, own.d);
    const g = tr.locate(x, z, -1, y + 0.4), nr = tr.nearest(x, z, y + 0.4), gy = tr.groundY(x, z, y + 0.4);
    total++;
    if (cyc(g.index, c) > 40 || cyc(nr.index, c) > 40 || Math.abs(gy - y) > 0.05 || !tr.inCorridor(x, z, 0)) bad++;
  }
}
check(bad === 0 && total > 50, 'locate / nearest / groundY / inCorridor with y on both roads: ' + total + ' points, ' + bad + ' wrong');
console.log(fails ? 'FAILED ' + fails : 'bridge checks passed');
process.exit(fails ? 1 : 0);
