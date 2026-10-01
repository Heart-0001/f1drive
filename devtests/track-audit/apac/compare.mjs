// node devtests/track-audit/apac/compare.mjs <id> <demSource> [mode]  -- the game's built height profile vs a DEM profile along the OSM
// centreline (both on a common 10 m grid of game arc length from the start line). mode:
//   dtm      bare-earth lidar: median 50 m + Gaussian sigma 20 m (what tools/build-tracks.mjs does for terrain models)
//   dsm      surface model (trees / buildings / grandstands / viaducts stand on the road): rolling 20th percentile over 150 m
//            (the road is the lower envelope), then median 50 m + Gaussian sigma 40 m
//   dsmflat  as dsm with a 300 m percentile window and sigma 80 m (street / park circuits where the road is lined with trees /
//            buildings: only the broad shape survives)
// Prints / returns: ranges, high / low points, steepest climbs and descents (50 m / 100 m windows), correlation, RMS difference
// of the shapes, and the stretches where the 100 m grade differs by more than 2 percentage points.
import { resolve } from 'node:path';
import { HERE, readJSON, track } from './common.mjs';
import { profStats } from './gameprof.mjs';

const med = (h, half) => h.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(h[((i + j) % h.length + h.length) % h.length]); w.sort((a, b) => a - b); return w[half]; });
const pct = (h, half, q) => h.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(h[((i + j) % h.length + h.length) % h.length]); w.sort((a, b) => a - b); return w[Math.floor(q * (w.length - 1))]; });
const gauss = (h, sig) => { const m = h.length, r = Math.min(Math.ceil(sig * 3), Math.floor((m - 1) / 2)), k = []; let sum = 0; for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sig) ** 2); k.push(v); sum += v; } return h.map((_, i) => { let a = 0; for (let j = -r; j <= r; j++) a += k[j + r] * h[((i + j) % m + m) % m]; return a / sum; }); };
function fill(h) { const m = h.length, ok = h.map((v) => v !== null && Number.isFinite(v)); return h.map((v, i) => { if (ok[i]) return v; let a = i, b = i, da = 0, db = 0; while (!ok[a]) { a = (a - 1 + m) % m; da++; } while (!ok[b]) { b = (b + 1) % m; db++; } return h[a] + (h[b] - h[a]) * da / (da + db); }); }
// periodic linear interpolation of (s, v) samples onto a grid
function regrid(S, V, L, step) { const n = Math.round(L / step), out = []; let j = 0; for (let k = 0; k < n; k++) { const s = k * L / n; while (j < S.length - 1 && S[j + 1] <= s) j++; const s0 = S[j], s1 = j + 1 < S.length ? S[j + 1] : L + S[0], v1 = j + 1 < S.length ? V[j + 1] : V[0]; const f = (s - s0) / ((s1 - s0) || 1); out.push(V[j] + (v1 - V[j]) * f); } return { h: out, ds: L / n }; }

export function compare(id, src, mode = 'dtm', opts = {}) {
  const t = track(id), L = t.lengthKm * 1000;
  const game = readJSON(resolve(HERE, 'out', 'game-' + id + '.json'));
  const dem = readJSON(resolve(HERE, 'out', 'dem-' + id + '-' + src + '.json'));
  const sc = L / dem.total;
  let raw = fill(dem.profile.map((p) => p.h));
  const dsDem = dem.ds * sc, n = (m) => Math.max(1, Math.round(m / dsDem));
  if (opts.preprocess) raw = opts.preprocess(raw, dem);
  let f;
  if (mode === 'dtm') f = gauss(med(raw, n(25)), 20 / dsDem);
  else if (mode === 'dsm') f = gauss(med(pct(raw, n(75), 0.2), n(25)), 40 / dsDem);
  else f = gauss(med(pct(raw, n(150), 0.2), n(25)), 80 / dsDem);
  const G = regrid(game.samples.map((s) => s.s), game.samples.map((s) => s.y), L, 10);
  const D = regrid(dem.profile.map((p) => p.s * sc), f, L, 10);
  const Draw = regrid(dem.profile.map((p) => p.s * sc), raw, L, 10);
  const gs = profStats(G.h, G.ds), dsx = profStats(D.h, D.ds);
  const mg = G.h.reduce((a, b) => a + b, 0) / G.h.length, md = D.h.reduce((a, b) => a + b, 0) / D.h.length;
  let sxy = 0, sxx = 0, syy = 0, se = 0;
  G.h.forEach((g, i) => { const a = g - mg, b = D.h[i] - md; sxy += a * b; sxx += a * a; syy += b * b; se += (a - b) ** 2; });
  const corr = sxy / Math.sqrt(sxx * syy), rms = Math.sqrt(se / G.h.length);
  // 100 m grade differences
  const k = Math.round(100 / G.ds), m = G.h.length, diffs = [];
  for (let i = 0; i < m; i++) diffs.push({ s: (i + k / 2) * G.ds % L, g: (G.h[(i + k) % m] - G.h[i]) / 100 * 100, d: (D.h[(i + k) % m] - D.h[i]) / 100 * 100 });
  const runs = []; let cur = null;
  for (const q of diffs) { const e = q.g - q.d; if (Math.abs(e) > 2) { if (!cur || Math.sign(e) !== cur.sign) { cur = { from: q.s, sign: Math.sign(e), worst: 0 }; runs.push(cur); } cur.to = q.s; if (Math.abs(e) > Math.abs(cur.worst)) { cur.worst = e; cur.at = q.s; cur.game = q.g; cur.dem = q.d; } } else cur = null; }
  const fmt = (v) => +v.toFixed(2);
  return { id, demSource: src, mode, demSourceLabel: dem.source, lengthScale: fmt(sc),
    game: gs, dem: dsx, demRawRange: fmt(Math.max(...raw) - Math.min(...raw)), shapeCorrelation: fmt(corr), shapeRmsDiff: fmt(rms),
    gradeDiffOver2pp: runs.map((r) => ({ fromS: Math.round(r.from), toS: Math.round(r.to), atS: Math.round(r.at), game100: fmt(r.game), dem100: fmt(r.dem), diffPP: fmt(r.worst) })),
    grid: { ds: fmt(G.ds), game: G.h.map(fmt), dem: D.h.map((v) => fmt(v - Math.min(...D.h))), demRaw: Draw.h.map((v) => fmt(v - Math.min(...Draw.h))) } };
}
if (process.argv[1] && process.argv[1].endsWith('compare.mjs')) {
  const r = compare(process.argv[2], process.argv[3], process.argv[4] || 'dtm');
  const { grid, ...rest } = r;
  console.log(JSON.stringify(rest, null, 1));
}
