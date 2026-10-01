// node devtests/track-fix/corners.js <trackId> [minRadius]
// Lists the corners of a built track (runs of |curvature| > 1/minRadius on the ~2 m samples): s range, direction,
// tightest radius, heading change, and the lat/lon of both ends and of the tightest point (through td.geo). Used to
// place the bankOverrides ends (tools/build-tracks.mjs BANKED).
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
const id = process.argv[2], rMin = +(process.argv[3] || 400);
const td = window.F1_TRACKS.find(t => t.id === id), g = td.geo;
const tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N;
const ll = s => [(td.geo.lat0 + s.z / g.kz).toFixed(6), (g.lon0 + s.x / g.kx).toFixed(6)];
// curvature from the tangent change over +-3 samples, then a light box smoothing
const c = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const a = S[(i - 3 + N) % N], b = S[(i + 3) % N];
  const cr = a.tx * b.tz - a.tz * b.tx, dt = a.tx * b.tx + a.tz * b.tz;
  c[i] = -Math.atan2(cr, dt) / (6 * ds);   // > 0: turning towards +n (left)
}
const cs = new Float64Array(N);
for (let i = 0; i < N; i++) { let v = 0; for (let k = -5; k <= 5; k++) v += c[(i + k + N) % N]; cs[i] = v / 11; }
const on = i => Math.abs(cs[i]) > 1 / rMin;
let start = 0; while (on(start)) start++;
const runs = [];
for (let k = 1; k <= N; k++) {
  const i = (start + k) % N;
  if (on(i) && !on((i - 1 + N) % N)) runs.push({ a: i, sign: Math.sign(cs[i]) });
  if (on(i) && runs.length && runs[runs.length - 1].b === undefined && Math.sign(cs[i]) !== runs[runs.length - 1].sign) { runs[runs.length - 1].b = (i - 1 + N) % N; runs.push({ a: i, sign: Math.sign(cs[i]) }); }
  if (!on(i) && on((i - 1 + N) % N) && runs.length) runs[runs.length - 1].b = (i - 1 + N) % N;
}
console.log(`${id} ${td.name}: N ${N}, length ${tr.length.toFixed(0)} m, corners with radius < ${rMin} m`);
for (const r of runs) {
  if (r.b === undefined) continue;
  const len = ((r.b - r.a + N) % N) + 1;
  let tight = r.a, turn = 0, bank = 0;
  for (let k = 0; k < len; k++) { const i = (r.a + k) % N; if (Math.abs(cs[i]) > Math.abs(cs[tight])) tight = i; turn += cs[i] * ds; bank = Math.max(bank, Math.abs(S[i].bank)); }
  console.log(`  ${r.sign > 0 ? 'LEFT ' : 'RIGHT'} s ${S[r.a].s.toFixed(0).padStart(5)}..${S[r.b].s.toFixed(0).padStart(5)} m (${(len * ds).toFixed(0).padStart(4)} m, frac ${(S[r.a].s / tr.length).toFixed(4)}..${(S[r.b].s / tr.length).toFixed(4)})` +
    ` turn ${(turn * 180 / Math.PI).toFixed(0).padStart(4)} deg, min R ${(1 / Math.abs(cs[tight])).toFixed(0).padStart(4)} m at s ${S[tight].s.toFixed(0)}` +
    ` | start ${ll(S[r.a]).join(',')} apex ${ll(S[tight]).join(',')} end ${ll(S[r.b]).join(',')} | max bank now ${(bank * 180 / Math.PI).toFixed(1)} deg`);
}
