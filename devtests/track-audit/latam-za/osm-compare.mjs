// node devtests/track-audit/latam-za/osm-compare.mjs <id> [--exclude wayId,wayId] [--only wayId,...] [--pit wayId,...]
// Compares the game centreline (out/game-<id>.json from game-dump.js) with the OpenStreetMap raceway ways cached by
// osm-fetch.mjs (../cache/overpass/<id>.json). Everything in TRUE metres (local equirectangular projection of lat/lon,
// not the game's length-rescaled frame).
//   deviation   game sample -> nearest OSM racing-surface way (not pit lane): max / mean / p95, worst places, runs > 10 m
//   osm loop    every game sample snapped onto the nearest OSM way point: length of that loop = OSM length of the layout
//   unused      OSM raceway ways (not pit lane) whose points are > 25 m from the game line (other configurations)
//   direction   oneway=yes raceway ways: their drawing direction against the game's direction (dot of tangents)
//   start       nodes named / tagged start / finish, projected onto the game line (s from points[0], lateral offset)
//   pit         pit-lane ways: where they leave / rejoin (s of the projected ends), side (left / right of the driver)
// Writes out/osm-<id>.json (the snapped loop included, for the DEM sampling).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1].split(',').map(Number) : null; };
const EXCL = new Set(arg('--exclude') || []), ONLY = arg('--only') ? new Set(arg('--only')) : null, PITW = arg('--pit') ? new Set(arg('--pit')) : null;
const game = JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8'));
const osmFile = process.argv.includes('--osm') ? process.argv[process.argv.indexOf('--osm') + 1] : resolve(HERE, '..', 'cache', 'overpass', `${id}.json`);
const osm = JSON.parse(readFileSync(osmFile, 'utf8'));
const lat0 = game.geo.lat0, lon0 = game.geo.lon0, KX = Math.cos(lat0 * Math.PI / 180) * 111320, KN = 110540;
const P = (lat, lon) => [(lon - lon0) * KX, (lat - lat0) * KN];     // [east, north] metres
const S = game.samples, N = S.length;
const G = S.map((q) => P(q.ll[0], q.ll[1]));
// true-metre arc length of the game line
const gs = [0];
for (let i = 0; i < N; i++) gs.push(gs[i] + Math.hypot(G[(i + 1) % N][0] - G[i][0], G[(i + 1) % N][1] - G[i][1]));
const LEN = gs[N];
const tang = G.map((_, i) => { const a = G[(i - 2 + N) % N], b = G[(i + 2) % N], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; });

