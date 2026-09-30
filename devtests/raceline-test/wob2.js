const path = require('path');const ROOT = 'C:/Users/user/Desktop/f1drive';
global.window = global;global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));require(path.join(ROOT, 'js/track.js'));require(path.join(ROOT, 'js/car.js'));require(path.join(ROOT, 'js/raceline.js'));
let gmax = 0, gname = '', gAmp = 0, gAmpName = '', rows = [];
for (const td of F1_TRACKS) {
  const tr = F1.buildTrack(td), l = F1.buildRaceLine(tr), P = l.points, N = P.length;
  const hd = [], dth = [];
  for (let i = 0; i < N; i++) { const q = P[(i + 1) % N]; hd.push(Math.atan2(q.x - P[i].x, q.z - P[i].z)); }
  for (let i = 0; i < N; i++) { let a = hd[i] - hd[(i - 1 + N) % N]; while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; dth.push(a); }
  // (a) 2 m zig-zag on fast parts: kink relative to neighbours
  let zmax = 0, zi = 0;
  for (let i = 0; i < N; i++) { if (P[i].speed < 55) continue; const z = Math.abs(dth[i] - 0.5 * (dth[(i - 1 + N) % N] + dth[(i + 1) % N])); if (z > zmax) { zmax = z; zi = i; } }
  // (b) mid-scale waviness: deviation of the line from its own 60 m moving quadratic-free average, on parts with |k| < 1/300
  //     measured as lateral distance from the chord midpoint of points 15 samples either side, minus what curvature explains
  let amax = 0, ai = 0;
  for (let i = 0; i < N; i++) {
    let straight = true; for (let k = -30; k <= 30; k += 3) if (Math.abs(P[(i + k + N) % N].curvature) > 1 / 300) { straight = false; break; }
    if (!straight) continue;
    const a = P[(i - 30 + N) % N], b = P[(i + 30) % N], m = P[i], q1 = P[(i - 15 + N) % N], q3 = P[(i + 15) % N];
    const ux = b.x - a.x, uz = b.z - a.z, ul = Math.hypot(ux, uz);
    const off = p => ((p.x - a.x) * uz - (p.z - a.z) * ux) / ul;
    // for a constant-curvature arc: off(mid) = 4/3 * mean(off(q1), off(q3)); residual = wave
    const res = Math.abs(off(m) - (4 / 3) * 0.5 * (off(q1) + off(q3)));
    if (res > amax) { amax = res; ai = i; }
  }
  rows.push([td.name, (zmax * 1e3).toFixed(2), zi, amax.toFixed(3), ai]);
}
rows.sort((a, b) => b[3] - a[3]);
console.log('worst mid-scale wave residual (m over a 120 m span, straights/|R|>300):'); rows.slice(0, 6).forEach(r => console.log(' ', r[0], r[3] + ' m @' + r[4]));
rows.sort((a, b) => b[1] - a[1]);
console.log('worst 2 m kink on fast parts (mrad):'); rows.slice(0, 6).forEach(r => console.log(' ', r[0], r[1] + ' mrad @' + r[2]));
