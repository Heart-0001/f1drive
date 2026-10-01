// node devtests/track-fix/check-v62.js [tracks-data.js] [--before <old tracks-data.js>]
// The 2026-10-01 track-audit corrections (docs/track-audit.md section 2, tools/build-tracks.mjs) measured on the tracks as
// js/track.js builds them: the elevation features the audit names (grades over 20 / 50 / 100 m, rises and drops), the
// start lines, lengths, banking, Baku's width, the Suzuka bridge, the pit limits. Feature windows are given as metres of
// the OLD lap (the build before the corrections, devtests/track-fix/cache/tracks-data.before-v62.js) and mapped through
// lat / lon onto the new lap, so moved start lines do not shift them. Prints a table and ends with
// "all v6.2 track checks passed" or "FAILED n" (exit code).
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const bi = args.indexOf('--before');
const BEFORE = bi >= 0 ? path.resolve(args[bi + 1]) : path.join(__dirname, 'cache', 'tracks-data.before-v62.js');
const NEWF = path.resolve(args.find((a, i) => !a.startsWith('--') && (bi < 0 || i !== bi + 1)) || path.join(ROOT, 'tracks-data.js'));

global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
function loadTracks(file) { const w = {}; new Function('window', fs.readFileSync(file, 'utf8'))(w); return w.F1_TRACKS; }
// the old lap: the cache copy, else tracks-data.js of commit c50dc5a (the last one before the corrections)
function loadOld() {
  if (fs.existsSync(BEFORE)) return loadTracks(BEFORE);
  try {
    const src = require('child_process').execSync('git show c50dc5a:tracks-data.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    const w = {}; new Function('window', src)(w); return w.F1_TRACKS;
  } catch (e) { console.log('(no old tracks-data.js: feature windows taken as fractions of the new lap)'); return null; }
}
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
const NEW = loadTracks(NEWF), OLD = loadOld();
const built = {};
const td = (id) => NEW.find((t) => t.id === id);
const tr = (id) => built[id] || (built[id] = F1.buildTrack(td(id)));

let fails = 0;
const rows = [];
function check(ok, id, what, val) { if (!ok) fails++; rows.push(`${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(8)} ${what.padEnd(58)} ${val}`); }

// old-lap metres -> lat / lon (through the old geo) -> sample of the new build
function oldSToIndex(id, s) {
  const o = OLD && OLD.find((t) => t.id === id), t = td(id), T = tr(id);
  if (!o) return Math.round(s / T.length * T.samples.length) % T.samples.length;
  const P = o.points, n = P.length;
  let acc = 0, L = 0;
  for (let i = 0; i < n; i++) L += Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]);
  s = ((s % L) + L) % L;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + l >= s) {
      const f = (s - acc) / (l || 1), x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
      const lon = x / o.geo.kx + o.geo.lon0, lat = z / o.geo.kz + o.geo.lat0;
      return T.nearest((lon - t.geo.lon0) * t.geo.kx, (lat - t.geo.lat0) * t.geo.kz).index;
    }
    acc += l;
  }
  return 0;
}
// steepest climb / fall over w metres within samples a..b (racing direction), and the height change a -> b
function win(id, s0, s1, w) {
  const T = tr(id), S = T.samples, N = S.length, ds = T.length / N, a = oldSToIndex(id, s0), b = oldSToIndex(id, s1);
  const k = Math.max(1, Math.round(w / ds));
  let up = -Infinity, dn = Infinity, hi = -Infinity, lo = Infinity;
  for (let i = a; i !== b; i = (i + 1) % N) {
    const g = (S[(i + k) % N].y - S[i].y) / (k * ds);
    up = Math.max(up, g); dn = Math.min(dn, g); hi = Math.max(hi, S[i].y); lo = Math.min(lo, S[i].y);
  }
  return { up: up * 100, dn: dn * 100, rise: S[b].y - S[a].y, hi, lo, a, b };
}
function lapStats(id) {
  const T = tr(id), S = T.samples, N = S.length, ds = T.length / N, out = {};
  const ys = S.map((s) => s.y);
  out.range = Math.max(...ys) - Math.min(...ys);
  for (const w of [50, 100]) {
    const k = Math.round(w / ds);
    let up = -Infinity, dn = Infinity;
    for (let i = 0; i < N; i++) { const g = (S[(i + k) % N].y - S[i].y) / (k * ds); up = Math.max(up, g); dn = Math.min(dn, g); }
    out['up' + w] = up * 100; out['dn' + w] = dn * 100;
  }
  out.hiS = S[ys.indexOf(Math.max(...ys))].s;
  return out;
}
const f1 = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);

