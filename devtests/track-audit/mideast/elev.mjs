// Elevation along the OpenStreetMap centreline: Copernicus GLO-30 (and SRTM 30 m from the track-fix cache along the
// game centreline, where present), against the game's heights (js/track.js samples, which is what the car drives on).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glo30Window, sampleGrid } from './glo30.mjs';
import { BBOX } from './overpass.mjs';
import { resampleLoop, nearestOnLoop, gradeWindows, medianLoop, gaussLoop, corr, r1, r2, ROOT } from './core.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));

// L = layoutAudit() result. Returns the comparison and the profiles (10 m).
export async function elevAudit(id, L, opts = {}) {
  const step = 10, O = L._O, pr = L._pr, tr = L._tr, f0 = L._f0;
  const g30 = await glo30Window(id, BBOX[id]);
  const R = resampleLoop(O, step), n = R.pts.length, total = R.total;
  // rotate so that index 0 = OSM foot of the game's start
  const k0 = Math.round(f0.s / R.ds) % n;
  const pts = R.pts.slice(k0).concat(R.pts.slice(0, k0)), s = pts.map((_, i) => i * R.ds);
  const ll = pts.map((p) => pr.inv(p[0], p[1]));
  const raw = ll.map(([la, lo]) => sampleGrid(g30, la, lo));
  // light cleaning that keeps 30 m-scale features: median of 5 (50 m) + Gauss sigma 20 m (as the build's DTM path)
  const clean = gaussLoop(medianLoop(raw, 2), 20 / R.ds);
  // game height at the same place: nearest game sample (y = js/track.js height)
  const S = L._S, gameY = pts.map((p) => tr.samples[nearestOnLoop(S, p[0], p[1]).i % tr.samples.length].y);
  const min = (a) => Math.min(...a), max = (a) => Math.max(...a);
  const rel = (a) => { const m = min(a); return a.map((v) => v - m); };
  const g = rel(gameY), c = rel(clean);
  const meanDiff = g.reduce((a, v, i) => a + v - c[i], 0) / n;
  let worst = { d: 0 };
  g.forEach((v, i) => { const d = v - c[i] - meanDiff; if (Math.abs(d) > Math.abs(worst.d)) worst = { d, s: s[i] }; });
  const at = (arr, fn) => { const v = fn(arr), i = arr.indexOf(v); return { m: r1(v), s: Math.round(s[i]), ll: ll[i].map((x) => +x.toFixed(6)) }; };
  // SRTM 30 m (2000 radar: BEFORE these circuits were built) from devtests/track-fix/cache, along the game centreline
  let srtm = null;
  const sf = resolve(ROOT, 'devtests', 'track-fix', 'cache', 'otd-srtm30m.json');
  if (existsSync(sf)) {
    const c = JSON.parse(readFileSync(sf, 'utf8')), td = L._td;
    const vals = [];
    for (const [k, v] of Object.entries(c)) {
      const [la, lo] = k.split(',').map(Number), [la0, lo0, la1, lo1] = [BBOX[id][0], BBOX[id][1], BBOX[id][2], BBOX[id][3]];
      if (la > la0 && la < la1 && lo > lo0 && lo < lo1 && v !== null) {
        const p = pr.f(la, lo), q = nearestOnLoop(O, p[0], p[1], f0.cum);
        if (q.d < 15) vals.push([((q.s - f0.s) % total + total) % total, v]);
      }
    }
    if (vals.length > 50) { vals.sort((a, b) => a[0] - b[0]); const hv = medianLoop(vals.map((v) => v[1]), 2); srtm = { samples: vals.length, rangeM: r1(max(hv) - min(hv)), source: 'devtests/track-fix/cache/otd-srtm30m.json (OpenTopoData srtm30m, 25 m along the game centreline), 125 m median' }; }
  }
  return {
    source: 'Copernicus DEM GLO-30 (AWS Open Data COG ' + g30.source + '), bilinear, every ' + r1(R.ds) + ' m along the OSM centreline; cleaned = median 50 m + Gauss sigma 20 m',
    glo30: { rawRangeM: r1(max(raw) - min(raw)), cleanRangeM: r1(max(clean) - min(clean)), lowest: at(clean, min), highest: at(clean, max),
      absLowestM: r1(min(clean)), absHighestM: r1(max(clean)), grade50: gradeWindows(s, clean, total, 50), grade100: gradeWindows(s, clean, total, 100) },
    game: { rangeM: r1(max(gameY) - min(gameY)), lowest: at(g, min), highest: at(g, max), grade50: gradeWindows(s, gameY, total, 50), grade100: gradeWindows(s, gameY, total, 100) },
    compare: { correlation: r2(corr(g, c)), rmsAfterOffsetM: r2(Math.sqrt(g.reduce((a, v, i) => a + (v - c[i] - meanDiff) ** 2, 0) / n)), worstDiffM: r1(worst.d), worstAtS: Math.round(worst.s) },
    srtm30AlongGameLine: srtm,
    profile: { stepM: r2(R.ds), note: 's = metres from the game start (OSM foot of points[0]); heights relative to their own lowest point',
      glo30: c.map(r1), game: g.map(r1), glo30RawAbs: raw.map(r1) },
    _s: s, _clean: clean, _game: gameY, _ll: ll,
  };
}
