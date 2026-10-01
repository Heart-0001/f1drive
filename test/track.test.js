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
// Silverstone: since 2026-10-01 the line is at the Wing (2011+); scenery-data.js still tags the old National pits as
// 'pit' (the Wing is a 'building' 63 m from the line) until tools/build-scenery.mjs retags it (pitSide -1 is given).
const NO_PIT_AT_LINE = new Set(['it-1914', 'gb-1948']);
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

test('pit lane: the real side and limit (Monaco harbour side 60 km/h, Sochi 60, Silverstone right, the rest 80 in the current season), lines either side of the start line', () => {
  const rows = [];
  for (const td of TRACKS) {
    const tr = track(td.id), p = tr.pit, N = tr.samples.length, sig = i => (i > N / 2 ? i - N : i);
    assert(p, td.id + ': no pit lane');
    const want = { 'mc-1929': 60, 'ru-2014': 60 }[td.id] || 80;
    assert.strictEqual(p.limitKmh, want, td.id + ' limit');
    assert.strictEqual(p.limitFor(2026), want, td.id + ' limit 2026');
    assert(sig(p.entry) < 0 && sig(p.exit) > 0, td.id + ': entry ' + sig(p.entry) + ' / exit ' + sig(p.exit) + ' samples from the line');
    if (td.pitSide) assert.strictEqual(p.side, td.pitSide, td.id + ' side');
    if (td.id === 'mc-1929' || td.id === 'nl-1948' || td.id === 'gb-1948') rows.push(td.id + ' side ' + p.side + ' ' + p.limitKmh + ' km/h lane ' + (2 * p.laneHalfW) + ' m');
  }
  assert.strictEqual(track('mc-1929').pit.side, -1, 'Monaco: harbour side = the right going north to Sainte Devote');
  assert.strictEqual(track('gb-1948').pit.side, -1, 'Silverstone: the Wing pit lane is on the right');
  return rows.join(', ');
});

