// node devtests/track-audit/verify/crossslope.js <id> <source> <s0> <s1> [step=10] [half=4]
// Spot check of the auditors' lidar cross-slope (banking) method: at stations every <step> m on the game's built
// centreline, samples the DEM at -half..+half m along the game normal (1 m apart), fits a line, and prints the cross
// slope in degrees with the game's sign convention (+ = left side of the racing direction higher, = samples[].bank),
// next to the game's bank.
'use strict';
const L = require('./lib.js');
const { SOURCES } = require('./dem.js');
(async () => {
  const [id, src, a, b, st, hf] = process.argv.slice(2);
  const g = L.game(id), step = +(st || 10), half = +(hf || 4), pts = [], meta = [];
  for (let s = +a; s <= +b; s += step) {
    const q = g.at(s);
    for (let o = -half; o <= half; o += 1) { pts.push(g.ll(q.x + q.nx * o, q.z + q.nz * o)); meta.push([s, o]); }
  }
  const h = await SOURCES[src](pts);
  const rows = [];
  for (let i = 0; i < pts.length; i += 2 * half + 1) {
    const xs = [], ys = [];
    for (let k = 0; k <= 2 * half; k++) if (Number.isFinite(h[i + k])) { xs.push(meta[i + k][1]); ys.push(h[i + k]); }
    const n = xs.length, mx = xs.reduce((p, v) => p + v, 0) / n, my = ys.reduce((p, v) => p + v, 0) / n;
    let sxy = 0, sxx = 0, res = 0; for (let k = 0; k < n; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
    const slope = sxy / sxx; for (let k = 0; k < n; k++) res = Math.max(res, Math.abs(ys[k] - my - slope * (xs[k] - mx)));
    const s = meta[i][0], q = g.at(s);
    rows.push([s, Math.atan(slope) * L.D, q.bank * L.D, res]);
    console.log(`  s ${s.toFixed(0).padStart(5)}  lidar ${(Math.atan(slope) * L.D).toFixed(1).padStart(5)} deg  game ${(q.bank * L.D).toFixed(1).padStart(5)} deg  (max residual ${res.toFixed(2)} m)`);
  }
  const ok = rows.filter((r) => r[3] < 0.15), m = (arr) => arr.reduce((p, v) => p + v, 0) / arr.length;
  console.log(`${id} ${src} s ${a}-${b}: mean lidar ${m(ok.map((r) => r[1])).toFixed(1)} deg, game ${m(ok.map((r) => r[2])).toFixed(1)} deg (${ok.length}/${rows.length} planar stations)`);
})();
