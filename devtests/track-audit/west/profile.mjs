// node devtests/track-audit/west/profile.mjs <id>[:variant] <source> [--covered wayId,wayId,...] [--step 5]
// Real elevation profile along the OSM reference centreline (res/osm-loop-<id>[-variant].json), compared with the game's
// heights at the same places (each OSM sample projected on the game centreline).
//   source ignalti : IGN RGE ALTI (France / Monaco; 1-5 m lidar bare earth) through the Geoplateforme API (net.mjs, cached)
//   source mdt05   : IGN Espana MDT05 (5 m, from PNOA lidar) GeoTIFF from the INSPIRE WCS (cache/ign-es/<id>-mdt05.tif),
//                    bilinear; the WCS serves whole metres, so the profile is median + Gaussian cleaned like the others.
// --covered: OSM ways (tunnels, bridges) on which the terrain model does not see the road: the real profile is taken
// straight between the heights just outside their ends (as tools/build-tracks.mjs COVERED does).
// Writes res/profile-<id>[-variant]-<source>.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, CACHE, ignAlti } from './net.mjs';
import { loadGame, gameArrays, loadOverpass, resample, cumLen, nearestOn, grades, gradeRuns, cleanProfile, r } from './lib-audit.mjs';
import { readTiff } from '../be-nl-de-gb/tiff.mjs';

const args = process.argv.slice(2);
const arg = args[0], source = args[1];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const coveredWays = (opt('--covered', '') || '').split(',').filter(Boolean);
const coveredCache = opt('--covered-cache', null);
const step = +opt('--step', 5);
const id = arg.split(':')[0], label = arg.replace(':', '-');
const g = loadGame(id), A = gameArrays(g);
const O = JSON.parse(readFileSync(resolve(HERE, 'res', 'osm-loop-' + label + '.json'), 'utf8'));
const oXY = O.loop.map(([la, lo]) => A.proj.to(la, lo));
const R = resample(oXY, step, true), ds = R.ds, M = R.pts.length;
const LL = R.pts.map((p) => A.proj.from(p.x, p.y));

let raw;
if (source === 'ignalti') raw = await ignAlti(LL);
else if (source === 'mdt05') {
  const t = readTiff(readFileSync(resolve(CACHE, 'ign-es', id + '-mdt05.tif')));
  const [sx, sy] = t.scale, x0 = t.tie[3], y0 = t.tie[4];
  const at = (c, rr) => t.data[Math.max(0, Math.min(t.h - 1, rr)) * t.w + Math.max(0, Math.min(t.w - 1, c))];
  raw = LL.map(([la, lo]) => {
    const fx = (lo - x0) / sx - 0.5, fy = (y0 - la) / sy - 0.5, c = Math.floor(fx), rr = Math.floor(fy), u = fx - c, v = fy - rr;
    return at(c, rr) * (1 - u) * (1 - v) + at(c + 1, rr) * u * (1 - v) + at(c, rr + 1) * (1 - u) * v + at(c + 1, rr + 1) * u * v;
  });
} else throw new Error('unknown source ' + source);

