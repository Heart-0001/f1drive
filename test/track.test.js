// node test/track.test.js — js/track.js on the real data (tracks-data.js + scenery-data.js): where the start / finish
// line and the pit lane are, the pit speed limit, and the terrain beside banked corners (final review W1 / W2 / W3).
'use strict';
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
const TRACKS = global.F1_TRACKS, SCENERY = global.F1_SCENERY;

let failed = 0;
function test(name, fn) {
  try { const note = fn(); console.log('ok   ' + name + (note ? '  ' + note : '')); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
}
const built = {};
function track(id) { return built[id] || (built[id] = F1.buildTrack(TRACKS.find(t => t.id === id))); }
const median = a => { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
const toXZ = (td, lat, lon) => [(lon - td.geo.lon0) * td.geo.kx, (lat - td.geo.lat0) * td.geo.kz];

test('Monaco starts at the real line on Boulevard Albert 1er (OpenStreetMap node 4937755860), not at Casino Square', () => {
  const td = TRACKS.find(t => t.id === 'mc-1929'), p = toXZ(td, 43.7350269, 7.4212652);
  const d = Math.hypot(td.points[0][0] - p[0], td.points[0][1] - p[1]);
  assert(d < 2, 'points[0] is ' + d.toFixed(1) + ' m from the line');
  const lo = Math.min(...td.elev), hi = Math.max(...td.elev);
  assert(td.elev[0] - lo < 5 && hi - lo > 35, 'line at harbour level: elev[0] ' + td.elev[0] + ' of ' + lo + '..' + hi);
  const tr = track('mc-1929'), S = tr.samples, N = S.length, ds = tr.length / N;
  let g = 0;
  for (const b of tr.grid) g = Math.max(g, Math.abs(S[b.index].grade));
  assert(g < 0.01, 'grid on the flat straight: steepest box ' + (g * 100).toFixed(1) + ' %');
  return 'line ' + d.toFixed(1) + ' m from the OSM node, y ' + S[0].y.toFixed(1) + ' m, grid max grade ' + (g * 100).toFixed(1) + ' %, lap ' + (N * ds).toFixed(0) + ' m';
});

// Mugello: its only 'pit' footprint in scenery-data.js stands 135 m off the circuit 2.4 km into the lap (not the pit
// building); points[0] is on the main straight at the circuit's published coordinates (43.9975 N, 11.3714 E).
const NO_PIT_AT_LINE = new Set(['it-1914']);
test('every track with OSM pit buildings has its start / finish line beside them (points[0] within 300 m of one)', () => {
  let n = 0;
  for (const td of TRACKS) {
    const bs = ((SCENERY[td.id] || {}).buildings || []).filter(b => b.k === 'pit' && b.p && b.p.length >= 3);
    if (!bs.length || NO_PIT_AT_LINE.has(td.id)) continue;
    n++;
    const d = Math.min(...bs.map(b => Math.hypot(b.p.reduce((s, q) => s + q[0], 0) / b.p.length - td.points[0][0],
      b.p.reduce((s, q) => s + q[1], 0) / b.p.length - td.points[0][1])));
    assert(d < 300, td.id + ': nearest pit building ' + d.toFixed(0) + ' m from points[0]');
  }
  return n + ' tracks';
});

test('pit lane: the real side and limit (Monaco harbour side 60 km/h, Singapore 60, Zandvoort 80, the rest 80), lines either side of the start line', () => {
  const rows = [];
  for (const td of TRACKS) {
    const tr = track(td.id), p = tr.pit, N = tr.samples.length, sig = i => (i > N / 2 ? i - N : i);
    assert(p, td.id + ': no pit lane');
    const want = { 'mc-1929': 60, 'sg-2008': 60 }[td.id] || 80;
    assert.strictEqual(p.limitKmh, want, td.id + ' limit');
    assert(sig(p.entry) < 0 && sig(p.exit) > 0, td.id + ': entry ' + sig(p.entry) + ' / exit ' + sig(p.exit) + ' samples from the line');
    if (td.pitSide) assert.strictEqual(p.side, td.pitSide, td.id + ' side');
    if (td.id === 'mc-1929' || td.id === 'nl-1948') rows.push(td.id + ' side ' + p.side + ' ' + p.limitKmh + ' km/h lane ' + (2 * p.laneHalfW) + ' m');
  }
  assert.strictEqual(track('mc-1929').pit.side, -1, 'Monaco: harbour side = the right going north to Sainte Devote');
  return rows.join(', ');
});

// Banked corners (> 8 deg): ground 1 m outside the wall, below the wall's foot, on the high (outer) and low side.
function bankGaps(id) {
  const tr = track(id), S = tr.samples, N = S.length, out = { high: [], low: [] };
  for (let i = 0; i < N; i++) {
    const s = S[i];
    if (Math.abs(s.bank) < 8 * Math.PI / 180) continue;
    for (const sg of [1, -1]) {
      if (!(sg > 0 ? s.wallPos : s.wallNeg)) continue;
      const wo = (sg > 0 ? s.wallPosDist : s.wallNegDist) + 0.5, foot = tr.surfaceY(i, sg * wo);
      const far = tr.nearest(s.x + s.nx * sg * (wo + 30), s.z + s.nz * sg * (wo + 30));
      if (Math.min(Math.abs(far.index - i), N - Math.abs(far.index - i)) > 20) continue;   // another road within ~30 m
      const x = s.x + s.nx * sg * (wo + 1), z = s.z + s.nz * sg * (wo + 1);
      out[sg * s.bank > 0 ? 'high' : 'low'].push(foot - tr.terrainY(x, z));
    }
  }
  return out;
}
test('terrain: behind the outer wall of the real bankings the ground stays near the top of the banking (no 3-5 m drop)', () => {
  const notes = [];
  for (const id of ['nl-1948', 'es-2026', 'sa-2021', 'us-1909']) {
    const g = bankGaps(id), hi = median(g.high), lo = median(g.low);
    assert(g.high.length > 50 && g.low.length > 50, id + ': banked samples');
    assert(hi < 1.3, id + ': median drop behind the high side ' + hi.toFixed(2) + ' m');
    assert(lo < 1.0, id + ': median drop behind the low side ' + lo.toFixed(2) + ' m');
    notes.push(id + ' ' + hi.toFixed(2) + ' / ' + lo.toFixed(2) + ' m');
  }
  return 'median high / low side: ' + notes.join(', ');
});

test('terrain never above the road, runoff or pit lane (25 offsets wall to wall at every sample and half-sample, every track)', () => {
  let worst = Infinity, at = '', pts = 0;
  for (const td of TRACKS) {
    const tr = track(td.id), S = tr.samples, N = S.length;
    for (let i = 0; i < N; i++) {
      const s = S[i], t = S[(i + 1) % N];
      for (const h of [0, 0.5]) {
        const x0 = s.x + (t.x - s.x) * h, z0 = s.z + (t.z - s.z) * h;
        const lo = -(Math.min(s.wallNegDist, t.wallNegDist) - 0.05), hi = Math.min(s.wallPosDist, t.wallPosDist) - 0.05;
        for (let k = 0; k <= 24; k++) {
          const d = lo + (hi - lo) * k / 24, x = x0 + s.nx * d, z = z0 + s.nz * d;
          const y = tr.surfaceY(i, d) + (tr.surfaceY(i + 1, d) - tr.surfaceY(i, d)) * h, m = y - tr.terrainY(x, z);
          pts++;
          if (m < worst) { worst = m; at = td.id + ' sample ' + (i + h) + ' d ' + d.toFixed(1); }
        }
      }
    }
  }
  assert(worst > 0.05, 'terrain only ' + worst.toFixed(3) + ' m under the surface at ' + at);
  return pts + ' points, closest ' + worst.toFixed(3) + ' m (' + at + ')';
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall track tests passed');
process.exit(failed ? 1 : 0);
