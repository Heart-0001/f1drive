// node devtests/car-v6/pit-drive.js [track regex | all] [boxes: all | 0,5,15]
//
// The pit lane driven with the REAL v6 car (js/car.js: the lane is asphalt, the pit wall is solid, the pit limiter)
// on the REAL track (js/track.js, scenery-data.js loaded as in the game), stepped as main.js steps it (1/120 s).
// Built on devtests/pit-test/drive.js (the track owner's check, which needed a proxy track for the asphalt).
// For every track and every box (one lane visit per box, slots 0..15):
//   the car starts standing on the centreline 250 m before pit.from; a pure-pursuit follower drives a target path
//   (centreline -> pit.laneD -> into box `slot` -> laneD -> back to the centreline) with the speed from the path's
//   curvature and braking, below the limit at the entry line; from 30 m before the entry line to the exit line
//   input.limiter is ON and the follower simply keeps the throttle open (the limiter holds the speed); it stops in the
//   box (nose on the stop bar = car origin on the box point), holds 1 s, drives out, rejoins and goes 150 m on.
// Checks: never a wall / pit-wall contact (state.hit 0), never grass from pit.from to pit.to (pit asphalt), never
// closer to the pit wall than its half thickness + the car's half width, state.inPit === pit.inLane between the lines,
// at most limitKmh + 0.5 km/h between the lines (and within 2.5 km/h of it cruising), stopped within 0.3 m along /
// 0.2 m across / 3 deg of the box, finished the run. Exit code 1 on a failure.
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
const F1 = global.F1, PERF = F1.CAR_PERF;

const STEP = 1 / 120, HZ_EVERY = 2;              // physics at 120 Hz, the follower at 60 Hz
const arg = process.argv[2] || 'all';
const filter = arg === 'all' ? null : new RegExp(arg, 'i');
const boxesArg = process.argv[3] || 'all';
const HOLD = 1.0;
const A_LAT = 9, A_BRAKE = 7, A_STOP = 2.5;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const f1 = v => (Math.round(v * 10) / 10).toFixed(1), f2 = v => (Math.round(v * 100) / 100).toFixed(2);

let failures = 0;
const rows = [];