// covered stretches (OSM ways): samples within 6 m of the way's polyline
const covered = new Array(M).fill(false), coveredNotes = [];
if (coveredWays.length) {
  const J = loadOverpass(coveredCache || id + '-tunnels-bridges');
  for (const wid of coveredWays) {
    const e = J.elements.find((q) => String(q.id) === wid);
    if (!e) { console.warn('covered way not in cache', wid); continue; }
    const W = e.geometry.map((p) => A.proj.to(p.lat, p.lon)), wc = cumLen(W, false);
    let n = 0, s0 = Infinity, s1 = -Infinity;
    R.pts.forEach((p, i) => { if (nearestOn(W, wc, p.x, p.y, false).d < 6) { covered[i] = true; n++; s0 = Math.min(s0, p.s); s1 = Math.max(s1, p.s); } });
    coveredNotes.push({ way: +wid, name: (e.tags || {}).name, tunnel: (e.tags || {}).tunnel, bridge: (e.tags || {}).bridge, samples: n, osmS: [r(s0, 0), r(s1, 0)] });
  }
}
const h = raw.map((v) => (v === null || !Number.isFinite(v) ? NaN : v));
// fill no-data and covered stretches linearly (closed loop), from 2 samples beyond
const bad = h.map((v, i) => !Number.isFinite(v) || covered[i]);
for (let i = 0; i < M; i++) {
  if (!bad[i]) continue;
  let a = i, b = i, da = 0, db = 0;
  while (bad[(a + M) % M] && da < M) { a--; da++; }
  while (bad[b % M] && db < M) { b++; db++; }
  const pa = (a - 1 + M) % M, pb = (b + 1) % M;   // one sample further out (portal / abutment)
  const ya = Math.min(h[(a + M) % M], Number.isFinite(h[pa]) ? h[pa] : Infinity), yb = Math.min(h[b % M], Number.isFinite(h[pb]) ? h[pb] : Infinity);
  h[i] = ya + (yb - ya) * da / (da + db);
}
const clean = cleanProfile(h, ds, 10, 10);
// game heights at the same places
const gc = cumLen(A.xy, true);
const gs = [], gy = [], gd = [];
for (const p of R.pts) {
  const q = nearestOn(A.xy, gc, p.x, p.y, true);
  const i = Math.round(q.s / A.ds) % A.N;
  gs.push(q.s); gy.push(A.y[i]); gd.push(q.d);
}
const diff = clean.map((v, i) => v - gy[i]);
const off = diff.slice().sort((a, b) => a - b)[Math.floor(M / 2)];
const res = diff.map((v) => v - off);
let worst = { v: 0 };
res.forEach((v, i) => { if (Math.abs(v) > Math.abs(worst.v)) worst = { v, i }; });
// 100 m grade differences > 2 percentage points
const k = Math.round(100 / ds), gradeDiff = [];
for (let i = 0; i < M; i++) {
  const j = (i + k) % M, gr = (clean[j] - clean[i]) / (k * ds) * 100, gg = (gy[j] - gy[i]) / (k * ds) * 100;
  gradeDiff.push({ i, gr, gg, d: gg - gr });
}
const runs = [];
let cur = null;
for (const q of gradeDiff) {
  if (Math.abs(q.d) > 2) {
    if (cur && Math.sign(q.d) === cur.sign && q.i === cur.to + 1) { cur.to = q.i; if (Math.abs(q.d) > Math.abs(cur.worst.d)) cur.worst = q; }
    else { if (cur) runs.push(cur); cur = { from: q.i, to: q.i, sign: Math.sign(q.d), worst: q }; }
  } else if (cur) { runs.push(cur); cur = null; }
}
if (cur) runs.push(cur);
const S5 = R.pts.map((p, i) => ({ lat: LL[i][0], lon: LL[i][1] }));
const out = {
  id: label, source, step: r(ds, 3), samples: M, osmLength: r(R.total, 1), covered: coveredNotes,
  rawMinASL: r(Math.min(...h), 1), rawMaxASL: r(Math.max(...h), 1),
  realRange: r(Math.max(...clean) - Math.min(...clean), 1), realMinAtOsmS: r(clean.indexOf(Math.min(...clean)) * ds, 0), realMaxAtOsmS: r(clean.indexOf(Math.max(...clean)) * ds, 0),
  realMinAtGameS: r(gs[clean.indexOf(Math.min(...clean))], 0), realMaxAtGameS: r(gs[clean.indexOf(Math.max(...clean))], 0),
  gameRange: r(Math.max(...A.y) - Math.min(...A.y), 1), gameRangeOnOsm: r(Math.max(...gy) - Math.min(...gy), 1),
  residualRms: r(Math.sqrt(res.reduce((a, v) => a + v * v, 0) / M), 2), residualMax: r(worst.v, 1), residualMaxAtGameS: r(gs[worst.i], 0),
  real: { g20: grades(clean, ds, 20, S5), g50: grades(clean, ds, 50, S5), g100: grades(clean, ds, 100, S5), runs100_4pct: gradeRuns(clean, ds, 100, 4) },
  gameOnOsm: { g50: grades(gy, ds, 50, S5), g100: grades(gy, ds, 100, S5) },
  gradeDiffRuns100: runs.filter((q) => (q.to - q.from + 1) * ds >= 10).map((q) => ({ fromGameS: r(gs[q.from], 0), toGameS: r(gs[(q.to + k) % M], 0),
    worstGamePct: r(q.worst.gg, 1), worstRealPct: r(q.worst.gr, 1), at: [+LL[q.worst.i][0].toFixed(6), +LL[q.worst.i][1].toFixed(6)] })),
  profile: { ds: r(ds, 3), osmS: R.pts.map((p) => r(p.s, 1)), gameS: gs.map((v) => r(v, 1)), raw: h.map((v) => r(v, 2)), real: clean.map((v) => r(v, 2)),
    game: gy.map((v) => r(v + off, 2)), lateral: gd.map((v) => r(v, 1)) },
};
// relative heights (lowest point = 0) for both, as a ready override profile on the OSM line
writeFileSync(resolve(HERE, 'res', `profile-${label}-${source}.json`), JSON.stringify(out));
const { profile, ...brief } = out;
console.log(JSON.stringify(brief));
