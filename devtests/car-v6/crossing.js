// node devtests/car-v6/crossing.js [track id = jp-1962]
//
// v6.2: Suzuka's crossover is a bridge (js/track.js: a crossing whose two roads are 3 m or more apart in height keeps
// both heights; the real one is 6.2 m) and js/car.js passes the car's height to every track.locate (local and global
// re-locates, R reset), so a car on either road never jumps onto the other one. The REAL car (js/car.js, js/tyres.js)
// on the REAL track (tracks-data.js, scenery-data.js as in the game), stepped at 1/120 s as main.js steps it.
//   drive    both roads, both ways (racing direction and wrong way), 6 .. 90 m/s, lateral offsets across the road
//            (analog pure pursuit on the offset line, speed held), 120 m before to 120 m after the crossing: the index
//            never on the other road, no height step (|dy| per step <= the road's grade x the step + 5 cm), no wall
//            contact, no grass, the speed held (no invisible wall); a lap counter (js/laps.js) fed as main.js feeds it
//            sees no index jump
//   reset    car.reset (R) on every sample of both roads within 30 m of the crossing: the index is that sample's road,
//            the height that road's; then 3 s of driving on (both ways) stays on it
//   place    the car put at points of the crossing area of either road with a stale index (a global re-locate): it
//            lands on the road whose height it has, also where the other road is nearer in plan; and, as the
//            control, track.locate without a height picks the other road at some of those points
// Exit code 1 on a failure.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/laps.js'));
const F1 = global.F1;

const ID = process.argv[2] || 'jp-1962';
const STEP = 1 / 120;
let failed = 0, checks = 0;
function check(name, ok, detail) {
  checks++; if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? '   ' + detail : ''));
}
const td = global.F1_TRACKS.find(t => t.id === ID);
if (!td) { console.log('no track ' + ID); process.exit(1); }
const tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N;
const cyc = (a, b) => { const d = Math.abs(a - b) % N; return Math.min(d, N - d); };
const br = (tr.bridges || [])[0];
console.log(ID + ' ' + td.name + ': N ' + N + ', crossings ' + JSON.stringify(tr.crossings) + ', bridges ' + JSON.stringify(tr.bridges || []));
if (!br) { check('the crossing is a bridge (two levels)', false, 'none: the roads are levelled into a junction'); process.exit(1); }
const ROADS = [{ name: 'upper (bridge)', c: br.up, o: br.lo }, { name: 'lower (under it)', c: br.lo, o: br.up }];
console.log('upper road at sample ' + br.up + ' y ' + S[br.up].y.toFixed(2) + ' m, lower road at ' + br.lo + ' y ' + S[br.lo].y.toFixed(2) + ' m, separation ' + (+(br.separation || br.sep)).toFixed(2) + ' m');
const OTHER_WIN = 70;   // samples of the other road around its crossing sample: the index must never be there
// height step allowed per 1/120 s step beyond the road's grade: car.js's surface() (the v5 reference car's) steps by up
// to ~1 cm where the located sample changes at a large lateral offset on a curve (everywhere, not only here); a jump
// onto the other level would be the separation (6.2 m)
const DY_SLACK = 0.05;

