// node devtests/track-audit/east/elev-game.mjs [id ...]
// Height profile along the GAME centreline (tracks-data points, original lat/lon through geo) from independent models,
// against the game's driven heights (js/track.js samples, out/game-<id>.json):
//   - Copernicus GLO-30 (30 m, the full-resolution sibling of the GLO-90 the game was built from; AWS Open Data;
//     cache/glo30/east-<id>.json; not published for Azerbaijan -> none for Baku), every 10 m, bilinear;
//   - SRTM 30 m (2000 radar; devtests/track-fix/cache/otd-srtm30m.json, 25 m along the same points; BEFORE Portimao
//     (2008), Istanbul Park (2005) and Sochi (2014) were built: earthworks are not in it);
//   - Copernicus GLO-90 raw (tools/elevation-cache.json: what the game's profile was smoothed from).
// Output: out/elev-game-<id>.json + a summary on stdout.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDS, ROOT, EAST, game, projector, medianLoop, gaussLoop, minLoop, fillNull, gradeWindows, steepStretches, corr, range, r1, r2 } from './core.mjs';
import { sampleGrid } from './glo30.mjs';

const glo90 = JSON.parse(readFileSync(resolve(ROOT, 'tools', 'elevation-cache.json'), 'utf8'));
const srtm = JSON.parse(readFileSync(resolve(ROOT, 'devtests', 'track-fix', 'cache', 'otd-srtm30m.json'), 'utf8'));

export function gameProfile(G, step = 10) {
  const S = G.samples, N = S.length, ds = G.builtLength / N, k = Math.max(1, Math.round(step / ds));
  const idx = []; for (let i = 0; i < N; i += k) idx.push(i);
  return { idx, ds: k * ds, s: idx.map((i) => S[i].s), lat: idx.map((i) => S[i].lat), lon: idx.map((i) => S[i].lon), y: idx.map((i) => S[i].y) };
}
// values of a "lat,lon"-keyed cache that lie on the game centreline (<= 12 m), mapped to the profile's indices
function cacheOnProfile(cache, G, P) {
  const pr = projector(G.geo.lat0, G.geo.lon0), XY = P.lat.map((la, i) => pr.f(la, P.lon[i]));
  let s = 90, w = 180, n = -90, e = -180;
  for (let i = 0; i < P.lat.length; i++) { s = Math.min(s, P.lat[i]); n = Math.max(n, P.lat[i]); w = Math.min(w, P.lon[i]); e = Math.max(e, P.lon[i]); }
  const pts = [];
  for (const [key, v] of Object.entries(cache)) {
    const [la, lo] = key.split(',').map(Number);
    if (la < s - 0.001 || la > n + 0.001 || lo < w - 0.001 || lo > e + 0.001 || v === null) continue;
    const [x, y] = pr.f(la, lo);
    let bi = -1, bd = 12;
    for (let i = 0; i < XY.length; i++) { const d = Math.hypot(XY[i][0] - x, XY[i][1] - y); if (d < bd) { bd = d; bi = i; } }
    if (bi >= 0) pts.push([bi, v]);
  }
  if (pts.length < 30) return null;
  // linear interpolation around the loop onto every profile index
  pts.sort((a, b) => a[0] - b[0]);
  const m = P.lat.length, out = new Array(m).fill(null);
  for (const [i, v] of pts) out[i] = out[i] === null ? v : (out[i] + v) / 2;
  return { values: fillNull(out), n: pts.length };
}

export function stats(h, P, label) {
  const sAt = (i) => P.s[i], llAt = (i) => [+P.lat[i].toFixed(6), +P.lon[i].toFixed(6)];
  const lo = h.indexOf(Math.min(...h)), hi = h.indexOf(Math.max(...h));
  return { label, rangeM: r1(range(h)), lowest: { s: Math.round(P.s[lo]), m: r1(h[lo]), ll: llAt(lo) }, highest: { s: Math.round(P.s[hi]), m: r1(h[hi]), ll: llAt(hi) },
    grade50: gradeWindows(h, P.ds, 50, sAt, llAt), grade100: gradeWindows(h, P.ds, 100, sAt, llAt) };
}

