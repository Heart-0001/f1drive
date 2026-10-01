// node devtests/laps-test/grid.js [track-regex] [-v]
//
// The starting grid on every track: the boxes js/track.js paints (16 of them), track.grid, and where js/main.js's
// placeOnGrid(slot) really puts the car (its source is taken from js/main.js, see main-grid.js; the car is the real
// js/car.js). The box geometry is computed here a second time from the rule, NOT read from track.grid:
//   box k = slot + 1: front bar k * 8 m behind the line, 0.25 m thick, 2.6 m wide, centred 3 m to the driver's left
//   (odd k) / right (even k) of the centreline, side brackets 0.2 m wide reaching 1.6 m back; straight, in the frame
//   of the centreline sample the front of the bar is on.
// Per slot: the box is in the paint mesh, track.grid agrees with it, the car's nose is at the rear edge of the front
// bar, the car is on the box's centreline and faces the way the box does, its front wing is between the brackets, the
// whole car is on the road (inside the edge lines), clear of the walls, behind the line and clear of the 15 other
// cars; placing it moved nothing (no wall push), and an armed lap counter (js/laps.js) knows it is before the line.
// -v prints every slot. Exit code 1 when a check fails.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/car.js'));
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));
const mainGrid = require('./main-grid.js');
const F1 = global.F1, TR = global.F1_TRACKS;

const SLOTS = 16, GAP = 8, SIDE = 3, BAR = 0.25, BOX_W = 1.3, BRACKET = 0.2, BOX_LEN = 1.6, EDGE = 1.8, LINE_W = 0.3;
// the car as drawn (js/carmodel.js, js/cockpit.js): front wing to z = +2.81, rear wing to z = -2.73, rear tyres to
// x = +-1.02, front wing +-0.95 wide and 0.42 long. car.state.x / z is the origin of that model.
const NOSE = 2.81, TAIL = 2.73, HALF_W = 1.02, WING_W = 0.95, WING_LEN = 0.42;
const MIN_ROAD = LINE_W, MIN_WALL = 1.0, MIN_CLEAR = 0.5;

const args = process.argv.slice(2), verbose = args.indexOf('-v') >= 0;
const filter = args.filter(a => a !== '-v')[0] ? new RegExp(args.filter(a => a !== '-v')[0], 'i') : null;
let failures = 0;
function check(ok, what) { if (!ok) { failures++; console.log('    FAIL: ' + what); } return ok; }
const f2 = v => v.toFixed(2);

// Separation of two oriented rectangles {x, z, h, hl, hw} (centre, heading, half length, half width): > 0 = apart
// (a lower bound of the gap between them), <= 0 = they overlap.
function separation(a, b) {
  let best = -Infinity;
  for (const r of [a, b]) {
    for (const ax of [[Math.sin(r.h), Math.cos(r.h)], [Math.cos(r.h), -Math.sin(r.h)]]) {
      const ext = q => q.hl * Math.abs(Math.sin(q.h) * ax[0] + Math.cos(q.h) * ax[1]) + q.hw * Math.abs(Math.cos(q.h) * ax[0] - Math.sin(q.h) * ax[1]);
      const dist = Math.abs((b.x - a.x) * ax[0] + (b.z - a.z) * ax[1]);
      best = Math.max(best, dist - ext(a) - ext(b));
    }
  }
  return best;
}