function driveBox(track, slot, fail) {
  const S = track.samples, N = S.length, ds = track.length / N, pit = track.pit;
  const wq = q => ((q % N) + N) % N, kOf = i => wq(i - pit.from);
  const K = kOf(pit.to), kEn = kOf(pit.entry), kEx = kOf(pit.exit), sg = pit.side, vLim = pit.limitKmh / 3.6;
  const car = F1.createCar(), st = car.state;
  car.tyres.setWearRate(0);
  const run = Math.round(250 / ds), out = Math.round(150 / ds), back = Math.round(100 / ds);
  const start = wq(pit.from - run);
  car.reset(track, start);
  // target path over u = samples from `start`
  const L = run + K + out + 40, tgt = new Float64Array(L + 1), vmax = new Float64Array(L + 1).fill(40), iOf = u => wq(start + u);
  const b = pit.boxes[slot], ub = run + kOf(b.index);
  for (let u = 0; u <= L; u++) {
    if (u < run) { const f = clamp(u / (run - 10), 0, 1); tgt[u] = pit.laneD(pit.from) * f * f * (3 - 2 * f); }
    else if (u <= run + K) tgt[u] = pit.laneD(iOf(u));
    else { const f = clamp((u - run - K) / back, 0, 1); tgt[u] = pit.laneD(pit.to) * (1 - f * f * (3 - 2 * f)); }
  }
  {
    // into the box late (the garage face ramps out just before the first box), out of it over 24 m
    const a0 = ub - Math.round(28 / ds), a1 = ub - Math.round(6 / ds), b0 = ub + Math.round(4 / ds), b1 = ub + Math.round(28 / ds);
    for (let u = a0; u <= b1; u++) {
      let f = u < a1 ? (u - a0) / (a1 - a0) : (u <= b0 ? 1 : 1 - (u - b0) / (b1 - b0));
      f = clamp(f, 0, 1); f = f * f * (3 - 2 * f);
      tgt[u] = tgt[u] + (b.d - tgt[u]) * f;
    }
  }
  const P = [];
  for (let u = 0; u <= L; u++) { const s = S[iOf(u)]; P.push([s.x + s.nx * tgt[u], s.z + s.nz * tgt[u]]); }
  for (let u = 2; u <= L - 2; u++) {
    const a = P[u - 2], bb = P[u], c = P[u + 2];
    const ax = bb[0] - a[0], az = bb[1] - a[1], bx = c[0] - a[0], bz = c[1] - a[1];
    const kap = 2 * Math.abs(ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(c[0] - bb[0], c[1] - bb[1]) + 1e-9);
    vmax[u] = Math.min(vmax[u], Math.sqrt(A_LAT / Math.max(kap, 1e-6)));
  }
  const uEn = run + kEn, uEx = run + kEx;
  for (let u = uEn - Math.round(40 / ds); u <= uEx; u++) vmax[u] = Math.min(vmax[u], vLim - 2 / 3.6);   // below the limit at the line
  vmax[ub] = Math.min(vmax[ub], 2);
  for (let u = L - 1; u >= 0; u--) {
    const acc = u < ub && ub - u < 40 / ds ? A_STOP : A_BRAKE;
    vmax[u] = Math.min(vmax[u], Math.sqrt(vmax[u + 1] * vmax[u + 1] + 2 * acc * ds));
  }

  const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, limiter: false, boost: false };
  let truth = st.sampleIndex, U = 0, t = 0, n = 0, integ = 0, holdT = 0, stopped = null, done = false;
  const rec = { hits: 0, grass: 0, wall: 0, inPitBad: 0, maxLane: 0, cruise: 0, minWall: Infinity };
  const lim = pit.wallHalfT + PERF.carHalfWidth;
  while (U < L - 40 && t < 240) {
    if (n++ % HZ_EVERY === 0) {
      const u = clamp(U, 0, L - 1), v = Math.max(0, st.speed);
      input.limiter = u >= uEn - Math.round(30 / ds) && u <= uEx;
      let vt = vmax[u];
      const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
      const dist = stopped ? Infinity : (b.x - st.x) * fx + (b.z - st.z) * fz;
      if (dist < 25) vt = Math.min(vt, Math.sqrt(2 * 1.2 * Math.max(0, dist - 0.05)) + (dist > 0.05 ? 0.25 : 0));
      const braking = !stopped && dist < 0.06;
      if (holdT > 0) {
        holdT -= HZ_EVERY * STEP;
        input.throttle = null; input.brake = 1; input.steerAxis = null;
      } else if (braking && v < 0.02) {
        holdT = HOLD;
        input.throttle = null; input.brake = 1;
        const lx = Math.cos(b.heading), lz = -Math.sin(b.heading);
        const hd = Math.atan2(Math.sin(st.heading - b.heading), Math.cos(st.heading - b.heading));
        stopped = { along: -dist, across: (st.x - b.x) * lx + (st.z - b.z) * lz, hd, inPit: st.inPit };
      } else {
        const la = clamp(4 + 0.35 * v, 5, 20), j = clamp(u + Math.round(la / ds), 0, L), s = S[iOf(j)];
        const gx = s.x + s.nx * tgt[j] - st.x, gz = s.z + s.nz * tgt[j] - st.z;
        const sh = Math.sin(st.heading), ch = Math.cos(st.heading);
        const xf = gx * sh + gz * ch, yl = gx * ch - gz * sh;
        const kap = 2 * yl / (xf * xf + yl * yl);
        const lock = PERF.steerLock / (1 + (v / PERF.steerSpeedRef) * (v / PERF.steerSpeedRef));
        input.steerAxis = clamp(Math.atan(kap * PERF.wheelbase) / lock, -1, 1);
        // in the lane with the limiter on and nothing to stop for: throttle wide open, the limiter holds the speed
        const cruising = input.limiter && u >= uEn && vt >= vLim - 2.5 / 3.6 && dist > 30;
        const err = (cruising ? vLim + 5 : vt) - v;
        integ = clamp(integ + err * HZ_EVERY * STEP * 0.6, 0, 1);
        if (braking) { input.throttle = null; input.brake = 1; integ = 0; }
        else if (cruising) { input.throttle = 1; input.brake = null; }
        else if (err > -0.4) { input.throttle = clamp(0.35 * err + integ + (vt > 0.5 ? 0.15 : 0), 0, 1); input.brake = null; }
        else { input.throttle = null; input.brake = clamp(-0.3 * err, 0, 1); integ *= 0.9; }
        if (input.throttle === 0) input.throttle = null;
      }
    }
    car.update(STEP, input, track);
    t += STEP;
    const g = track.locate(st.x, st.z, truth).index;
    let dg = g - truth; if (dg > N / 2) dg -= N; if (dg < -N / 2) dg += N;
    U += dg; truth = g;
    // checks
    const i = st.sampleIndex, k = kOf(i), inRange = k <= K;
    if (st.hit > 0) { rec.hits++; if (process.env.TRACE) console.log("    hit", f2(st.hit), "t", f1(t), "k", k, "kEn", kEn, "d", f2(st.d), "halfW", f2(S[i].halfW), "wallPos", f2(S[i].wallPosDist), "wallNeg", f2(S[i].wallNegDist), "wallD", f2(pit.wallD(i)), "v", f2(st.speed), "u", U, "ub", ub); }
    if (inRange && st.onGrass) rec.grass++;
    const w = pit.wallD(i);
    if (Number.isFinite(w)) { const gap = Math.abs(st.d - w); rec.minWall = Math.min(rec.minWall, gap); if (gap < lim - 1e-6) rec.wall++; }
    if (st.inPit !== pit.inLane(i, st.d)) rec.inPitBad++;
    if (inRange && k >= kEn && k <= kEx && Math.sign(st.d) === sg && Math.abs(st.d) > S[i].halfW) {
      rec.maxLane = Math.max(rec.maxLane, st.speed);
      if (k > kEn + 10 && k < kEx - 10 && Math.abs(k - kOf(b.index)) > 25) rec.cruise = Math.max(rec.cruise, st.speed);
    }
  }
  done = U >= L - 40;
  const tag = 'box ' + (slot + 1);
  let ok = true;
  const chk = (c, what) => { if (!c) { ok = false; fail(tag + ': ' + what); } };
  chk(done, 'did not get through (U ' + U + ' / ' + (L - 40) + ', ' + f1(t) + ' s)');
  chk(rec.hits === 0, rec.hits + ' steps with a wall contact');
  chk(rec.grass === 0, rec.grass + ' steps on "grass" in the pit complex');
  chk(rec.wall === 0, rec.wall + ' steps closer to the pit wall than ' + lim + ' m (min ' + f2(rec.minWall) + ')');
  chk(rec.inPitBad === 0, 'state.inPit disagreed with pit.inLane in ' + rec.inPitBad + ' steps');
  chk(rec.maxLane * 3.6 <= pit.limitKmh + 0.5, 'max ' + f2(rec.maxLane * 3.6) + ' km/h in the lane (limit ' + pit.limitKmh + ')');
  chk(rec.cruise * 3.6 >= pit.limitKmh - 2.5 || rec.cruise === 0, 'cruised at only ' + f2(rec.cruise * 3.6) + ' km/h with the limiter');
  chk(!!stopped, 'never stopped in the box');
  if (stopped) chk(Math.abs(stopped.along) < 0.3 && Math.abs(stopped.across) < 0.2 && Math.abs(stopped.hd) < 3 * Math.PI / 180 && stopped.inPit,
    'stopped ' + f2(stopped.along) + ' m along, ' + f2(stopped.across) + ' m across, ' + f2(stopped.hd * 180 / Math.PI) + ' deg, inPit ' + stopped.inPit);
  return { ok, rec, stopped, t };
}

