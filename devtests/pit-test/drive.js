// node devtests/pit-test/drive.js [track regex | all] [today|paved|both]
//
// Drives the pit lane of js/track.js with the REAL js/car.js (as it is: it knows nothing about track.pit yet) and
// counts the lap with the REAL js/laps.js, stepped as main.js steps them (1/120 s, the counter fed after every step):
//   1. the car starts on the centreline 300 m before the lane (pit.from), lap.reset(); the gp-e2e autopilot drives the
//      racing line (scale 0.8) past the pit lane and over the line (timing starts), then round the whole lap;
//   2. 250 m before the lane a lane follower takes over: pure pursuit of a target path (the car's line -> pit.laneD ->
//      box 14 -> laneD -> box 3 -> laneD -> the track), speed from the limit (limitKmh - 1), the path's curvature
//      and braking; it stops in box 14 (slot 13) and box 3 (slot 2) for 1.5 s each (nose on the stop bar), crosses
//      the line in the lane (Monaco: in the lane's entry taper, see check.js), leaves through the exit taper and
//      drives on for 150 m.
// Checks from the take-over on: no wall contact (car.state.hit), the car body never overlaps the pit wall
// (pit.wallD +- wallHalfT, car.js collides with it only later) and never crosses it, inside the outer wall, between the
// entry and exit lines always pit.inLane(sampleIndex, d) (so car.js will not call it grass), off the road elsewhere in
// from..to always pit.paved(), no sample index jumps (<= 3 samples per step, never more than 2 from the locally
// tracked ground truth), at most limitKmh + 3 between the lines, stopped in each box within 0.3 m along / 0.2 m across,
// the lap completed by the crossing in the lane with the time of the ground truth.
// Modes: today = car.js as it is (the lane counts as grass for it: grass drag holds ~80 km/h at full throttle, grass
// grip); paved = the same car with the lane's samples widened (halfW out to the pit side's wall) through a proxy
// track, i.e. what car.js will do once it treats the lane as asphalt. Default: both. Exit code 1 when a check fails.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));        // the game loads it: the pit side follows the real pit buildings
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));
const createAutopilot = require(path.join(ROOT, 'devtests/gp-e2e/autopilot.js'));
const F1 = global.F1, PERF = F1.CAR_PERF;

const STEP = 1 / 120, HZ_EVERY = 2;              // physics at 120 Hz, the controllers at 60 Hz
const TRACE = !!process.env.TRACE;
const DEFAULT = 'it-1922|mc-1929|be-1925|jp-1962|gb-1948|br-1940|sg-2008|us-2023';
const arg = process.argv[2] || DEFAULT;
const filter = arg === 'all' ? null : new RegExp(arg, 'i');
const modes = (process.argv[3] || 'both') === 'both' ? ['today', 'paved'] : [process.argv[3]];
const STOPS = [13, 2];                            // slots: box 14, then box 3
const HOLD = 1.5;
const A_LAT = 7, A_BRAKE = 5, A_STOP = 2.5;       // what the follower asks of the car (today's grass: grip ~9, brakes 6)

let failures = 0;
const results = [];
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const f1 = v => (Math.round(v * 10) / 10).toFixed(1), f2 = v => (Math.round(v * 100) / 100).toFixed(2);
const fmt = t => t == null ? '--' : Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');

// A proxy of the track whose lane samples are road out to the pit side's wall (what car.js will do with pit.paved).
function pavedProxy(track) {
  const pit = track.pit, S = track.samples, N = S.length, K = ((pit.to - pit.from) % N + N) % N;
  const S2 = S.map(s => Object.assign({}, s));
  for (let k = 0; k <= K; k++) {
    const i = (pit.from + k) % N;
    S2[i].halfW = Math.max(S[i].halfW, (pit.side > 0 ? S[i].wallPosDist : S[i].wallNegDist) - 0.01);
  }
  const t = Object.create(track);
  t.samples = S2;
  return t;
}

