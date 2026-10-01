// node devtests/track-fix/compare-ref.js [tracks-data.js]
// The game's elev[] against the verifier's independent reference profiles (devtests/review-1/verify-world/out:
// USGS 3DEP EPQS every 50 m for us-2012 / us-2023, IGN RGE ALTI every 40 m for mc-1929), re-sampled from the given
// tracks-data.js (default: the current one): range, max grade over ~100 m, rms / max difference after removing the
// mean offset. (The reference caches also hold the old game values; those are ignored here.)
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const file = path.resolve(process.argv[2] || path.join(ROOT, 'tracks-data.js'));
const W = {}; new Function('window', fs.readFileSync(file, 'utf8'))(W);
// skip: stretches where the reference model is known not to show the road (the Monaco tunnel, 624-991 m, see
// tools/build-tracks.mjs COVERED: the terrain model gives the ground above it)
const REF = [['us-2012', 'usgs-us-2012.json', 'usgs', 'USGS 3DEP'], ['us-2023', 'usgs-us-2023.json', 'usgs', 'USGS 3DEP'],
  ['mc-1929', 'ign-mc-1929.json', 'ign', 'IGN RGE ALTI'], ['mc-1929', 'ign-mc-1929.json', 'ign', 'IGN RGE ALTI, tunnel 600-1010 m left out', [600, 1010]]];
for (const [id, fn, key, label, skip] of REF) {
  const t = W.F1_TRACKS.find(x => x.id === id), P = t.points, E = t.elev, n = P.length, cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]));
  const at = s => { let i = 0; while (i < n - 1 && cum[i + 1] <= s) i++; const f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1); return E[i] + (E[(i + 1) % n] - E[i]) * f; };
  const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'devtests', 'review-1', 'verify-world', 'out', fn), 'utf8')).filter(p => p[key] > -100 && !(skip && p.s >= skip[0] && p.s <= skip[1]));
  const r = ref.map(p => p[key]), g = ref.map(p => at(p.s)), m = ref.length, ds = ref[1].s - ref[0].s;
  const off = r.reduce((a, v, i) => a + v - g[i], 0) / m;
  let rms = 0, mx = 0, mxAt = 0, gr = 0, gg = 0, step = Math.max(1, Math.round(100 / ds));
  for (let i = 0; i < m; i++) {
    const d = r[i] - off - g[i]; rms += d * d; if (Math.abs(d) > mx) { mx = Math.abs(d); mxAt = ref[i].s; }
    const j = (i + step) % m;
    if (skip && ref[j].s - ref[i].s > step * ds + 1) continue;
    gr = Math.max(gr, Math.abs(r[j] - r[i]) / (step * ds)); gg = Math.max(gg, Math.abs(g[j] - g[i]) / (step * ds));
  }
  const rng = a => Math.max(...a) - Math.min(...a);
  console.log(`${id}: ${label} range ${rng(r).toFixed(1)} m, max ${(step * ds).toFixed(0)} m grade ${(gr * 100).toFixed(1)} % | game range ${rng(g).toFixed(1)} m, grade ${(gg * 100).toFixed(1)} % | ` +
    `difference after the mean offset: rms ${Math.sqrt(rms / m).toFixed(2)} m, max ${mx.toFixed(2)} m at s=${mxAt.toFixed(0)}`);
}