// ---------------------------------------------------------------- drive
// path point of road r at index i, offset dOff (left of the road's direction of travel dir: d * dir)
function pathPoint(i, dOff, dir) { const s = S[((i % N) + N) % N]; return { x: s.x + s.nx * dOff * dir, z: s.z + s.nz * dOff * dir }; }
function drive(road, dir, v, dOff, win) {
  const car = F1.createCar(), st = car.state, c = road.c;
  car.tyres.setWearRate(0);
  const start = (c - dir * Math.round(win / ds) + N) % N, stop = Math.round(win / ds);
  car.reset(tr, start);
  const s0 = S[start];
  st.heading = Math.atan2(s0.tx * dir, s0.tz * dir);
  const p0 = pathPoint(start, dOff, dir);
  st.x = p0.x; st.z = p0.z; st.y = tr.surfaceY(start, dOff * dir); st.speed = v;
  const lap = F1.createLapCounter(N, start); lap.sync(start);
  const inp = { up: false, down: false, left: false, right: false, throttle: 0, brake: 0, steerAxis: 0 };
  const r = { steps: 0, other: 0, maxDy: 0, dyBad: 0, hits: 0, grass: 0, minV: Infinity, jumps: 0, passed: false, lastY: null };
  const maxK = Math.ceil((2 * win / v + 6) * 120);
  for (let k = 0; k < maxK; k++) {
    // pure pursuit on the offset line (analog stick), speed held by throttle / brake
    const av = Math.abs(st.speed), la = Math.max(6, 0.3 * av), i = st.sampleIndex + dir * Math.round(la / ds), tp = pathPoint(i, dOff, dir);
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz);
    const lock = car.perf.steerLockAt(av, 0, kap >= 0 ? 1 : -1);
    inp.steerAxis = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    const e = v - st.speed;
    inp.throttle = e > 0 ? Math.min(1, 0.4 * e + 0.25) : 0; inp.brake = e < -0.5 ? Math.min(1, -0.3 * e) : 0;
    const y0 = st.y;
    car.update(STEP, inp, tr);
    lap.update(st.sampleIndex, st.speed, STEP);
    r.steps++;
    if (cyc(st.sampleIndex, road.o) <= OTHER_WIN) r.other++;
    const s = S[st.sampleIndex], dy = Math.abs(st.y - y0), allow = Math.abs(s.grade || 0) * Math.abs(st.speed) * STEP * 1.5 + DY_SLACK;
    if (dy > r.maxDy) r.maxDy = dy;
    if (dy > allow) r.dyBad++;
    if (st.hit > 0) r.hits++;
    if (st.onGrass) r.grass++;
    if (k > 60 && Math.abs(st.speed) < r.minV) r.minV = Math.abs(st.speed);
    const along = ((st.sampleIndex - c) * dir % N + N) % N;
    if (along > stop && along < N / 2) { r.passed = true; break; }
  }
  r.jumps = lap.jumps;
  return r;
}
// the fastest the road allows from win m before to win m after the crossing (85 % of the grip; a little margin beyond)
function roadMaxV(road, win) {
  let kmax = 0;
  const W = Math.round(win / ds) + 10;
  for (let q = -W; q <= W; q++) {
    const i = (road.c + q + N) % N, a = S[(i - 3 + N) % N], b = S[i], cc = S[(i + 3) % N];
    const h1 = Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz), h2 = Math.atan2(cc.tx, cc.tz) - Math.atan2(b.tx, b.tz);
    const w = x => Math.atan2(Math.sin(x), Math.cos(x));
    kmax = Math.max(kmax, Math.abs(w(h1) + w(h2)) / (6 * ds));
  }
  const p = F1.CAR_PERF;
  let v = 95;
  while (v > 5 && v * v * kmax > 0.85 * p.maxLatAccel(v, 0, 0, 0, 1)) v -= 1;
  return { v, kmax };
}
console.log('\n== drive through the crossing (1/120 s steps, analog pursuit on an offset line, speed held)');
const SPEEDS = [6, 15, 30, 50, 70, 90];
let runs = 0;
// Two windows: 120 m before to 120 m after at the speeds the road allows over that stretch (the lower road runs into
// the hairpin), and 30 m before to 30 m after for the faster ones, up to what the road allows there (90 m/s at most).
for (const road of ROADS) for (const win of [120, 30]) {
  const lim = roadMaxV(road, win), limLong = roadMaxV(road, 120), hw = S[road.c].halfW;
  const OFFS = [-(hw - 1.4), -3.5, 0, 3.5, hw - 1.4];
  const speeds = win === 120 ? SPEEDS.filter(v => v <= lim.v) :
    SPEEDS.concat([Math.min(90, lim.v)]).filter((v, ix, a) => v > limLong.v && v <= lim.v && a.indexOf(v) === ix);
  if (!speeds.length) continue;
  for (const dir of [1, -1]) {
    const rows = [];
    let bad = 0, other = 0, jumps = 0, dyBad = 0, hits = 0, grass = 0, slow = 0, notPassed = 0, maxDy = 0;
    for (const v of speeds) {
      for (const d of OFFS) {
        const r = drive(road, dir, v, d, win);
        runs++;
        other += r.other; jumps += r.jumps; dyBad += r.dyBad; hits += r.hits; grass += r.grass; maxDy = Math.max(maxDy, r.maxDy);
        if (r.minV < 0.8 * v) slow++;
        if (!r.passed) notPassed++;
        if (r.other || r.jumps || r.dyBad || r.hits || r.grass || r.minV < 0.8 * v || !r.passed) { bad++; rows.push(v + ' m/s @ ' + d.toFixed(1) + ' m: ' + JSON.stringify(r)); }
      }
    }
    const label = road.name + ', ' + (dir > 0 ? 'racing direction' : 'wrong way') + ', ' + win + ' m before to ' + win + ' m after at ' +
      speeds.join(' / ') + ' m/s (grip limit there ' + lim.v + ')';
    check(label + ': index never on the other road, no height step, no wall, no grass, speed held, no lap-counter jump',
      bad === 0, 'steps on the other road ' + other + ', height steps ' + dyBad + ' (largest |dy| ' + maxDy.toFixed(3) + ' m), wall steps ' + hits + ', grass ' + grass + ', slowed ' + slow + ', not through ' + notPassed + ', lap jumps ' + jumps);
    for (const s of rows.slice(0, 4)) console.log('       ' + s);
  }
}
console.log('     ' + runs + ' drives');