function driveTrack(td, mode) {
  const track = F1.buildTrack(td), S = track.samples, N = S.length, ds = track.length / N, pit = track.pit;
  const id = td.id, tag = id + ' [' + mode + ']', fails0 = failures;
  function check(ok, what) { if (!ok) { failures++; console.log('    FAIL ' + tag + ': ' + what); } return ok; }
  if (!check(!!pit, 'no pit lane')) return;
  const phys = mode === 'paved' ? pavedProxy(track) : track;
  const line = F1.buildRaceLine(track);
  const wq = q => ((q % N) + N) % N, wrapD = d => d > N / 2 ? d - N : (d < -N / 2 ? d + N : d);
  const K = wq(pit.to - pit.from), kOf = i => wq(i - pit.from);
  const kEn = kOf(pit.entry), kEx = kOf(pit.exit), sg = pit.side, vLim = pit.limitKmh / 3.6;
  const wallDist = i => sg > 0 ? S[i].wallPosDist : S[i].wallNegDist;

  // --- the car, the counter, the ground truth (continuous position from a local locate)
  const car = F1.createCar(), st = car.state, ap = createAutopilot();
  const start = wq(pit.from - Math.round(300 / ds));
  car.reset(phys, start);
  const lap = createLapCounter(N, st.sampleIndex);
  let truth = st.sampleIndex, U = 0, lines = 0;          // U: samples driven since the start
  const uLane = wq(pit.from - start);                    // U of pit.from on the first pass; the second pass is + N
  const uTake = N + uLane - Math.round(250 / ds), uEnd = N + uLane + K + Math.round(150 / ds);
  ap.cfg = { mode: 'line', scale: 0.8 };
  const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null };

  // --- the lane follower's target: signed lateral offset per unwrapped U from uTake to uEnd
  const U0 = uTake, L = uEnd - uTake + Math.round(40 / ds);
  const tgt = new Float64Array(L + 1), vmax = new Float64Array(L + 1).fill(Infinity), stopU = [];
  let dTake = 0;
  function buildTarget() {
    const iOf = u => wq(start + U0 + u);
    const laneAt = u => { const d = pit.laneD(iOf(u)); return Number.isFinite(d) ? d : null; };
    const uFrom = uLane + N - U0, uTo = uFrom + K;
    for (let u = 0; u <= L; u++) {
      if (u < uFrom) { const f = (u - 0) / Math.max(1, uFrom - 10); tgt[u] = dTake + (laneAt(uFrom) - dTake) * (f >= 1 ? 1 : f * f * (3 - 2 * f)); }
      else if (u <= uTo) tgt[u] = laneAt(u);
      else tgt[u] = tgt[uTo];
    }
    // the stops: into the box over 24 m, 8 m straight in the box, out again over 24 m after it
    for (const slot of STOPS) {
      const b = pit.boxes[slot], ub = uFrom + kOf(b.index);
      stopU.push({ slot, u: ub, box: b });
      const a0 = ub - Math.round(32 / ds), a1 = ub - Math.round(8 / ds), b0 = ub + Math.round(4 / ds), b1 = ub + Math.round(28 / ds);
      for (let u = a0; u <= b1; u++) {
        let f = u < a1 ? (u - a0) / (a1 - a0) : (u <= b0 ? 1 : 1 - (u - b0) / (b1 - b0));
        f = clamp(f, 0, 1); f = f * f * (3 - 2 * f);
        tgt[u] = tgt[u] + (b.d - tgt[u]) * f;
      }
    }
    // speed: the limit (1 km/h under) from 20 m before the entry line to the exit line, the path's curvature, braking
    const P = [];
    for (let u = 0; u <= L; u++) { const i = iOf(u), s = S[i]; P.push([s.x + s.nx * tgt[u], s.z + s.nz * tgt[u]]); }
    for (let u = 2; u <= L - 2; u++) {
      const a = P[u - 2], b = P[u], c = P[u + 2];
      const ax = b[0] - a[0], az = b[1] - a[1], bx = c[0] - a[0], bz = c[1] - a[1];
      const kap = 2 * Math.abs(ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(c[0] - b[0], c[1] - b[1]) + 1e-9);
      vmax[u] = Math.min(vmax[u], Math.sqrt(A_LAT / Math.max(kap, 1e-6)));
    }
    for (let u = uFrom - Math.round(20 / ds); u <= L; u++) vmax[u] = Math.min(vmax[u], vLim - 1 / 3.6);
    for (const sp of stopU) vmax[sp.u] = 2;              // the last metres: by the distance to the stop (below)
    for (let u = L - 1; u >= 0; u--) {
      const acc = stopU.some(sp => u < sp.u && sp.u - u < 40 / ds) ? A_STOP : A_BRAKE;
      vmax[u] = Math.min(vmax[u], Math.sqrt(vmax[u + 1] * vmax[u + 1] + 2 * acc * ds));
    }
  }

  let mode2 = 'ap', t = 0, n = 0, integ = 0, stopI = 0, holdT = 0, took = null;
  const rec = { hits: 0, maxHit: 0, wallOverlap: 0, wallCross: 0, outer: 0, grassLane: 0, grassTaper: 0, jumps: 0, drift: 0,
    maxLane: 0, cruise: 0, stops: [], lapCodes: [], crossings: [], laneCross: false, tEntry: null, tExit: null, maxUd: 0 };
  let wallSide = 0, prevIdx = st.sampleIndex, tLine0 = null, lapTruth = null;

  while (U < uEnd && t < 600) {
    if (n++ % HZ_EVERY === 0) {
      if (mode2 === 'ap' && U >= uTake) {
        mode2 = 'lane'; took = t; dTake = st.d; buildTarget();
      }
      if (mode2 === 'ap') {
        const o = ap.step({ t, st, track, line, locked: false, others: [] });
        input.throttle = o.throttle > 0 ? o.throttle : null; input.brake = o.brake > 0 ? o.brake : null; input.steerAxis = o.steer !== 0 ? o.steer : null;
        if (o.reset) { car.reset(phys, st.sampleIndex); lap.sync(st.sampleIndex); }
      } else {
        const u = clamp(U - U0, 0, L - 1), v = Math.max(0, st.speed);
        // stop in a box: speed from the distance left to its stopping position, then hold
        let vt = vmax[u];
        const sp = stopU[stopI];
        let dist = Infinity;
        if (sp) {
          const b = sp.box, fx = Math.sin(b.heading), fz = Math.cos(b.heading);
          dist = (b.x - st.x) * fx + (b.z - st.z) * fz;
          if (dist < 25) vt = Math.min(vt, Math.sqrt(2 * 1.2 * Math.max(0, dist - 0.05)) + (dist > 0.05 ? 0.25 : 0));
        }
        const braking = sp && dist < 0.06;                 // at the stopping position (or past it): brake to a halt
        if (holdT > 0) {
          holdT -= HZ_EVERY * STEP;
          input.throttle = null; input.brake = 1; input.steerAxis = null;
          if (holdT <= 0) stopI++;
        } else if (braking && v < 0.02) {
          const b = sp.box, lx = Math.cos(b.heading), lz = -Math.sin(b.heading);
          holdT = HOLD;
          input.throttle = null; input.brake = 1;
          const along = -dist, across = (st.x - b.x) * lx + (st.z - b.z) * lz, hd = Math.atan2(Math.sin(st.heading - b.heading), Math.cos(st.heading - b.heading));
          rec.stops.push({ box: sp.slot + 1, along, across, hd, v: st.speed, inLane: pit.inLane(st.sampleIndex, st.d) });
        } else {
          // pure pursuit of the target path
          const la = clamp(4 + 0.35 * v, 5, 20), j = clamp(u + Math.round(la / ds), 0, L), i = wq(start + U0 + j), s = S[i];
          const gx = s.x + s.nx * tgt[j] - st.x, gz = s.z + s.nz * tgt[j] - st.z;
          const sh = Math.sin(st.heading), ch = Math.cos(st.heading);
          const xf = gx * sh + gz * ch, yl = gx * ch - gz * sh;
          const kap = 2 * yl / (xf * xf + yl * yl);
          const lock = PERF.steerLock / (1 + (v / PERF.steerSpeedRef) * (v / PERF.steerSpeedRef));
          input.steerAxis = clamp(Math.atan(kap * PERF.wheelbase) / lock, -1, 1);
          const err = vt - v;
          integ = clamp(integ + err * HZ_EVERY * STEP * 0.6, 0, 1);
          if (braking) { input.throttle = null; input.brake = 1; integ = 0; }
          else if (err > -0.4) { input.throttle = clamp(0.35 * err + integ + (vt > 0.5 ? 0.15 : 0), 0, 1); input.brake = null; }
          else { input.throttle = null; input.brake = clamp(-0.3 * err, 0, 1); integ *= 0.9; }
          if (input.throttle === 0) input.throttle = null;
        }
      }
    }
    if (TRACE && mode2 === 'lane' && n % 60 === 0) {     // env TRACE=1: the follower twice a second
      const sp = stopU[stopI], b = sp && sp.box;
      console.log('    t ' + f1(t) + ' U ' + U + ' v ' + f2(st.speed) + ' d ' + f2(st.d) + ' thr ' + (input.throttle || 0).toFixed(2) +
        ' brk ' + (input.brake || 0).toFixed(2) + ' steer ' + (input.steerAxis || 0).toFixed(2) + ' hold ' + f2(holdT) +
        (b ? ' to box ' + (sp.slot + 1) + ' ' + f2((b.x - st.x) * Math.sin(b.heading) + (b.z - st.z) * Math.cos(b.heading)) + ' m' : ''));
    }
    car.update(STEP, input, phys);
    const code = lap.update(st.sampleIndex, st.speed, STEP);
    t += STEP;
    // ground truth
    const g = track.locate(st.x, st.z, truth).index, dg = wrapD(g - truth);
    U += dg; truth = g;
    if (Math.floor(U / N + start / N) >= 0 && Math.floor((U + start) / N) >= lines + 1) {
      lines = Math.floor((U + start) / N);
      rec.crossings.push({ t, lane: mode2 === 'lane', k: kOf(st.sampleIndex), d: st.d });
      if (lines === 1) tLine0 = t; else if (lines === 2) lapTruth = t - tLine0;
    }
    if (code) rec.lapCodes.push({ code, t, last: lap.last, lane: mode2 === 'lane', k: kOf(st.sampleIndex), inPit: kOf(st.sampleIndex) <= K });
    const di = Math.abs(wrapD(st.sampleIndex - prevIdx)); prevIdx = st.sampleIndex;
    rec.maxUd = Math.max(rec.maxUd, Math.abs(wrapD(st.sampleIndex - truth)));
    if (mode2 !== 'lane') continue;
    // --- checks from the take-over on
    if (di > 3) rec.jumps++;
    if (Math.abs(wrapD(st.sampleIndex - truth)) > 2) rec.drift++;
    if (st.hit > 0) { rec.hits++; rec.maxHit = Math.max(rec.maxHit, st.hit); }
    const i = st.sampleIndex, k = kOf(i), d = st.d, inRange = k <= K;
    const w = pit.wallD(i);
    if (Number.isFinite(w)) {
      const side = Math.sign((d - w) * sg);
      if (Math.abs(d - w) < pit.wallHalfT + 1.0) rec.wallOverlap++;
      if (wallSide && side !== wallSide) rec.wallCross++;
      wallSide = side;
    } else wallSide = 0;
    if (inRange && Math.sign(d) === sg && Math.abs(d) + 1.0 > wallDist(i) + 1e-6) rec.outer++;
    if (inRange && k >= kEn && k <= kEx) {
      if (!pit.inLane(i, d)) rec.grassLane++;
      rec.maxLane = Math.max(rec.maxLane, st.speed);
      if (rec.tEntry === null) rec.tEntry = t;
    } else if (inRange && Math.abs(d) > S[i].halfW && !pit.paved(i, d)) rec.grassTaper++;
    if (inRange && k > kEx && rec.tExit === null) rec.tExit = t;
    if (inRange && k > kEn + 5 && k < kEx - 5 && Math.abs(d - pit.laneD(i)) < 0.8) rec.cruise = Math.max(rec.cruise, st.speed);
  }

  // --- verdict
  const lapDone = rec.lapCodes.find(c => c.code === 2), lapStart = rec.lapCodes.find(c => c.code === 1);
  check(U >= uEnd, 'did not get through (U ' + U + ' / ' + uEnd + ', ' + f1(t) + ' s, phase ' + mode2 + ')');
  check(!!lapStart && !lapStart.lane, 'timing did not start on the first crossing (on the track)');
  check(!!lapDone && lapDone.lane && lapDone.inPit, 'the lap was not completed by the crossing in the pit lane ' + JSON.stringify(lapDone || null));
  if (lapDone) check(lapTruth !== null && Math.abs(lapDone.last - lapTruth) < 2 * STEP, 'lap time ' + fmt(lapDone.last) + ' vs ground truth ' + fmt(lapTruth));
  check(rec.lapCodes.filter(c => c.code === 2).length === 1, 'laps counted: ' + rec.lapCodes.filter(c => c.code === 2).length);
  check(lap.jumps === 0 && !lap.void, 'lap counter saw ' + lap.jumps + ' jumps, void ' + lap.void);
  check(rec.hits === 0, rec.hits + ' steps with wall contact (max ' + f2(rec.maxHit) + ')');
  check(rec.wallOverlap === 0, rec.wallOverlap + ' steps with the car body over the pit wall');
  check(rec.wallCross === 0, 'crossed the pit wall ' + rec.wallCross + ' times');
  check(rec.outer === 0, rec.outer + ' steps with the car body beyond the outer wall');
  check(rec.grassLane === 0, rec.grassLane + ' steps between the lines where inLane() is false (car.js would say grass)');
  check(rec.grassTaper === 0, rec.grassTaper + ' steps in the tapers off the road and off the pit asphalt');
  check(rec.jumps === 0 && rec.drift === 0, 'sample index jumps ' + rec.jumps + ', away from the ground truth ' + rec.drift);
  check(rec.maxLane * 3.6 <= pit.limitKmh + 3, 'max ' + f1(rec.maxLane * 3.6) + ' km/h between the lines (limit ' + pit.limitKmh + ')');
  check(rec.stops.length === STOPS.length, 'stopped in ' + rec.stops.length + ' of ' + STOPS.length + ' boxes');
  for (const s of rec.stops) {
    check(Math.abs(s.along) < 0.3 && Math.abs(s.across) < 0.2 && Math.abs(s.hd) < 0.05 && s.inLane,
      'box ' + s.box + ': stopped ' + f2(s.along) + ' m along, ' + f2(s.across) + ' m across, ' + f2(s.hd * 180 / Math.PI) + ' deg, inLane ' + s.inLane);
  }
  const ok = failures === fails0;
  results.push({ track: id, mode, ok: ok ? 'OK' : 'FAIL', side: sg > 0 ? '+n' : '-n', limit: pit.limitKmh,
    cruiseKmh: f1(rec.cruise * 3.6), maxKmh: f1(rec.maxLane * 3.6), entryToExit: rec.tEntry && rec.tExit ? f1(rec.tExit - rec.tEntry) + ' s' : '--',
    stops: rec.stops.map(s => s.box + ':' + f2(s.along) + '/' + f2(s.across)).join(' '), lap: lapDone ? fmt(lapDone.last) : '--',
    lapIn: lapDone ? 'k ' + lapDone.k + ' of ' + K : '--', hits: rec.hits, grass: rec.grassLane + rec.grassTaper, jumps: rec.jumps });
  console.log((ok ? 'OK   ' : 'FAIL ') + tag.padEnd(22) + ' side ' + (sg > 0 ? '+n' : '-n') + ', ' + pit.limitKmh + ' km/h: cruise ' + f1(rec.cruise * 3.6) +
    ' km/h (max ' + f1(rec.maxLane * 3.6) + '), entry -> exit ' + (rec.tEntry && rec.tExit ? f1(rec.tExit - rec.tEntry) : '--') + ' s incl. 2 stops, lap ' +
    (lapDone ? fmt(lapDone.last) + ' counted in the lane at k ' + lapDone.k + '/' + K : '--') + ', stops ' + rec.stops.map(s => 'box ' + s.box + ' ' + f2(s.along) + '/' + f2(s.across) + ' m').join(', '));
}

const t0 = Date.now();
for (const td of global.F1_TRACKS) {
  if (filter && !filter.test(td.id) && !filter.test(td.name)) continue;
  for (const m of modes) driveTrack(td, m);
}
console.table(results);
console.log((failures ? failures + ' FAILURES' : 'all pit drive checks passed') + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
process.exit(failures ? 1 : 0);
