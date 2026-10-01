// Shared analysis helpers for the west-European track audit (resumed run): game-side summaries (grades, banking,
// radii), OSM loop assembly, centreline deviation, DEM profile processing and comparison.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, CACHE } from './net.mjs';
import { projector, cumLen, resample, nearestOn, gradeExtremes, median, gauss } from './geo.mjs';

export function loadGame(id) {
  return JSON.parse(readFileSync(resolve(HERE, 'out', 'game-' + id + '.json'), 'utf8'));
}
export function loadOverpass(name) {
  const f = resolve(CACHE, 'overpass', name + '.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}
export const r = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// Game samples -> uniform arrays + projector (local metres around the circuit's geo origin).
export function gameArrays(g) {
  const proj = projector(g.geo.lat0, g.geo.lon0);
  const S = g.samples, N = S.length;
  const xy = S.map((s) => proj.to(s.lat, s.lon));
  const y = S.map((s) => s.y), bank = S.map((s) => s.bank), k = S.map((s) => s.k), sArr = S.map((s) => s.s);
  return { proj, S, N, xy, y, bank, k, s: sArr, ds: g.ds, L: g.builtLength };
}

// Max climb / descent over windows (closed loop); returns {up:{g%, s0, s1, lat, lon}, dn:{...}}.
export function grades(h, ds, win, S, closed = true) {
  const e = gradeExtremes(h, ds, win, closed);
  const pack = (q) => ({ pct: r(q.g * 100, 1), fromS: r(q.i * ds, 0), toS: r(q.j * ds, 0),
    at: S ? [S[q.i].lat, S[q.i].lon] : undefined, rise: r(h[q.j] - h[q.i], 1) });
  return { win: r(e.win, 0), maxClimb: pack(e.up), maxDescent: pack(e.dn) };
}

// All local climbs / descents above a threshold grade over a window: list of {fromS, toS, pct}.
export function gradeRuns(h, ds, win, minPct) {
  const m = h.length, k = Math.max(1, Math.round(win / ds)), g = [];
  for (let i = 0; i < m; i++) g.push((h[(i + k) % m] - h[i]) / (k * ds) * 100);
  const runs = [];
  let cur = null;
  for (let i = 0; i < m; i++) {
    const sig = g[i] >= minPct ? 1 : g[i] <= -minPct ? -1 : 0;
    if (sig && cur && cur.sig === sig) { cur.to = i; if (Math.abs(g[i]) > Math.abs(cur.peak)) cur.peak = g[i]; }
    else { if (cur) runs.push(cur); cur = sig ? { sig, from: i, to: i, peak: g[i] } : null; }
  }
  if (cur) runs.push(cur);
  return runs.map((q) => ({ fromS: r(q.from * ds, 0), toS: r(q.to * ds + win, 0), peakPct: r(q.peak, 1) }));
}

// Sections where |bank| exceeds minDeg: [{fromS, toS, peakDeg, sign}]
export function bankSections(bank, ds, minDeg) {
  const out = [];
  let cur = null;
  for (let i = 0; i < bank.length; i++) {
    const a = Math.abs(bank[i]);
    if (a >= minDeg) {
      if (!cur) cur = { from: i, to: i, peak: bank[i] };
      cur.to = i; if (a > Math.abs(cur.peak)) cur.peak = bank[i];
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((q) => ({ fromS: r(q.from * ds, 0), toS: r(q.to * ds, 0), lenM: r((q.to - q.from + 1) * ds, 0), peakDeg: r(q.peak, 2) }));
}

// Minimum radii: local minima of 1/|k| below maxR, merged within 30 m.
export function tightCorners(k, ds, maxR, S) {
  const N = k.length, out = [];
  for (let i = 0; i < N; i++) {
    const a = Math.abs(k[i]);
    if (a < 1 / maxR) continue;
    let isMax = true;
    for (let j = -15; j <= 15; j++) if (Math.abs(k[(i + j + N) % N]) > a) { isMax = false; break; }
    if (isMax) out.push({ s: r(i * ds, 0), radiusM: r(1 / a, 1), dir: k[i] > 0 ? 'L' : 'R', at: S ? [S[i].lat, S[i].lon] : undefined });
  }
  return out;
}

// Signed curvature of a uniformly resampled closed polyline (points {x, y}), over +-w samples.
export function curvature(P, ds, w = 3) {
  const N = P.length;
  return P.map((_, i) => {
    const a = P[(i - w + N) % N], b = P[i], c = P[(i + w) % N];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x), t2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = t2 - t1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    return d / (w * ds);
  });
}

// Deviation of the game's centreline from a reference loop (both [[x, y]] local metres).
export function deviation(gameXY, refLoop, gameS) {
  const c = cumLen(refLoop, true);
  let max = { d: -1 }, sum = 0, n = 0;
  const d = [];
  for (let i = 0; i < gameXY.length; i++) {
    const q = nearestOn(refLoop, c, gameXY[i][0], gameXY[i][1], true);
    d.push(q.d); sum += q.d; n++;
    if (q.d > max.d) max = { d: q.d, i };
  }
  const sorted = d.slice().sort((a, b) => a - b);
  return { meanM: r(sum / n, 2), p50M: r(sorted[Math.floor(n * 0.5)], 2), p95M: r(sorted[Math.floor(n * 0.95)], 2), maxM: r(max.d, 1),
    maxAtS: gameS ? r(gameS[max.i], 0) : max.i, perSample: d };
}

// Runs of samples where the deviation exceeds thr metres: [{fromS, toS, maxM}]
export function deviationRuns(d, sArr, thr) {
  const out = [];
  let cur = null;
  for (let i = 0; i < d.length; i++) {
    if (d[i] > thr) { if (!cur) cur = { from: i, to: i, max: d[i] }; cur.to = i; cur.max = Math.max(cur.max, d[i]); }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((q) => ({ fromS: r(sArr[q.from], 0), toS: r(sArr[q.to], 0), maxM: r(q.max, 1) }));
}

// Light cleaning of a lidar / DTM profile sampled every ds metres (closed): median (kerbs, drains, verges) + gauss.
export function cleanProfile(h, ds, medHalfM = 10, sigmaM = 10) {
  const half = Math.max(1, Math.round(medHalfM / ds));
  return gauss(median(h, half), Math.max(0.5, sigmaM / ds));
}

export { projector, cumLen, resample, nearestOn, gradeExtremes, median, gauss };