// Straight through at the speeds above what the road's curve allows: along the crossing sample's tangent, no steering,
// 30 m before to 30 m after, at every offset (grass allowed: a straight line leaves a curving road)
console.log('\n== straight through the crossing point along the road\'s tangent at 50 .. 90 m/s, no steering');
for (const road of ROADS) {
  const c = S[road.c], hw = c.halfW, OFFS = [-(hw - 1.4), -3.5, 0, 3.5, hw - 1.4];
  let n = 0, other = 0, dyBad = 0, hits = 0, maxDy = 0;
  for (const dir of [1, -1]) for (const v of [50, 70, 90]) for (const d of OFFS) {
    const car = F1.createCar(), st = car.state;
    car.tyres.setWearRate(0);
    car.reset(tr, (road.c - dir * Math.round(30 / ds) + N) % N);
    const tx = c.tx * dir, tz = c.tz * dir, x0 = c.x - tx * 30 + c.nx * d * dir, z0 = c.z - tz * 30 + c.nz * d * dir;
    st.heading = Math.atan2(tx, tz); st.x = x0; st.z = z0; st.speed = v; car.update(1e-4, {}, tr);
    n++;
    for (let k = 0; k < Math.ceil(60 / v * 120); k++) {
      const y0 = st.y;
      car.update(STEP, { throttle: 0.6 }, tr);
      if (cyc(st.sampleIndex, road.o) <= OTHER_WIN) other++;
      const dy = Math.abs(st.y - y0), s = S[st.sampleIndex];
      if (dy > maxDy) maxDy = dy;
      if (dy > Math.abs(s.grade || 0) * v * STEP * 1.5 + DY_SLACK) dyBad++;
      if (st.hit > 0) hits++;
    }
  }
  check(road.name + ': straight through at 50 / 70 / 90 m/s, both ways, every offset (' + n + ' runs): never on the other road, no height step, no wall',
    other === 0 && dyBad === 0 && hits === 0, 'steps on the other road ' + other + ', height steps ' + dyBad + ' (largest |dy| ' + maxDy.toFixed(3) + ' m), wall steps ' + hits);
}