const t0 = Date.now();
let passes = 0;
for (const td of global.F1_TRACKS) {
  if (filter && !filter.test(td.id) && !filter.test(td.name)) continue;
  const track = F1.buildTrack(td), pit = track.pit;
  if (!pit) { failures++; console.log('FAIL ' + td.id + ': no pit lane'); continue; }
  const slots = boxesArg === 'all' ? [...Array(pit.boxes.length).keys()] : boxesArg.split(',').map(Number);
  let fails = 0, maxK = 0, cruiseMin = Infinity, worstAlong = 0, worstAcross = 0, minWall = Infinity, tSum = 0;
  for (const slot of slots) {
    const r = driveBox(track, slot, msg => { fails++; failures++; if (fails <= 4) console.log('  FAIL ' + td.id + ' ' + msg); });
    passes++;
    maxK = Math.max(maxK, r.rec.maxLane * 3.6);
    if (r.rec.cruise) cruiseMin = Math.min(cruiseMin, r.rec.cruise * 3.6);
    if (r.stopped) { worstAlong = Math.max(worstAlong, Math.abs(r.stopped.along)); worstAcross = Math.max(worstAcross, Math.abs(r.stopped.across)); }
    minWall = Math.min(minWall, r.rec.minWall); tSum += r.t;
  }
  rows.push({ track: td.id, ok: fails ? 'FAIL ' + fails : 'OK', side: pit.side > 0 ? '+n' : '-n', limit: pit.limitKmh, boxes: slots.length,
    maxKmh: f1(maxK), cruiseMinKmh: cruiseMin === Infinity ? '--' : f1(cruiseMin), stopAlong: f2(worstAlong), stopAcross: f2(worstAcross),
    minWallGap: minWall === Infinity ? '--' : f2(minWall), simS: Math.round(tSum) });
  track.dispose();
}
console.table(rows);
console.log((failures ? failures + ' FAILURES' : 'all pit drives passed') + ' (' + passes + ' lane visits, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
process.exit(failures ? 1 : 0);
