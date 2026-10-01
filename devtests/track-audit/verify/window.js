// node devtests/track-audit/verify/window.js <id> <source> <s0> <s1> <step>
// Samples <source> (dem.js) on the game's built centreline from s0 to s1 every <step> m and prints real vs game
// heights (both relative to their own value at s0) and the 50 m grades. For a single stretch (one request).
'use strict';
const L = require('./lib.js');
const { SOURCES } = require('./dem.js');
(async () => {
  const [id, src, a, b, st] = process.argv.slice(2);
  const g = L.game(id), s0 = +a, s1 = +b, step = +st, pts = [], ss = [];
  for (let s = s0; s <= s1 + 1e-6; s += step) {
    const u = ((s % g.L) + g.L) % g.L / g.ds, i = Math.floor(u) % g.N, t = u - Math.floor(u), A = g.S[i], B = g.S[(i + 1) % g.N];
    ss.push(s); pts.push(g.ll(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t));
  }
  const h = await SOURCES[src](pts);
  const gy = ss.map((s) => g.y(((s % g.L) + g.L) % g.L));
  const k = Math.max(1, Math.round(50 / step / 2));
  console.log(`${id} ${src} s ${s0}-${s1} step ${step}: s  real(raw)  real-rel  game-rel  grade50 real / game`);
  for (let i = 0; i < ss.length; i++) {
    const gr = (arr) => (i - k >= 0 && i + k < ss.length ? (100 * (arr[i + k] - arr[i - k]) / (ss[i + k] - ss[i - k])).toFixed(1) : '');
    console.log(`  ${ss[i].toFixed(0).padStart(5)} ${Number.isFinite(h[i]) ? h[i].toFixed(2).padStart(8) : '     NaN'} ${(h[i] - h[0]).toFixed(2).padStart(7)} ${(gy[i] - gy[0]).toFixed(2).padStart(7)}   ${gr(h).padStart(5)} / ${gr(gy)}`);
  }
  const v = h.filter(Number.isFinite);
  console.log(`  range real ${(Math.max(...v) - Math.min(...v)).toFixed(2)} m, game ${(Math.max(...gy) - Math.min(...gy)).toFixed(2)} m`);
})();