test('pit lane limits by season (audit 2026-10-01): Zandvoort and Singapore 60 up to 2024, 80 from 2025; setYear switches the limit and the painted signs; buildTrack(data, {year})', () => {
  const notes = [];
  for (const [id, old] of [['nl-1948', 2023], ['sg-2008', 2019]]) {
    const td = TRACKS.find(t => t.id === id), p = track(id).pit;
    assert.strictEqual(p.limitFor(old), 60, id + ' ' + old);
    assert.strictEqual(p.limitFor(2024), 60, id + ' 2024');
    assert.strictEqual(p.limitFor(2025), 80, id + ' 2025');
    assert.strictEqual(p.limitFor(undefined), 80, id + ' current');
    const tr = F1.buildTrack(td, { year: old }), paint = tr.group.getObjectByName('paint');
    const sign = v => (Array.isArray(paint.material) ? paint.material : []).find(m => m.name === 'pitSign' + v);
    assert.strictEqual(tr.pit.limitKmh, 60, id + ' built for ' + old);
    assert(sign(60) && sign(80), id + ': one painted sign (paint mesh group + material) per limit');
    assert(tr.group.children.length <= 6, id + ': no extra meshes');
    assert(sign(60).visible && !sign(80).visible, id + ': the 60 signs shown');
    assert.strictEqual(tr.pit.setYear(2026), 80, id + ' setYear(2026)');
    assert(tr.pit.limitKmh === 80 && sign(80).visible && !sign(60).visible, id + ': setYear(2026) shows the 80 signs');
    tr.pit.setYear(2022);
    assert(tr.pit.limitKmh === 60 && tr.pit.year === 2022 && sign(60).visible, id + ': back to 60');
    tr.dispose();
    notes.push(id + ' ' + old + ': 60, 2025: 80');
  }
  // one limit only: the digits stay in the paint mesh, setYear still works
  const mc = F1.buildTrack(TRACKS.find(t => t.id === 'mc-1929'), { year: 2012 });
  assert(mc.pit.limitKmh === 60 && !Array.isArray(mc.group.getObjectByName('paint').material) && mc.pit.setYear(2026) === 60, 'Monaco 60 every season');
  mc.dispose();
  assert.strictEqual(F1.pitLimitFor(TRACKS.find(t => t.id === 'ru-2014'), 2016), 60, 'Sochi 60');
  return notes.join('; ');
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

// ---- 2026-10-01 audit corrections (docs/track-audit.md, tools/build-tracks.mjs)
const sIndexAt = (tr, td, lat, lon) => { const p = toXZ(td, lat, lon); return tr.nearest(p[0], p[1]).index; };
// steepest climb (+) / fall (-) of the built surface over `w` metres between samples a..b (in the racing direction)
function grades(tr, a, b, w) {
  const S = tr.samples, N = S.length, ds = tr.length / N, k = Math.max(1, Math.round(w / ds));
  let up = -Infinity, dn = Infinity;
  for (let i = a; i !== b; i = (i + 1) % N) {
    const g = (S[(i + k) % N].y - S[i].y) / (k * ds);
    if (g > up) up = g; if (g < dn) dn = g;
  }
  return [up, dn];
}

test('Suzuka crossover: a bridge (both roads keep their heights), clearance, walls on both levels, locate / nearest / groundY with y pick the level', () => {
  const td = TRACKS.find(t => t.id === 'jp-1962'), tr = track('jp-1962'), S = tr.samples, N = S.length;
  assert.strictEqual(tr.crossings.length, 1, 'one crossing');
  assert.strictEqual(tr.bridges.length, 1, 'it is a bridge');
  const B = tr.bridges[0], up = S[B.up], lo = S[B.lo];
  assert(B.separation >= 5.8 && B.separation <= 7, 'separation ' + B.separation.toFixed(2) + ' m (GSI lidar: 6.2 m)');
  assert(B.clearance >= 4.8, 'clearance under the deck ' + B.clearance.toFixed(2) + ' m');
  assert(B.deckLength >= 30 && B.deckLength <= 120, 'deck ' + B.deckLength.toFixed(0) + ' m');
  assert(B.abutmentSegments > 10, 'abutments');
  // the upper road is the back straight's bridge (OSM way 175231434), the lower the Degner - hairpin road
  const pb = toXZ(td, 34.84397, 136.53062);
  assert(Math.hypot(up.x - pb[0], up.z - pb[1]) < 30, 'the upper road is the OSM bridge');
  // walls on both roads through the crossing (parapets above, the lower road's walls under the deck)
  for (const c of [B.up, B.lo]) for (let q = -15; q <= 15; q++) {
    const s = S[(c + q + N) % N];
    assert(s.wallPos && s.wallNeg, 'walls at sample ' + ((c + q + N) % N));
  }
  // a point on the crossing: y near each surface picks that road; no y keeps the plan answer (either)
  for (const [x, z] of [[lo.x, lo.z], [up.x, up.z], [(lo.x + up.x) / 2 + 2, (lo.z + up.z) / 2 - 1]]) {
    const yLo = tr.surfaceY(B.lo, (x - lo.x) * lo.nx + (z - lo.z) * lo.nz), yUp = tr.surfaceY(B.up, (x - up.x) * up.nx + (z - up.z) * up.nz);
    const onLo = i => Math.min(Math.abs(i - B.lo), N - Math.abs(i - B.lo)) < 40, onUp = i => Math.min(Math.abs(i - B.up), N - Math.abs(i - B.up)) < 40;
    assert(onLo(tr.locate(x, z, -1, yLo + 0.3).index), 'global locate with the lower y');
    assert(onUp(tr.locate(x, z, -1, yUp + 0.3).index), 'global locate with the upper y');
    assert(onLo(tr.locate(x, z, B.up, yLo + 0.3).index), 'hinted on the upper road, y of the lower one');
    assert(onUp(tr.locate(x, z, B.lo, yUp).index), 'hinted on the lower road, y of the upper one');
    assert(onLo(tr.nearest(x, z, yLo).index) && onUp(tr.nearest(x, z, yUp).index), 'nearest with y');
    assert(Math.abs(tr.groundY(x, z, yLo) - yLo) < 0.05 && Math.abs(tr.groundY(x, z, yUp) - yUp) < 0.05, 'groundY with y');
    assert(tr.inCorridor(x, z, 0), 'inCorridor');
    assert(tr.terrainY(x, z) < yLo - 0.2, 'terrain under both roads');
  }
  // with the hint on its own road and no y, locate stays on that road (as before)
  assert.strictEqual(tr.locate(lo.x, lo.z, B.lo).index, B.lo);
  assert.strictEqual(tr.locate(up.x, up.z, B.up).index, B.up);
  return 'separation ' + B.separation.toFixed(2) + ' m, clearance ' + B.clearance.toFixed(2) + ' m, deck ' + B.deckLength.toFixed(0) + ' m';
});

test('Baku castle section: 7.6 m of road (widthOverrides), walls 1 m outside it as everywhere, no wall gaps, no steps', () => {
  const td = TRACKS.find(t => t.id === 'az-2016'), tr = track('az-2016'), S = tr.samples, N = S.length;
  assert(td.widthOverrides && td.widthOverrides.length === 1, 'data');
  const a = sIndexAt(tr, td, 40.368589, 49.837431), b = sIndexAt(tr, td, 40.369393, 49.835656);
  let n = 0, minW = Infinity;
  for (let i = (a + 3) % N; i !== (b - 2 + N) % N; i = (i + 1) % N) {
    const s = S[i];
    assert(Math.abs(s.halfW - 3.8) < 0.01, 'half width ' + s.halfW.toFixed(2) + ' at ' + i);
    assert(s.wallPos && s.wallNeg && s.wallPosDist <= 4.81 && s.wallNegDist <= 4.81 && Math.min(s.wallPosDist, s.wallNegDist) >= 4.79, 'walls at ' + i);
    minW = Math.min(minW, s.wallPosDist + s.wallNegDist); n++;
  }
  assert(n > 50, 'stretch ' + n + ' samples');
  let maxStep = 0, maxHW = 0;
  for (let i = 0; i < N; i++) {
    const a = S[i], b = S[(i + 1) % N];
    maxStep = Math.max(maxStep, Math.abs(b.wallPosDist - a.wallPosDist), Math.abs(b.wallNegDist - a.wallNegDist));
    maxHW = Math.max(maxHW, Math.abs(b.halfW - a.halfW));
  }
  assert(maxStep < 0.8 && maxHW < 0.35, 'steps per sample: walls ' + maxStep.toFixed(2) + ' m, road edge ' + maxHW.toFixed(2) + ' m');
  return n + ' samples (' + (n * tr.length / N).toFixed(0) + ' m), wall to wall ' + minW.toFixed(1) + ' m';
});

test('derived banking capped at 2.5 deg (1.5 on street circuits); the real bankings stay (Zandvoort 19 / 18, Madring 13.5, Jeddah 12, Indianapolis 9.2)', () => {
  const D = 180 / Math.PI, notes = [];
  for (const td of TRACKS) {
    const tr = track(td.id), S = tr.samples, N = S.length, cap = (td.bankMaxDeg || 2.5) + 0.01;
    const inOv = new Uint8Array(N);
    for (const o of td.bankOverrides || []) {         // the stretch +- the 35 m ease
      const ia = Math.round(o.from * N), ib = Math.round(o.to * N), len = ((ib - ia) % N + N) % N;
      for (let v = -30; v <= len + 30; v++) inOv[((ia + v) % N + N) % N] = 1;
    }
    let mx = 0;
    for (let i = 0; i < N; i++) if (!inOv[i]) mx = Math.max(mx, Math.abs(S[i].bank) * D);
    assert(mx <= cap, td.id + ': derived bank ' + mx.toFixed(2) + ' deg');
  }
  for (const [id, deg] of [['nl-1948', 19], ['es-2026', 13.5], ['sa-2021', 12], ['us-1909', 9.2]]) {
    const S = track(id).samples, mx = Math.max(...S.map(s => Math.abs(s.bank))) * D;
    assert(Math.abs(mx - deg) < 0.05, id + ' max bank ' + mx.toFixed(2));
    notes.push(id + ' ' + mx.toFixed(1));
  }
  return notes.join(', ');
});

test('elevation: Spa Raidillon ~14-15 % over 50 m from the Eau Rouge dip (Wallonia lidar), range ~102 m; Mugello San Donato uphill; Monza no invented hills', () => {
  const td = TRACKS.find(t => t.id === 'be-1925'), tr = track('be-1925'), S = tr.samples, N = S.length, ds = tr.length / N;
  const a = Math.round(800 / ds), b = Math.round(1250 / ds), g = grades(tr, a, b, 50);
  assert(g[0] >= 0.13 && g[0] <= 0.17, 'Raidillon steepest 50 m ' + (g[0] * 100).toFixed(1) + ' %');
  const range = Math.max(...td.elev) - Math.min(...td.elev);
  assert(range > 95 && range < 108, 'Spa range ' + range.toFixed(1));
  const mu = TRACKS.find(t => t.id === 'it-1914'), mt = track('it-1914'), mds = mt.length / mt.samples.length;
  const sd = mt.samples[Math.round(900 / mds)].y - mt.samples[Math.round(450 / mds)].y;
  assert(sd > 8, 'Mugello s 450 -> 900 climbs ' + sd.toFixed(1) + ' m (lidar +12.9)');
  const mz = TRACKS.find(t => t.id === 'it-1922'), mzr = Math.max(...mz.elev) - Math.min(...mz.elev);
  assert(mzr < 17, 'Monza range ' + mzr.toFixed(1) + ' m (TINITALY 12 m + the 5 m dip)');
  return 'Raidillon ' + (g[0] * 100).toFixed(1) + ' %, Spa ' + range.toFixed(1) + ' m, Mugello +' + sd.toFixed(1) + ' m, Monza ' + mzr.toFixed(1) + ' m (' + mu.elev.length + ' pts)';
});

test('layout: Silverstone line at the Wing, Albert Park T11 no 10 m radius, Madring 5.414 km, Estoril the post-2000 length', () => {
  const gb = TRACKS.find(t => t.id === 'gb-1948'), p = toXZ(gb, 52.0682609, -1.0234867);
  const d = Math.hypot(gb.points[0][0] - p[0], gb.points[0][1] - p[1]);
  assert(d < 3, 'Silverstone points[0] ' + d.toFixed(1) + ' m from the Wing timing line');
  const au = TRACKS.find(t => t.id === 'au-1953'), at = track('au-1953'), S = at.samples, N = S.length;
  const c = sIndexAt(at, au, -37.8533681, 144.9786557);
  let minR = Infinity;
  for (let q = -40; q <= 40; q++) {
    const i = (c + q + N) % N, a = S[(i - 3 + N) % N], b = S[(i + 3) % N];
    const dth = Math.abs(Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz)), L = 6 * at.length / N;
    if (dth > 1e-6) minR = Math.min(minR, L / dth);
  }
  assert(minR > 16, 'Albert Park T11 radius ' + minR.toFixed(1) + ' m');
  const md = TRACKS.find(t => t.id === 'es-2026'), es = TRACKS.find(t => t.id === 'pt-1972');
  assert(Math.abs(md.lengthKm - 5.414) < 0.003, 'Madring ' + md.lengthKm);
  assert(es.lengthKm > 4.14 && es.lengthKm < 4.19 && /2000/.test(es.layout || ''), 'Estoril ' + es.lengthKm + ' ' + es.layout);
  return 'Silverstone ' + d.toFixed(1) + ' m, Albert Park T11 r ' + minR.toFixed(1) + ' m, Madring ' + md.lengthKm + ', Estoril ' + es.lengthKm;
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall track tests passed');
process.exit(failed ? 1 : 0);
