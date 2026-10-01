// node devtests/track-audit/verify/compare.js <id> <source> [step=10] [medianHalfM=10] [sigmaM=10] [s0 s1]
// Samples <source> (dem.js) every <step> m along the game's BUILT centreline, smooths it lightly (median over
// +-medianHalfM, Gaussian sigma), aligns it with the built heights by the mean, and prints: range real / game, RMS,
// correlation, max climb / descent over 50 and 100 m for both, and every 100 m window whose grades differ by > 2 pp.
// Writes cache/verify/prof-<id>-<source>.json ([s, lat, lon, raw, real, game]).
'use strict';
const L = require('./lib.js');
const { SOURCES } = require('./dem.js');
async function compare(id, src, step = 10, medHalfM = 10, sigmaM = 10, win = null, quiet = false) {
  const g = L.game(id), n = Math.round(g.L / step), ds = g.L / n;
  const pts = [], ss = [];
  for (let k = 0; k < n; k++) { const s = k * ds, q = g.at(s), [la, lo] = g.ll(q.x, q.z); ss.push(s); pts.push([la, lo]); }
  // the sample points are taken on the exact built samples: use interpolated positions instead
  for (let k = 0; k < n; k++) {
    const s = ss[k], u = s / g.ds, a = Math.floor(u) % g.N, t = u - Math.floor(u), A = g.S[a], B = g.S[(a + 1) % g.N];
    pts[k] = g.ll(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
  }
  const raw = await SOURCES[src](pts);
  // fill gaps linearly (closed loop)
  const h = raw.slice(), ok = raw.map(Number.isFinite);
  if (!ok.some(Boolean)) throw new Error('no data');
  for (let i = 0; i < n; i++) if (!ok[i]) {
    let a = i, b = i, da = 0, db = 0; while (!ok[a]) { a = (a - 1 + n) % n; da++; } while (!ok[b]) { b = (b + 1) % n; db++; }
    h[i] = raw[a] + (raw[b] - raw[a]) * da / (da + db);
  }
  const mh = Math.max(0, Math.round(medHalfM / ds));
  let m = h.map((_, i) => { const w = []; for (let j = -mh; j <= mh; j++) w.push(h[((i + j) % n + n) % n]); w.sort((p, q) => p - q); return w[mh]; });
  const sg = sigmaM / ds, R = Math.ceil(3 * sg);
  if (sg > 0) m = m.map((_, i) => { let acc = 0, wsum = 0; for (let j = -R; j <= R; j++) { const w = Math.exp(-0.5 * (j / sg) ** 2); acc += w * m[((i + j) % n + n) % n]; wsum += w; } return acc / wsum; });
  const gy = ss.map((s) => g.y(s));
  const inWin = (s) => !win || (win[0] <= win[1] ? s >= win[0] && s <= win[1] : s >= win[0] || s <= win[1]);
  const idx = ss.map((s, i) => i).filter((i) => inWin(ss[i]));
  const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
  const off = mean(idx.map((i) => m[i])) - mean(idx.map((i) => gy[i]));
  const real = m.map((v) => v - off);
  const rms = Math.sqrt(mean(idx.map((i) => (real[i] - gy[i]) ** 2)));
  const mr = mean(idx.map((i) => real[i])), mg = mean(idx.map((i) => gy[i]));
  const cov = mean(idx.map((i) => (real[i] - mr) * (gy[i] - mg))), sr = Math.sqrt(mean(idx.map((i) => (real[i] - mr) ** 2))), sgm = Math.sqrt(mean(idx.map((i) => (gy[i] - mg) ** 2)));
  const H = (arr) => (s) => { const u = ((s / ds) % n + n) % n, a = Math.floor(u), t = u - a; return arr[a] + (arr[(a + 1) % n] - arr[a]) * t; };
  const hr = H(real), hg = H(gy);
  const ext = (f, w) => { let up = { g: -1e9 }, dn = { g: 1e9 }; for (const i of idx) { const v = L.grade(f, ss[i], w); if (v > up.g) up = { g: v, s: ss[i] }; if (v < dn.g) dn = { g: v, s: ss[i] }; } return { up, dn }; };
  const fmt = (e) => `+${e.up.g.toFixed(1)}% @${e.up.s.toFixed(0)} / ${e.dn.g.toFixed(1)}% @${e.dn.s.toFixed(0)}`;
  const diffs = [];
  for (const i of idx) { const d = L.grade(hg, ss[i], 100) - L.grade(hr, ss[i], 100); if (Math.abs(d) > 2) diffs.push([ss[i], L.grade(hg, ss[i], 100), L.grade(hr, ss[i], 100)]); }
  // merge consecutive windows
  const zones = [];
  for (const d of diffs) { const z = zones[zones.length - 1]; if (z && d[0] - z.s1 <= ds * 1.5 && Math.sign(d[1] - d[2]) === z.sign) { z.s1 = d[0]; if (Math.abs(d[1] - d[2]) > Math.abs(z.worst[1] - z.worst[2])) z.worst = d; } else zones.push({ s0: d[0], s1: d[0], sign: Math.sign(d[1] - d[2]), worst: d }); }
  const rng = (f) => { const v = idx.map((i) => f[i]); return Math.max(...v) - Math.min(...v); };
  const res = { id, src, step: ds, rangeReal: rng(real), rangeGame: rng(gy), rawRange: rng(h), rms, r: cov / (sr * sgm),
    real50: ext(hr, 50), game50: ext(hg, 50), real100: ext(hr, 100), game100: ext(hg, 100), zones, holes: raw.filter((v) => !Number.isFinite(v)).length,
    hr, hg, ss, real, gy, pts, raw };
  if (!quiet) {
    console.log(`${id} vs ${src}${win ? ' window ' + win.join('-') : ''} (step ${ds.toFixed(1)} m, ${res.holes} holes): range real ${res.rangeReal.toFixed(1)} m (raw ${res.rawRange.toFixed(1)}) / game ${res.rangeGame.toFixed(1)} m; rms ${rms.toFixed(2)} m; r ${res.r.toFixed(3)}`);
    console.log(`  50 m : real ${fmt(res.real50)}   game ${fmt(res.game50)}`);
    console.log(`  100 m: real ${fmt(res.real100)}   game ${fmt(res.game100)}`);
    console.log(`  ${zones.length} stretches with 100 m grades > 2 pp apart:`);
    for (const z of zones) console.log(`    s ${z.s0.toFixed(0)}-${z.s1.toFixed(0)}: worst @${z.worst[0].toFixed(0)} game ${z.worst[1].toFixed(1)}% real ${z.worst[2].toFixed(1)}%`);
  }
  L.fs.writeFileSync(L.path.join(L.CACHE, 'verify', `prof-${id}-${src}.json`), JSON.stringify(ss.map((s, i) => [+s.toFixed(1), +pts[i][0].toFixed(7), +pts[i][1].toFixed(7), Number.isFinite(raw[i]) ? +raw[i].toFixed(2) : null, +real[i].toFixed(2), +gy[i].toFixed(2)])));
  return res;
}
module.exports = { compare };
if (require.main === module) {
  const a = process.argv.slice(2);
  compare(a[0], a[1], +(a[2] || 10), +(a[3] || 10), +(a[4] || 10), a[6] !== undefined ? [+a[5], +a[6]] : null).catch((e) => { console.error(e); process.exit(1); });
}