const isPit = (t) => PITW ? false : /pit|box/i.test(t.name || '') || /pit/i.test(t.raceway || '') || /pit/i.test(t.service || '') || t.raceway === 'pitlane' || t['pit_lane'] === 'yes';
const ways = osm.elements.filter((e) => e.type === 'way' && e.geometry && (e.tags || {}).highway === 'raceway' && !/motocross|karting|kart/i.test(e.tags.sport || ''));
const pitWays = ways.filter((w) => (PITW ? PITW.has(w.id) : isPit(w.tags)));
const mainWays = ways.filter((w) => !pitWays.includes(w) && !EXCL.has(w.id) && (!ONLY || ONLY.has(w.id)));
const segs = [];
for (const w of mainWays) {
  const g = w.geometry.map((q) => P(q.lat, q.lon));
  for (let k = 0; k + 1 < g.length; k++) segs.push({ a: g[k], b: g[k + 1], way: w.id, k });
}
function nearestSeg(p, list) {
  let best = { d: Infinity };
  for (const sg of list) {
    const ex = sg.b[0] - sg.a[0], ez = sg.b[1] - sg.a[1], l2 = ex * ex + ez * ez;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - sg.a[0]) * ex + (p[1] - sg.a[1]) * ez) / l2)) : 0;
    const x = sg.a[0] + ex * t, z = sg.a[1] + ez * t, d = Math.hypot(p[0] - x, p[1] - z);
    if (d < best.d) best = { d, x, z, way: sg.way, dir: [ex / Math.sqrt(l2 || 1), ez / Math.sqrt(l2 || 1)] };
  }
  return best;
}
// project a point on the game line: s (true metres from points[0]), signed lateral offset (+ = left of the driver)
function onGame(p) {
  let best = { d: Infinity };
  for (let i = 0; i < N; i++) {
    const a = G[i], b = G[(i + 1) % N], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / l2)) : 0;
    const x = a[0] + ex * t, z = a[1] + ez * t, d = Math.hypot(p[0] - x, p[1] - z);
    if (d < best.d) {
      const l = Math.sqrt(l2) || 1, cross = (ex / l) * (p[1] - z) - (ez / l) * (p[0] - x);   // > 0: left (east/north frame)
      best = { d, i, s: gs[i] + t * l, side: cross > 0 ? 'left' : 'right', lat: +S[i].ll[0], lon: +S[i].ll[1] };
    }
  }
  return best;
}
const r1 = (v) => Math.round(v * 10) / 10;
// --- deviation + snapped loop
const dev = new Float64Array(N), snap = [], wayUse = {};
let dirAgree = 0, dirAgainst = 0;
for (let i = 0; i < N; i++) {
  const nb = nearestSeg(G[i], segs);
  dev[i] = nb.d; snap.push([nb.x, nb.z]); wayUse[nb.way] = (wayUse[nb.way] || 0) + 1;
  const w = mainWays.find((q) => q.id === nb.way);
  if (w && w.tags.oneway === 'yes' && nb.d < 20) { const dot = nb.dir[0] * tang[i][0] + nb.dir[1] * tang[i][1]; if (dot > 0.5) dirAgree++; else if (dot < -0.5) dirAgainst++; }
}
const sorted = Array.from(dev).sort((a, b) => a - b);
const mean = sorted.reduce((a, v) => a + v, 0) / N, p95 = sorted[Math.floor(N * 0.95)], max = sorted[N - 1];
// runs above 10 m
const runs = [];
for (let i = 0, inRun = false, a = 0; i <= N; i++) {
  const on = i < N && dev[i] > 10;
  if (on && !inRun) { inRun = true; a = i; }
  if (!on && inRun) {
    inRun = false; let m = a; for (let k = a; k < i; k++) if (dev[k] > dev[m]) m = k;
    runs.push({ from_s: r1(gs[a]), to_s: r1(gs[i - 1]), length: r1(gs[i - 1] - gs[a]), max: r1(dev[m]), at_s: r1(gs[m]), at: S[m].ll });
  }
}
// snapped loop length (5 m decimation, light smoothing of the jitter between neighbouring ways)
let snapLen = 0;
{ const st = Math.max(1, Math.round(5 / game.ds)); let prev = snap[0]; for (let i = st; i <= N; i += st) { const q = snap[i % N]; snapLen += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; } }
// --- unused OSM ways
const unused = [];
for (const w of mainWays) {
  const g = w.geometry.map((q) => P(q.lat, q.lon));
  let far = 0, len = 0, maxD = 0;
  for (let k = 0; k < g.length; k++) {
    const d = onGame(g[k]).d; maxD = Math.max(maxD, d);
    if (k) { const l = Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]); len += l; if (d > 25) far += l; }
  }
  if (maxD > 25) unused.push({ way: w.id, tags: w.tags, length: r1(len), farLength: r1(far), maxDist: r1(maxD), mid: [w.geometry[w.geometry.length >> 1].lat, w.geometry[w.geometry.length >> 1].lon] });
}
// --- start / finish nodes
const starts = osm.elements.filter((e) => e.type === 'node' && e.tags && (/start|finish|largada|salida|meta|chegada/i.test(e.tags.name || '') || /start|finish/i.test(e.tags.raceway || '') || /start|finish/i.test(e.tags.highway || '')))
  .map((e) => { const o = onGame(P(e.lat, e.lon)); return { node: e.id, tags: e.tags, lat: e.lat, lon: e.lon, s: r1(o.s), sSigned: r1(o.s > LEN / 2 ? o.s - LEN : o.s), lateral: r1(o.d) }; });
