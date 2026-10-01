// node devtests/track-audit/east/elev-osm.mjs [id ...]
// Height profile along the OpenStreetMap centreline (out/osm-<id>.json loop, started at the foot of the game's line):
// Copernicus GLO-30 every 10 m (bilinear; cleaned = median 50 m + Gauss sigma 20 m) and, where cached, OpenTopoData
// datasets (cache/opentopodata/<dataset>/east-<id>.json, 50 m along the same loop), against the game height at the
// same place (nearest game sample). Output out/elev-osm-<id>.json.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDS, ROOT, EAST, game, projector, resampleLoop, cumLoop, medianLoop, gaussLoop, minLoop, fillNull, steepStretches, corr, range, r1, r2 } from './core.mjs';
import { sampleGrid } from './glo30.mjs';
import { stats } from './elev-game.mjs';

export function osmProfile(id, step = 10) {
  const G = game(id), O = JSON.parse(readFileSync(resolve(EAST, 'out', `osm-${id}.json`), 'utf8'));
  const pr = projector(G.geo.lat0, G.geo.lon0);
  const L = O.osmLoopLL.map(([la, lo]) => pr.f(la, lo));
  // rotate so that the loop starts at the foot of the game's start
  const cum = cumLoop(L), s0 = O.osmLoopStartTrueS;
  let k0 = 0; while (k0 < L.length - 1 && cum[k0 + 1] <= s0) k0++;
  const Lr = L.slice(k0 + 1).concat(L.slice(0, k0 + 1));
  const a = L[k0], b = L[(k0 + 1) % L.length], t = (s0 - cum[k0]) / ((cum[k0 + 1] - cum[k0]) || 1);
  Lr.unshift([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  const R = resampleLoop(Lr, step);
  const ll = R.pts.map((p) => pr.inv(p[0], p[1]));
  // game height at each point: nearest game sample
  const GP = G.samples.map((q) => pr.f(q.lat, q.lon));
  const gy = R.pts.map((p) => { let bi = 0, bd = Infinity; for (let i = 0; i < GP.length; i++) { const d = (GP[i][0] - p[0]) ** 2 + (GP[i][1] - p[1]) ** 2; if (d < bd) { bd = d; bi = i; } } return G.samples[bi].y; });
  return { G, O, R, ll, P: { s: R.s, lat: ll.map((q) => q[0]), lon: ll.map((q) => q[1]), ds: R.ds, y: gy } };
}

export async function elevOsm(id) {
  const { R, P } = osmProfile(id, 10);
  const out = { id, along: 'OpenStreetMap centreline (osm-compare loop), s from the foot of the game start line', lengthM: Math.round(R.total), stepM: r2(R.ds) };
  const series = { game: P.y };
  out.game = stats(P.y, P, 'game height at the same place');
  const f = resolve(ROOT, 'devtests', 'track-audit', 'cache', 'glo30', `east-${id}.json`);
  if (existsSync(f)) {
    const g30 = JSON.parse(readFileSync(f, 'utf8'));
    const raw = fillNull(P.lat.map((la, i) => sampleGrid(g30, la, P.lon[i])));
    const clean = gaussLoop(medianLoop(raw, 2), 20 / P.ds);
    const floor = gaussLoop(minLoop(raw, 4), 20 / P.ds);
    out.glo30 = Object.assign(stats(clean, P, 'Copernicus GLO-30, median 50 m + Gauss 20 m'), { rawRangeM: r1(range(raw)), absMin: r1(Math.min(...clean)), absMax: r1(Math.max(...clean)) });
    out.glo30.steep5pct100m = steepStretches(clean, P.ds, 100, 0.05, (i) => P.s[i]);
    out.glo30floor = stats(floor, P, 'GLO-30 lower envelope (min 90 m + Gauss 20 m)');
    series.glo30 = clean; series.glo30raw = raw; series.glo30floor = floor;
  }
  for (const ds of ['eudem25m', 'srtm30m', 'aster30m']) {
    const cf = resolve(ROOT, 'devtests', 'track-audit', 'cache', 'opentopodata', ds, `east-${id}.json`);
    if (!existsSync(cf)) continue;
    const c = JSON.parse(readFileSync(cf, 'utf8'));          // {step, values[] every `step` m along the same loop}
    const v = P.s.map((sv) => { const j = sv / c.step, a = Math.floor(j) % c.values.length, b = (a + 1) % c.values.length, t = j - Math.floor(j); return c.values[a] == null || c.values[b] == null ? null : c.values[a] + (c.values[b] - c.values[a]) * t; });
    const clean = gaussLoop(fillNull(v), 20 / P.ds);
    out[ds] = Object.assign(stats(clean, P, `OpenTopoData ${ds} every ${c.step} m, linear + Gauss 20 m`), { absMin: r1(Math.min(...clean)), absMax: r1(Math.max(...clean)) });
    series[ds] = clean;
  }
  out.game.steep5pct100m = steepStretches(P.y, P.ds, 100, 0.05, (i) => P.s[i]);
  out.compare = {};
  const m = P.s.length;
  for (const [k, v] of Object.entries(series)) {
    if (k === 'game' || k === 'glo30raw') continue;
    const mg = P.y.reduce((a, b) => a + b, 0) / m, mv = v.reduce((a, b) => a + b, 0) / m;
    let rms = 0, worst = { d: 0, i: 0 };
    for (let i = 0; i < m; i++) { const d = (P.y[i] - mg) - (v[i] - mv); rms += d * d; if (Math.abs(d) > Math.abs(worst.d)) worst = { d, i }; }
    out.compare[k] = { corr: r2(corr(P.y, v)), rmsM: r1(Math.sqrt(rms / m)), worstGameMinusDem: { dM: r1(worst.d), s: Math.round(P.s[worst.i]), ll: [+P.lat[worst.i].toFixed(6), +P.lon[worst.i].toFixed(6)] } };
  }
  const every = Math.round(50 / P.ds);
  out.profile50 = [];
  for (let i = 0; i < m; i += every) {
    const row = { s: Math.round(P.s[i]), lat: +P.lat[i].toFixed(6), lon: +P.lon[i].toFixed(6) };
    for (const [k, v] of Object.entries(series)) if (k !== 'glo30raw') row[k] = r1(v[i]);
    out.profile50.push(row);
  }
  out._series = series; out._P = P;
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(EAST, 'elev-osm.mjs')) {
  for (const id of (process.argv.slice(2).length ? process.argv.slice(2) : IDS)) {
    if (!existsSync(resolve(EAST, 'out', `osm-${id}.json`))) { console.log(id, 'no osm loop yet'); continue; }
    const o = await elevOsm(id);
    const { _series, _P, ...save } = o;
    writeFileSync(resolve(EAST, 'out', `elev-osm-${id}.json`), JSON.stringify(save, null, 1));
    const line = (x) => x ? `range ${x.rangeM} m  climb50 ${x.grade50.climb.pct}% @${x.grade50.climb.fromS}  desc50 ${x.grade50.descent.pct}% @${x.grade50.descent.fromS}  climb100 ${x.grade100.climb.pct}% @${x.grade100.climb.fromS}  desc100 ${x.grade100.descent.pct}% @${x.grade100.descent.fromS}  low@${x.lowest.s} high@${x.highest.s}` : '-';
    console.log('==', id, 'osm loop', o.lengthM, 'm');
    for (const k of ['game', 'glo30', 'glo30floor', 'eudem25m', 'srtm30m', 'aster30m']) if (o[k]) console.log(' ', k.padEnd(10), line(o[k]), o[k].absMin !== undefined ? `abs ${o[k].absMin}..${o[k].absMax}` : '');
    console.log('  compare', JSON.stringify(o.compare));
  }
}
