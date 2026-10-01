// node devtests/track-audit/west/raw-vs-game.mjs <id> <cacheFile> [label]
// The DEM samples the build itself used (tools/elevation-cache-*.json, keyed "lat,lon" on the dataset centreline,
// read-only) against the game's built heights at the same places: how much the build's cleaning (median + Gaussian +
// 18 % slope limit) changed the profile, and the raw model's own range / grades. No network.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, ROOT } from './net.mjs';
import { loadGame, gameArrays, grades, r, cleanProfile } from './lib-audit.mjs';

const [id, cacheArg, label = 'raw'] = process.argv.slice(2);
const g = loadGame(id), A = gameArrays(g);
const cache = JSON.parse(readFileSync(resolve(ROOT, cacheArg), 'utf8'));
let s0 = 90, n0 = -90, w0 = 180, e0 = -180;
for (const s of A.S) { s0 = Math.min(s0, s.lat); n0 = Math.max(n0, s.lat); w0 = Math.min(w0, s.lon); e0 = Math.max(e0, s.lon); }
const pad = 0.002;
const pts = [];
for (const [k, v] of Object.entries(cache)) {
  const [la, lo] = k.split(',').map(Number);
  if (la < s0 - pad || la > n0 + pad || lo < w0 - pad || lo > e0 + pad || v === null) continue;
  const [x, y] = A.proj.to(la, lo);
  let best = Infinity, bi = 0;
  for (let i = 0; i < A.N; i++) { const d = (A.xy[i][0] - x) ** 2 + (A.xy[i][1] - y) ** 2; if (d < best) { best = d; bi = i; } }
  if (Math.sqrt(best) > 15) continue;
  pts.push({ s: A.s[bi], i: bi, h: v, gy: A.y[bi], d: Math.sqrt(best) });
}
pts.sort((a, b) => a.s - b.s);
// resample the raw heights on a uniform 10 m grid along s (linear between the sorted samples, periodic)
const L = A.L, step = 10, m = Math.round(L / step), ds = L / m, raw = [], gy = [];
for (let k = 0, j = 0; k < m; k++) {
  const s = k * ds;
  while (j < pts.length - 1 && pts[j + 1].s <= s) j++;
  const a = pts[j], b = pts[(j + 1) % pts.length];
  const span = ((b.s - a.s) + L) % L || L, t = (((s - a.s) + L) % L) / span;
  raw.push(a.h + (b.h - a.h) * Math.min(1, t));
  gy.push(A.y[Math.round(s / A.ds) % A.N]);
}
const clean = cleanProfile(raw, ds, 10, 10);
const diff = clean.map((v, i) => v - gy[i]);
const off = diff.slice().sort((a, b) => a - b)[Math.floor(diff.length / 2)];
const res = diff.map((v) => v - off);
let worst = { v: 0 };
res.forEach((v, i) => { if (Math.abs(v) > Math.abs(worst.v)) worst = { v, s: i * ds }; });
const rms = Math.sqrt(res.reduce((a, v) => a + v * v, 0) / res.length);
const S10 = clean.map((_, i) => A.S[Math.round(i * ds / A.ds) % A.N]);
const out = {
  id, source: cacheArg, samples: pts.length, meanLateralM: r(pts.reduce((a, p) => a + p.d, 0) / pts.length, 1),
  rawRange: r(Math.max(...raw) - Math.min(...raw), 1), cleanRange: r(Math.max(...clean) - Math.min(...clean), 1),
  rawMinASL: r(Math.min(...raw), 1), rawMaxASL: r(Math.max(...raw), 1),
  rawMinAtS: r(raw.indexOf(Math.min(...raw)) * ds, 0), rawMaxAtS: r(raw.indexOf(Math.max(...raw)) * ds, 0),
  gameRange: r(Math.max(...A.y) - Math.min(...A.y), 1),
  residualRms: r(rms, 2), residualMax: r(worst.v, 1), residualMaxAtS: r(worst.s, 0),
  clean: { g50: grades(clean, ds, 50, S10), g100: grades(clean, ds, 100, S10) },
  game: { g50: grades(gy, ds, 50, S10), g100: grades(gy, ds, 100, S10) },
  profile10m: { ds: r(ds, 3), raw: raw.map((v) => r(v, 2)), clean: clean.map((v) => r(v, 2)), game: gy.map((v) => r(v, 2)) },
};
writeFileSync(resolve(HERE, 'res', `${label}-vs-game-${id}.json`), JSON.stringify(out));
const { profile10m, ...brief } = out;
console.log(JSON.stringify(brief));