function gridOnTrack(td) {
  const track = F1.buildTrack(td), S = track.samples, N = S.length, ds = track.length / N;
  const car = F1.createCar(), st = car.state, place = mainGrid(track, car);
  const f0 = failures, id = td.id;
  const paint = track.group.children.filter(m => m.name === 'paint')[0].geometry.attributes.position.array;
  const painted = (x, z) => { for (let i = 0; i < paint.length; i += 3) if (Math.abs(paint[i] - x) < 2e-3 && Math.abs(paint[i + 2] - z) < 2e-3) return true; return false; };
  const out = { road: Infinity, wall: Infinity, clear: Infinity, bend: 0, backMin: Infinity, backMax: 0 };

  check(Array.isArray(track.grid) && track.grid.length === SLOTS, id + ': track.grid has ' + (track.grid && track.grid.length) + ' entries');
  const cars = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const k = slot + 1, what = id + ' slot ' + slot;
    // --- the box, from the rule
    const gi = ((N - Math.round(k * GAP / ds)) % N + N) % N, s = S[gi];
    let hw = s.halfW;
    for (let j = 1; j <= Math.ceil(6 / ds); j++) hw = Math.min(hw, S[((gi - j) % N + N) % N].halfW);
    const lat = (k % 2 ? 1 : -1) * Math.max(0, Math.min(SIDE, hw - EDGE));
    const at = (la, lo) => [s.x + s.nx * la + s.tx * lo, s.z + s.nz * la + s.tz * lo];     // box frame -> world
    const heading = Math.atan2(s.tx, s.tz);
    // --- it is painted: the four corners of the front bar and the rear ends of both brackets
    const corners = [[lat - BOX_W, 0], [lat + BOX_W, 0], [lat - BOX_W, -BAR], [lat + BOX_W, -BAR],
      [lat - BOX_W, -BOX_LEN], [lat - BOX_W + BRACKET, -BOX_LEN], [lat + BOX_W - BRACKET, -BOX_LEN], [lat + BOX_W, -BOX_LEN]];
    const missing = corners.filter(c => { const p = at(c[0], c[1]); return !painted(p[0], p[1]); }).length;
    check(missing === 0, what + ': ' + missing + ' of 8 corners of the box are not in the paint mesh');
    check(Math.abs(lat) + BOX_W <= s.halfW - LINE_W + 1e-9, what + ': the box reaches the edge line (|lat| ' + Math.abs(lat) + ', half width ' + s.halfW + ')');
    // --- track.grid says the same
    const g = track.grid[slot] || {}, np = at(lat, -BAR);
    check(g.index === gi && Math.abs(g.d - lat) < 1e-9 && Math.hypot(g.x - np[0], g.z - np[1]) < 1e-9 && Math.abs(g.heading - heading) < 1e-12,
      what + ': track.grid ' + JSON.stringify(g) + ' != box at sample ' + gi + ', d ' + lat);
    // --- the car, placed by main.js
    const idx = place(slot);
    check(idx === st.sampleIndex && st.speed === 0 && st.hit === 0 && st.steer === 0, what + ': placed with speed ' + st.speed + ', hit ' + st.hit);
    const fx = Math.sin(st.heading), fz = Math.cos(st.heading);                   // forward
    const lx = Math.cos(st.heading), lz = -Math.sin(st.heading);                  // driver's left
    const world = (along, left) => [st.x + fx * along + lx * left, st.z + fz * along + lz * left];
    const box = p => [(p[0] - s.x) * s.nx + (p[1] - s.z) * s.nz - lat, (p[0] - s.x) * s.tx + (p[1] - s.z) * s.tz];   // -> [lateral from the box centreline, lon]
    const nose = box(world(mainGrid.CAR_NOSE, 0)), centre = box(world(0, 0)), tip = box(world(NOSE, 0));
    check(Math.abs(st.heading - heading) < 1e-9, what + ': heading ' + st.heading + ' != box ' + heading);
    check(Math.abs(nose[0]) < 1e-6 && Math.abs(nose[1] + BAR) < 1e-6, what + ': nose at lateral ' + nose[0] + ', lon ' + nose[1] + ' (want 0, ' + -BAR + ': the rear edge of the front bar)');
    check(Math.abs(centre[0]) < 1e-6, what + ': centre ' + centre[0] + ' m off the box centreline');
    check(tip[1] <= -BAR + 0.02 && tip[1] > -BAR - 0.1, what + ': the front wing ends ' + f2(-tip[1]) + ' m behind the front of the bar (bar: 0.25)');
    // front wing between the brackets, inside the box
    for (const c of [[NOSE, WING_W], [NOSE, -WING_W], [NOSE - WING_LEN, WING_W], [NOSE - WING_LEN, -WING_W]]) {
      const b = box(world(c[0], c[1]));
      check(Math.abs(b[0]) <= BOX_W - BRACKET && b[1] <= -BAR + 0.02 && b[1] >= -BOX_LEN, what + ': front wing corner at lateral ' + f2(b[0]) + ', lon ' + f2(b[1]) + ' is not inside the box');
    }
    // --- the whole car: on the road, clear of the walls, behind the line
    let road = Infinity, wall = Infinity;
    for (const c of [[NOSE, HALF_W], [NOSE, -HALF_W], [0, HALF_W], [0, -HALF_W], [-TAIL, HALF_W], [-TAIL, -HALF_W]]) {
      const p = world(c[0], c[1]), loc = track.locate(p[0], p[1], st.sampleIndex), q = S[loc.index];
      road = Math.min(road, q.halfW - Math.abs(loc.d));
      wall = Math.min(wall, (loc.d > 0 ? q.wallPosDist : q.wallNegDist) - Math.abs(loc.d));
    }
    check(road >= MIN_ROAD, what + ': a corner of the car is ' + f2(road) + ' m inside the road edge (edge line: ' + LINE_W + ')');
    check(wall >= MIN_WALL, what + ': a corner of the car is ' + f2(wall) + ' m from the wall');
    const tipW = world(NOSE, 0), back = (N - track.locate(tipW[0], tipW[1], st.sampleIndex).index) % N;
    check(back >= 1 && back <= (k * GAP + BAR) / ds + 2, what + ': the nose is ' + back + ' samples behind the line');
    if (slot === 0) {
      const lon0 = (tipW[0] - S[0].x) * S[0].tx + (tipW[1] - S[0].z) * S[0].tz;
      // (measured square to the line: 8.25 m on a straight grid, a little more or less where the road bends)
      check(lon0 < -GAP + 2 && lon0 > -GAP - 2, what + ': the nose of the pole car is ' + f2(-lon0) + ' m behind the line (box 1 is 8 m back)');
      out.pole = -lon0;
    }
    // --- which side, how far back, and what the armed lap counter makes of it
    check((st.d > 0) === (slot % 2 === 0) && Math.abs(Math.abs(st.d) - Math.abs(lat)) < 0.6, what + ': car.state.d ' + f2(st.d) + ' (box at ' + lat + ')');
    const cBack = (N - idx) % N, want = (k * GAP + BAR + mainGrid.CAR_NOSE) / ds;
    check(Math.abs(cBack - want) <= 1.5, what + ': the car is on sample N - ' + cBack + ', expected about N - ' + f2(want));
    const lap = createLapCounter(N, idx);
    lap.reset(idx); lap.arm(idx);
    check(lap.behind && lap.started && lap.n === 1 && lap.progress(idx) < 0 && Math.abs(lap.progress(idx) + cBack / N) < 1e-12, what + ': armed counter: behind ' + lap.behind + ', progress ' + lap.progress(idx));
    out.road = Math.min(out.road, road); out.wall = Math.min(out.wall, wall);
    out.backMin = Math.min(out.backMin, cBack); out.backMax = Math.max(out.backMax, cBack);
    out.bend = Math.max(out.bend, Math.abs(Math.abs(st.d) - Math.abs(lat)));
    cars.push({ slot: slot, x: st.x + fx * (NOSE - TAIL) / 2, z: st.z + fz * (NOSE - TAIL) / 2, h: st.heading, hl: (NOSE + TAIL) / 2, hw: HALF_W });
    if (verbose) console.log('    slot ' + String(slot).padStart(2) + ': box sample N-' + (N - gi) + ' d ' + lat + ' | car sample N-' + cBack + ' d ' + f2(st.d) + ' heading ' + f2(st.heading * 180 / Math.PI) +
      ' deg | road margin ' + f2(road) + ', wall ' + f2(wall));
  }
  for (let a = 0; a < cars.length; a++) {
    for (let b = a + 1; b < cars.length; b++) {
      const sep = separation(cars[a], cars[b]);
      if (sep < out.clear) out.clear = sep;
      check(sep >= MIN_CLEAR, id + ': the cars on slots ' + cars[a].slot + ' and ' + cars[b].slot + ' are ' + f2(sep) + ' m apart');
    }
  }
  // the box after the last one is not painted
  const gx = ((N - Math.round((SLOTS + 1) * GAP / ds)) % N + N) % N, sx = S[gx];
  check(!painted(sx.x - sx.nx * (SIDE - BOX_W), sx.z - sx.nz * (SIDE - BOX_W)) && !painted(sx.x + sx.nx * (SIDE - BOX_W), sx.z + sx.nz * (SIDE - BOX_W)), id + ': a 17th box is painted');

  const ok = failures === f0;
  console.log((ok ? 'OK   ' : 'FAIL ') + id.padEnd(8) + td.name.slice(0, 30).padEnd(31) + '16 boxes painted, cars on samples N-' + out.backMin + '..N-' + out.backMax +
    ' | nearest to the road edge ' + f2(out.road) + ' m, to a wall ' + f2(out.wall) + ' m | pole nose ' + f2(out.pole) + ' m behind the line | two cars at least ' + f2(out.clear) + ' m apart | d off the box by up to ' + f2(out.bend) + ' m (bend)');
  track.dispose();
  return ok;
}

const t0 = Date.now();
const tracks = TR.filter(td => !filter || filter.test(td.id) || filter.test(td.name));
let okTracks = 0;
console.log('starting grid on ' + tracks.length + ' tracks: main.js placeOnGrid (CAR_NOSE ' + mainGrid.CAR_NOSE + ') against the painted boxes');
for (const td of tracks) if (gridOnTrack(td)) okTracks++;
console.log('\n' + okTracks + ' / ' + tracks.length + ' tracks ok' + (failures ? ', ' + failures + ' check(s) FAILED' : ': all grid checks passed') + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
process.exit(failures ? 1 : 0);