// ---------------------------------------------------------------- reset (R) on and under the bridge
console.log('\n== R reset on every sample of both roads within 30 m of the crossing, then 3 s on');
for (const road of ROADS) {
  let wrong = 0, yBad = 0, driveBad = 0, n = 0, worstY = 0;
  for (let q = -15; q <= 15; q++) {
    const i = (road.c + q + N) % N;
    for (const dir of [1, -1]) {
      const car = F1.createCar(), st = car.state;
      car.tyres.setWearRate(0);
      // a car that was somewhere else on the lap before (a stale state.y from the other level as well)
      car.reset(tr, road.o); car.update(STEP, {}, tr);
      car.reset(tr, i);
      n++;
      if (st.sampleIndex !== i) wrong++;
      const ey = Math.abs(st.y - tr.surfaceY(i, st.d)); worstY = Math.max(worstY, ey);
      if (ey > 0.02) yBad++;
      if (dir < 0) { st.heading += Math.PI; }
      let off = 0, hit = 0, lastY = st.y, step = 0;
      for (let k = 0; k < 360; k++) {
        const av = Math.abs(st.speed), la = Math.max(6, 0.3 * av), tp = pathPoint(st.sampleIndex + dir * Math.round(la / ds), 0, dir);
        const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading), kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
        const inp = { steerAxis: Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / car.perf.steerLockAt(av, 0, kap >= 0 ? 1 : -1))), throttle: av < 25 ? 1 : 0 };
        car.update(STEP, inp, tr);
        if (cyc(st.sampleIndex, road.o) <= OTHER_WIN) off++;
        if (st.hit > 0) hit++;
        if (Math.abs(st.y - lastY) > 0.3) step++;
        lastY = st.y;
      }
      if (off || hit || step) driveBad++;
    }
  }
  check(road.name + ': car.reset on each of its samples puts the car on that road at that road\'s height (' + n + ' resets, from a car on the other level)',
    wrong === 0 && yBad === 0, 'wrong road ' + wrong + ', height off ' + yBad + ' (worst ' + worstY.toFixed(3) + ' m)');
  check(road.name + ': after the reset, 3 s of driving on (both ways) stay on that road, no wall, no height step', driveBad === 0, driveBad + ' bad');
}

// ---------------------------------------------------------------- placed with a stale index: the global re-locate
console.log('\n== placed in the crossing area with a stale index (global re-locate with the car\'s height)');
for (const road of ROADS) {
  let n = 0, wrong = 0, ctlOther = 0;
  const hw = S[road.c].halfW;
  for (let q = -6; q <= 6; q++) {
    const i = (road.c + q + N) % N, s = S[i];
    for (let d = -(hw - 1); d <= hw - 1 + 1e-9; d += (hw - 1) / 3) {
      const x = s.x + s.nx * d, z = s.z + s.nz * d, y = tr.surfaceY(i, d);
      const car = F1.createCar(), st = car.state;
      car.tyres.setWearRate(0);
      car.reset(tr, (road.c + (N >> 1)) % N);           // somewhere far away (the index is stale)
      st.x = x; st.z = z; st.y = y; st.speed = 0;        // put here (as main.js places a car), at this road's height
      car.update(STEP, {}, tr);
      n++;
      if (cyc(st.sampleIndex, road.o) <= OTHER_WIN || cyc(st.sampleIndex, road.c) > 12) wrong++;
      const g = tr.locate(x, z, -1);                     // control: without the height
      if (cyc(g.index, road.o) <= OTHER_WIN) ctlOther++;
    }
  }
  check(road.name + ': a car placed on it with a stale index lands on it (global re-locate by height)', wrong === 0, n + ' placements, ' + wrong + ' on the wrong road; control: track.locate without the height picks the other road at ' + ctlOther);
}

console.log('\n' + (checks - failed) + ' / ' + checks + ' crossing checks passed');
process.exit(failed ? 1 : 0);