// start/finish lines drawn as ways (raceway=start_finish etc.)
const startWays = osm.elements.filter((e) => e.type === 'way' && e.tags && /start|finish/i.test((e.tags.raceway || '') + (e.tags.name || '') + (e.tags.highway || '')) && e.tags.highway !== 'raceway')
  .map((e) => { const c = e.geometry[e.geometry.length >> 1]; const o = onGame(P(c.lat, c.lon)); return { way: e.id, tags: e.tags, lat: c.lat, lon: c.lon, s: r1(o.s), sSigned: r1(o.s > LEN / 2 ? o.s - LEN : o.s), lateral: r1(o.d) }; });
// --- pit lane ways
const pits = pitWays.map((w) => {
  const g = w.geometry.map((q) => P(q.lat, q.lon));
  let len = 0; for (let k = 1; k < g.length; k++) len += Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]);
  const a = onGame(g[0]), b = onGame(g[g.length - 1]);
  const sides = g.map((q) => onGame(q)).filter((o) => o.d > 6);
  const left = sides.filter((o) => o.side === 'left').length, right = sides.length - left;
  const maxOff = Math.max(0, ...g.map((q) => onGame(q).d));
  return { way: w.id, tags: w.tags, length: r1(len), first: { lat: w.geometry[0].lat, lon: w.geometry[0].lon, s: r1(a.s), off: r1(a.d) },
    last: { lat: w.geometry[w.geometry.length - 1].lat, lon: w.geometry[w.geometry.length - 1].lon, s: r1(b.s), off: r1(b.d) },
    side: left > right ? 'left' : (right > left ? 'right' : '?'), leftPts: left, rightPts: right, maxOffset: r1(maxOff) };
});
const out = {
  id, osmQuery: osm._query && { bbox: osm._query.bbox, fetched: osm._query.fetched, endpoint: osm._query.endpoint },
  gameLengthTrueM: r1(LEN), osmSnappedLoopM: r1(snapLen),
  deviation: { maxM: r1(max), meanM: r1(mean), p95M: r1(p95), runsOver10m: runs },
  waysUsed: Object.entries(wayUse).map(([w, n]) => ({ way: +w, samples: n, tags: (mainWays.find((q) => q.id === +w) || {}).tags })),
  direction: { onewaySamplesAgree: dirAgree, onewaySamplesAgainst: dirAgainst },
  unusedWays: unused, startNodes: starts, startWays, pitWays: pits,
  snapped: snap.filter((_, i) => i % Math.max(1, Math.round(5 / game.ds)) === 0).map(([x, z]) => [+(lat0 + z / KN).toFixed(7), +(lon0 + x / KX).toFixed(7)]),
};
writeFileSync(resolve(HERE, 'out', `osm-${id}.json`), JSON.stringify(out, null, 1));
console.log(`${id}: game ${r1(LEN)} m (true), OSM snapped loop ${r1(snapLen)} m; deviation max ${r1(max)} m, mean ${r1(mean)}, p95 ${r1(p95)}`);
for (const r of runs) console.log(`  > 10 m: s ${r.from_s}..${r.to_s} (${r.length} m), max ${r.max} m at s ${r.at_s} ${r.at}`);
console.log(`  direction: ${dirAgree} samples agree with oneway ways, ${dirAgainst} against`);
for (const u of unused) console.log(`  unused way ${u.way} ${u.length} m (far ${u.farLength} m, max ${u.maxDist} m) ${JSON.stringify(u.tags).slice(0, 120)} mid ${u.mid}`);
for (const s of starts) console.log(`  start/finish node ${s.node} ${JSON.stringify(s.tags)} -> s ${s.sSigned} m, ${s.lateral} m off`);
for (const s of startWays) console.log(`  start/finish way ${s.way} ${JSON.stringify(s.tags)} -> s ${s.sSigned} m, ${s.lateral} m off`);
for (const p of pits) console.log(`  pit way ${p.way} ${p.length} m ${JSON.stringify(p.tags).slice(0, 100)}: first s ${p.first.s} (off ${p.first.off}), last s ${p.last.s} (off ${p.last.off}), side ${p.side} (${p.leftPts}/${p.rightPts}), max off ${p.maxOffset}`);
