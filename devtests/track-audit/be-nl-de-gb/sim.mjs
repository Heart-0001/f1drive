// node sim.mjs <id> [step=10] [medHalf=2] [sigma=20] [maxSlope=0.18] [ySigmaM=9.8]
// What the game would get from the lidar profile (out/profile-<id>.json is smoothed; this re-reads the RAW lidar heights
// from the DEM cache at the same OSM positions) through tools/build-tracks.mjs's terrain-model pipeline (median of
// 2*medHalf+1 samples, Gauss sigma, slope limit, Gauss 1 sample) and js/track.js's extra height smoothing (8 + 40
// passes of [1,2,1]/4 on 2 m samples ~ Gauss sigma 9.8 m). Prints the max / min grades over 10 / 20 / 50 / 100 m and
// the grades at the OSM positions given in CFG[id].features.
import { readJSON, medianLoop, gaussLoop, grades, fillNulls, HERE } from './lib.mjs';
import * as DEM from './dem.mjs';
import { CFG } from './config.mjs';
import { resolve } from 'node:path';
const [id, stepA, mhA, sgA, msA, ysA] = process.argv.slice(2);
const cfg = CFG[id], P = readJSON(resolve(HERE, 'out', `profile-${id}.json`));
const raw = fillNulls(await DEM[cfg.dem](P.ll));
for (const c of cfg.covered || []) {   // as tools/build-tracks.mjs COVERED: straight between the ends
  const M0 = raw.length, a = Math.round(c.fromS / P.stepM), b = Math.round(c.toS / P.stepM), ya = raw[(a - 1 + M0) % M0], yb = raw[(b + 1) % M0];
  for (let i = a; i <= b; i++) raw[i % M0] = ya + (yb - ya) * (i - a) / (b - a);
}
const ds0 = P.stepM, step = +(stepA || 10), k = Math.max(1, Math.round(step / ds0)), ds = ds0 * k;
const h0 = raw.filter((_, i) => i % k === 0);
const slopeLimit = (h, maxStep) => h.map((_, i) => { let lo = -Infinity, hi = Infinity; const m = h.length; for (let j = 0; j < m; j++) { const d = Math.min(Math.abs(i - j), m - Math.abs(i - j)) * maxStep; lo = Math.max(lo, h[j] - d); hi = Math.min(hi, h[j] + d); } return (lo + hi) / 2; });
let h = medianLoop(h0, +(mhA || 2));
h = gaussLoop(h, +(sgA || 20) / ds);
h = slopeLimit(Array.from(h), +(msA || 0.18) * ds);
h = gaussLoop(h, 1);
const ys = +(ysA || 9.8);
const hg = ys > 0 ? gaussLoop(h, ys / ds) : h;
const rawSm = gaussLoop(medianLoop(raw, 1), 1);   // nearly raw (15 m median + 5 m gauss) for reference
const rep = (name, arr, d) => {
  const o = {};
  for (const w of [10, 20, 50, 100]) { if (w < 2 * d) continue; const g = grades(arr, d, w); o['w' + w] = [+(Math.max(...g) * 100).toFixed(1), +(Math.min(...g) * 100).toFixed(1)]; }
  return name + ' ' + JSON.stringify(o);
};
console.log(rep('lidar (15 m median, 5 m gauss)', rawSm, ds0));
console.log(rep(`pipeline step ${ds.toFixed(1)} med ${2 * (+(mhA || 2)) + 1} sigma ${sgA || 20} + track.js ${ys}`, hg, ds));
for (const f of cfg.features || []) {
  const a = Math.round(f.from / ds), b = Math.round(f.to / ds), a0 = Math.round(f.from / ds0), b0 = Math.round(f.to / ds0);
  const g50 = grades(hg, ds, 50), r50 = grades(rawSm, ds0, 50), g20 = grades(hg, ds, 20), r20 = grades(rawSm, ds0, 20);
  let gm = -9, rm = -9, gn = 9, rn = 9, gm20 = -9, rm20 = -9, gn20 = 9, rn20 = 9;
  for (let i = a; i <= b; i++) { gm = Math.max(gm, g50[i]); gn = Math.min(gn, g50[i]); gm20 = Math.max(gm20, g20[i]); gn20 = Math.min(gn20, g20[i]); }
  for (let i = a0; i <= b0; i++) { rm = Math.max(rm, r50[i]); rn = Math.min(rn, r50[i]); rm20 = Math.max(rm20, r20[i]); rn20 = Math.min(rn20, r20[i]); }
  console.log(`  ${f.name} (osm ${f.from}-${f.to}): lidar max/min 20 m ${(rm20 * 100).toFixed(1)}/${(rn20 * 100).toFixed(1)} %, 50 m ${(rm * 100).toFixed(1)}/${(rn * 100).toFixed(1)} %; pipeline 20 m ${(gm20 * 100).toFixed(1)}/${(gn20 * 100).toFixed(1)} %, 50 m ${(gm * 100).toFixed(1)}/${(gn * 100).toFixed(1)} %; rise lidar ${(rawSm[b0] - rawSm[a0]).toFixed(1)} m, pipeline ${(hg[b] - hg[a]).toFixed(1)} m`);
}
// RMS / max difference of the pipeline result vs the near-raw lidar, on the pipeline grid
{
  const ref = rawSm.filter((_, i) => i % k === 0), n = Math.min(ref.length, hg.length);
  const off = ref.slice(0, n).reduce((a, v, i) => a + v - hg[i], 0) / n;
  let ss = 0, mx = 0; for (let i = 0; i < n; i++) { const d = hg[i] + off - ref[i]; ss += d * d; mx = Math.max(mx, Math.abs(d)); }
  console.log(`pipeline vs lidar: RMS ${Math.sqrt(ss / n).toFixed(2)} m, max ${mx.toFixed(2)} m; range ${(Math.max(...hg) - Math.min(...hg)).toFixed(1)} m`);
}