export async function elevGame(id) {
  const G = game(id), P = gameProfile(G, 10), m = P.s.length, out = { id, along: 'game centreline (tracks-data points)', stepM: r2(P.ds) };
  out.game = stats(P.y, P, 'game (js/track.js sample heights)');
  out.game.steep = steepStretches(P.y, P.ds, 100, 0.05, (i) => P.s[i]);
  const f = resolve(ROOT, 'devtests', 'track-audit', 'cache', 'glo30', `east-${id}.json`);
  const series = { game: P.y };
  if (existsSync(f)) {
    const g30 = JSON.parse(readFileSync(f, 'utf8'));
    const raw = fillNull(P.lat.map((la, i) => sampleGrid(g30, la, P.lon[i])));
    const clean = gaussLoop(medianLoop(raw, 2), 20 / P.ds);          // median 50 m + Gauss sigma 20 m (as the build's DTM path)
    const floor = gaussLoop(minLoop(raw, 4), 20 / P.ds);              // lower envelope (90 m window): grandstands / buildings out
    out.glo30 = Object.assign(stats(clean, P, 'GLO-30 cleaned (median 50 m + Gauss 20 m)'), { rawRangeM: r1(range(raw)), absMin: r1(Math.min(...clean)), absMax: r1(Math.max(...clean)) });
    out.glo30.steep = steepStretches(clean, P.ds, 100, 0.05, (i) => P.s[i]);
    out.glo30floor = stats(floor, P, 'GLO-30 lower envelope (min 90 m + Gauss 20 m)');
    series.glo30 = clean; series.glo30floor = floor;
  }
  const s30 = cacheOnProfile(srtm, G, P);
  if (s30) {
    const clean = gaussLoop(medianLoop(s30.values, 5), 20 / P.ds);
    out.srtm30 = Object.assign(stats(clean, P, 'SRTM 30 m (2000), median 110 m + Gauss 20 m'), { samples: s30.n, absMin: r1(Math.min(...clean)), absMax: r1(Math.max(...clean)) });
    series.srtm30 = clean;
  }
  const g90 = cacheOnProfile(glo90, G, P);
  if (g90) { out.glo90raw = Object.assign(stats(g90.values, P, 'GLO-90 raw (the game\'s input), linear between 25 m samples'), { samples: g90.n }); series.glo90raw = g90.values; }
  // shape agreement with the game (relative heights)
  out.compare = {};
  for (const [k, v] of Object.entries(series)) {
    if (k === 'game') continue;
    const mg = P.y.reduce((a, b) => a + b, 0) / m, mv = v.reduce((a, b) => a + b, 0) / m;
    let rms = 0, worst = { d: 0 };
    for (let i = 0; i < m; i++) { const d = (P.y[i] - mg) - (v[i] - mv); rms += d * d; if (Math.abs(d) > Math.abs(worst.d)) worst = { d, i }; }
    out.compare[k] = { corr: r2(corr(P.y, v)), rmsM: r1(Math.sqrt(rms / m)), worst: { dM: r1(worst.d), s: Math.round(P.s[worst.i]), ll: [+P.lat[worst.i].toFixed(6), +P.lon[worst.i].toFixed(6)] } };
  }
  // profile every 50 m for the report
  const every = Math.round(50 / P.ds);
  out.profile50 = [];
  for (let i = 0; i < m; i += every) {
    const row = { s: Math.round(P.s[i]), lat: +P.lat[i].toFixed(6), lon: +P.lon[i].toFixed(6) };
    for (const [k, v] of Object.entries(series)) row[k] = r1(v[i]);
    out.profile50.push(row);
  }
  out._series = series; out._P = P;
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(EAST, 'elev-game.mjs')) {
  for (const id of (process.argv.slice(2).length ? process.argv.slice(2) : IDS)) {
    const o = await elevGame(id);
    const { _series, _P, ...save } = o;
    writeFileSync(resolve(EAST, 'out', `elev-game-${id}.json`), JSON.stringify(save, null, 1));
    const line = (x) => x ? `range ${x.rangeM} m  climb50 ${x.grade50.climb.pct}% @${x.grade50.climb.fromS}  desc50 ${x.grade50.descent.pct}% @${x.grade50.descent.fromS}  climb100 ${x.grade100.climb.pct}% @${x.grade100.climb.fromS}  desc100 ${x.grade100.descent.pct}% @${x.grade100.descent.fromS}  low@${x.lowest.s} high@${x.highest.s}` : '-';
    console.log('==', id);
    for (const k of ['game', 'glo30', 'glo30floor', 'srtm30', 'glo90raw']) if (o[k]) console.log(' ', k.padEnd(10), line(o[k]), o[k].absMin !== undefined ? `abs ${o[k].absMin}..${o[k].absMax}` : '');
    console.log('  compare', JSON.stringify(o.compare));
  }
}