// ---- Spa (Wallonia lidar): Raidillon 14-15 %, Kemmel 4-5 %, Paul Frere -> Bus Stop no canopy hump, range ~102
{
  const r = win('be-1925', 800, 1250, 50), r20 = win('be-1925', 800, 1250, 20), k = win('be-1925', 1300, 2000, 100), pf = win('be-1925', 4900, 6700, 100);
  const L = lapStats('be-1925');
  check(r.up >= 13 && r.up <= 16.5, 'be-1925', 'Raidillon steepest 50 m (lidar 14.3-14.8 %)', f1(r.up) + ' % (20 m ' + f1(r20.up) + ' %)');
  check(k.up >= 3 && k.up <= 6.5, 'be-1925', 'Kemmel straight steepest 100 m (lidar 4.3-4.8 %)', f1(k.up) + ' %');
  check(pf.up <= 5, 'be-1925', 'Paul Frere -> Blanchimont steepest 100 m climb (lidar <= 3.5 %)', f1(pf.up) + ' %');
  check(L.range > 96 && L.range < 108, 'be-1925', 'range (en.wikipedia 102.2 m)', L.range.toFixed(1) + ' m');
}
// ---- Imola (Emilia-Romagna lidar)
{
  const pa = win('it-1953', 2200, 2850, 100), av = win('it-1953', 2850, 3350, 50), rv = win('it-1953', 3700, 4300, 100), L = lapStats('it-1953');
  check(pa.rise < -15, 'it-1953', 'Piratella -> Acque Minerali drop (lidar -21.2 m, game had -9)', f1(pa.rise) + ' m, steepest ' + f1(pa.dn) + ' %');
  check(rv.dn > -8.5 && rv.dn < -5, 'it-1953', 'Rivazza steepest 100 m (lidar -6.9 %, game had -10.7)', f1(rv.dn) + ' %, drop ' + f1(rv.rise) + ' m');
  check(L.range > 30 && L.range < 38, 'it-1953', 'range (lidar 34.3 m)', L.range.toFixed(1) + ' m, Acque Minerali climb ' + f1(av.up) + ' %/50 m');
}
// ---- Mugello (Tuscany lidar DSM): San Donato uphill
{
  const r = win('it-1914', 450, 900, 100), L = lapStats('it-1914');
  check(r.rise > 9, 'it-1914', 'San Donato s 450 -> 900 (lidar +12.9 m, game had -3.5)', f1(r.rise) + ' m');
  check(L.range > 35 && L.range < 48, 'it-1914', 'range (lidar DSM 42.7 m)', L.range.toFixed(1) + ' m');
}
// ---- Monza (TINITALY + the dip under the old banking)
{
  const L = lapStats('it-1922'), d = win('it-1922', 2900, 3700, 100);
  check(L.range < 17, 'it-1922', 'range (TINITALY 12 m + 5 m dip; game had 22.4)', L.range.toFixed(1) + ' m');
  check(d.hi - d.lo > 3.5 && d.hi - d.lo < 7, 'it-1922', 'dip between Lesmo 2 and Ascari (~5 m)', (d.hi - d.lo).toFixed(1) + ' m, ' + f1(d.dn) + ' / ' + f1(d.up) + ' %');
}
// ---- Barcelona (IGN MDT05): no crest at T3, no dip at T4
{
  const r = win('es-1991', 900, 1300, 100), L = lapStats('es-1991');
  check(r.dn > -2, 'es-1991', 'T3 -> T4 (s 900-1300) steepest fall (lidar: climbs; game had -5.8 m)', f1(r.dn) + ' %, rise ' + f1(r.rise) + ' m');
  check(L.range > 26 && L.range < 33, 'es-1991', 'range (lidar 29.9 m)', L.range.toFixed(1) + ' m');
}
// ---- Madring (IGN MDT05): T6-T7 climb ~7 %, range ~26, the main straight flat
{
  const L = lapStats('es-2026'), c = win('es-2026', 1300, 1800, 100), ms = win('es-2026', 5100, 5450, 100);
  check(L.range > 22 && L.range < 30, 'es-2026', 'range (official 26 m, lidar 25.8)', L.range.toFixed(1) + ' m');
  check(c.up > 5.5 && c.up < 9, 'es-2026', 'climb to T7 steepest 100 m (official "8 %", lidar 7.2)', f1(c.up) + ' %');
  check(Math.abs(ms.up) < 2.5 && Math.abs(ms.dn) < 2.5, 'es-2026', 'end of the main straight flat (game had +4.2 %)', f1(ms.up) + ' / ' + f1(ms.dn) + ' %');
  check(Math.abs(td('es-2026').lengthKm - 5.414) < 0.002, 'es-2026', 'length 5.414 km', td('es-2026').lengthKm + ' km');
}
// ---- Miami (USGS lidar, off the flat list): the T13-T16 ramp
{
  const L = lapStats('us-2022');
  check(L.up50 > 3 && L.up50 < 7, 'us-2022', 'steepest 50 m climb (lidar 4.4-5.5 %)', f1(L.up50) + ' %, range ' + L.range.toFixed(1) + ' m');
}
// ---- Interlagos (GLO-30)
{
  const dl = win('br-1940', 1389, 1629, 100), bp = win('br-1940', 2500, 2650, 100), st = win('br-1940', 4150, 4300, 100), L = lapStats('br-1940');
  check(dl.dn < -3, 'br-1940', 'Descida do Lago s 1389-1629 (GLO-30 -4.9 %, game had +0.4)', f1(dl.dn) + ' %');
  check(bp.up < 7.5, 'br-1940', 'Bico de Pato s 2500-2650 climb (GLO-30 +4.6, game had +10.6)', f1(bp.up) + ' %');
  check(st.up > 2.5, 'br-1940', 'start straight s 4150-4300 climbs (GLO-30 +5.2, game had -0.7)', f1(st.up) + ' %');
  check(L.dn100 < -9, 'br-1940', 'S do Senna steepest 100 m (GLO-30 -11.4 %)', f1(L.dn100) + ' %, range ' + L.range.toFixed(1) + ' m');
}
// ---- Portimao (GLO-30): falls ~10-12 %, climbs <= ~7 %
{
  const L = lapStats('pt-2008');
  check(L.dn50 < -8.5, 'pt-2008', 'steepest 50 m fall (published 12 %, GLO-30 -10.7)', f1(L.dn50) + ' %');
  check(L.up100 <= 7.5, 'pt-2008', 'steepest 100 m climb (published 6.2 %, cap ~7)', f1(L.up100) + ' %, range ' + L.range.toFixed(1) + ' m');
}
// ---- Sepang (GLO-30 low envelope): the top at T10 / T11, not on the back straight
{
  const T = tr('my-1999'), S = T.samples, N = S.length, ys = S.map((s) => s.y), top = ys.indexOf(Math.max(...ys));
  const t11 = oldSToIndex('my-1999', 3192), d = Math.min(Math.abs(top - t11), N - Math.abs(top - t11)) * T.length / N;
  check(d < 250, 'my-1999', 'highest point near T10 / T11 (old s 3192)', d.toFixed(0) + ' m away, range ' + (Math.max(...ys) - Math.min(...ys)).toFixed(1) + ' m');
}
// ---- start lines
for (const [id, ll, lim] of [['gb-1948', [52.0682609, -1.0234867], 3], ['hu-1986', [47.5789212, 19.2483897], 3],
  ['my-1999', [2.7607601, 101.7383513], 3], ['cn-2004', [31.3372693, 121.2205226], 3], ['mc-1929', [43.7350269, 7.4212652], 3]]) {
  const t = td(id), x = (ll[1] - t.geo.lon0) * t.geo.kx, z = (ll[0] - t.geo.lat0) * t.geo.kz;
  const d = Math.hypot(t.points[0][0] - x, t.points[0][1] - z);
  check(d < lim, id, 'points[0] at the real line', d.toFixed(1) + ' m');
}
// ---- pits
for (const [id, side, lims] of [['gb-1948', -1, { 2026: 80 }], ['nl-1948', null, { 2021: 60, 2024: 60, 2025: 80 }],
  ['sg-2008', null, { 2012: 60, 2024: 60, 2025: 80 }], ['ru-2014', null, { 2014: 60, 2021: 60 }], ['mc-1929', -1, { 2010: 60, 2026: 60 }]]) {
  const p = tr(id).pit;
  check(!!p, id, 'pit lane exists', p ? 'side ' + p.side + ', ' + p.limitKmh + ' km/h' : 'none');
  if (!p) continue;
  if (side) check(p.side === side, id, 'pit side', String(p.side));
  for (const [y, v] of Object.entries(lims)) check(p.limitFor(+y) === v, id, 'pit limit ' + y, p.limitFor(+y) + ' km/h');
}
// ---- Baku castle width
{
  const t = td('az-2016'), T = tr('az-2016'), S = T.samples;
  const hw = S.map((s) => s.halfW), narrow = hw.filter((h) => h < 3.81).length * T.length / S.length;
  // (the audit's ends: T8 apex -> T12 exit, ~200 m; the old game's 14 m road there was gameS 2560-2800)
  check(narrow > 150 && narrow < 400, 'az-2016', 'castle section at 7.6 m', narrow.toFixed(0) + ' m of road at half width 3.8 (' + JSON.stringify(t.widthOverrides.map((o) => [o.from, o.to])) + ')');
}
// ---- banking: derived cap, published / lidar bankings
{
  const D = 180 / Math.PI;
  let worst = 0, at = '';
  for (const t of NEW) {
    const S = tr(t.id).samples, N = S.length, cap = (t.bankMaxDeg || 2.5), mask = new Uint8Array(N);
    for (const o of t.bankOverrides || []) {
      const ia = Math.round(o.from * N), ib = Math.round(o.to * N), len = ((ib - ia) % N + N) % N;
      for (let v = -30; v <= len + 30; v++) mask[((ia + v) % N + N) % N] = 1;
    }
    for (let i = 0; i < N; i++) if (!mask[i] && Math.abs(S[i].bank) * D - cap > worst) { worst = Math.abs(S[i].bank) * D - cap; at = t.id + ' ' + i; }
  }
  check(worst <= 0.01, 'all', 'derived banking within its cap (2.5, street 1.5 deg)', worst.toFixed(3) + ' deg over' + (at ? ' at ' + at : ''));
  for (const [id, name, deg] of [['nl-1948', 'T3 Hugenholtzbocht', 19], ['nl-1948', 'T14 Arie Luyendijkbocht', 18], ['nl-1948', 'T1 Tarzanbocht', 6.5],
    ['nl-1948', 'T7 Scheivlak', 5], ['es-2026', 'T12 La Monumental', 13.5], ['sa-2021', 'T13', 12], ['us-1909', 'T13 (oval turn 1)', 9.2],
    ['it-1914', "T8 Curva dell'Arrabbiata 1", 5.1], ['be-1925', 'Kemmel', 4], ['be-1925', 'Blanchimont', 4], ['us-1956', 'The Ninety', 6]]) {
    const t = td(id), o = (t.bankOverrides || []).find((b) => b.name === name), T = tr(id), S = T.samples, N = S.length;
    if (!o) { check(false, id, 'bank ' + name, 'missing'); continue; }
    const ia = Math.round(o.from * N), ib = Math.round(o.to * N), mid = (ia + (((ib - ia) % N + N) % N >> 1)) % N;
    check(Math.abs(Math.abs(S[mid].bank) * D - deg) < 0.2, id, 'bank ' + name + ' (' + deg + ' deg)', (Math.abs(S[mid].bank) * D).toFixed(2) + ' deg');
  }
}
// ---- Suzuka bridge
{
  const T = tr('jp-1962'), B = T.bridges && T.bridges[0];
  check(!!B && B.separation >= 5.8 && B.clearance >= 4.8, 'jp-1962', 'crossover: separation (GSI 6.2 m) / clearance', B ? B.separation.toFixed(2) + ' / ' + B.clearance.toFixed(2) + ' m, deck ' + B.deckLength.toFixed(0) + ' m' : 'none');
}
// ---- what changed geometry (points / geo): the scenery must be rebuilt for those
if (OLD) {
  const geoChanged = [], ptsChanged = [], rotated = [];
  for (const t of NEW) {
    const o = OLD.find((q) => q.id === t.id);
    if (!o) { geoChanged.push(t.id + ' (new)'); continue; }
    if (JSON.stringify(o.geo) !== JSON.stringify(t.geo)) geoChanged.push(t.id);
    else if (JSON.stringify(o.points) !== JSON.stringify(t.points)) {
      // same geo: a pure rotation of the loop (START_AT) keeps every vertex
      const set = new Set(o.points.map((p) => p.join(','))), extra = t.points.filter((p) => !set.has(p.join(','))).length;
      (extra <= 1 ? rotated : ptsChanged).push(t.id + (extra ? ' (+' + extra + ' vertex)' : ''));
    }
  }
  rows.push('');
  rows.push('geo changed (scenery-data.js must be rebuilt): ' + (geoChanged.join(' ') || '-'));
  rows.push('points changed, same geo: ' + (ptsChanged.join(' ') || '-'));
  rows.push('loop turned to a new start line only (same vertices, same geo): ' + (rotated.join(' ') || '-'));
}
console.log(rows.join('\n'));
console.log(fails ? '\nFAILED ' + fails : '\nall v6.2 track checks passed');
process.exit(fails ? 1 : 0);
