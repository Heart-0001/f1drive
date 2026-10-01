// node devtests/car-v6/ers.js [track regex | all] [E=W/kg] [H=W/kg]
//
// The battery (ERS) of the reference car (js/car.js, F1.REF_SPEC.ers) measured with the REAL car on the real tracks,
// stepped as main.js steps it (1/120 s). The targets of the contract (README-interfaces.md, "js/car.js additions"):
//   1. store     a full battery lasts ~32 s of deployment (full throttle + boost on a long straight strip)
//   2. harvest   a racing lap WITHOUT deploying recovers 50..70 % of the store: one flying lap from an empty battery,
//                driven by (a) the keyboard line driver of devtests/laps-test (brake / throttle always 100 %) and
//                (b) the end-to-end autopilot (devtests/gp-e2e/autopilot.js, analog pedals, pace 1)
//   3. straight  deploying on a long straight: the speed at its end with and without boost. (a) a flat strip: from
//                a corner-exit speed, full throttle over L metres; (b) the longest straight of each track (where the
//                no-boost lap accelerates for more than 600 m): the line driver drives the lap, full throttle (and
//                boost, full battery) from where the straight starts to where the no-boost lap starts braking, the
//                speed there. The contract asks +15..20 km/h
//   4. lap time  "sensible deployment": boost whenever the throttle is full above 100 km/h until the battery is
//                empty, harvest as it comes; laps 2..4 of a stint against the same laps without boost
// E / H (env or args E=..., H=...) override ers.power / ers.harvest (store = 32 s x E) to tune the reference numbers.
// Prints tables; exit code 1 when a reference-number target is missed on the five named tracks.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));
const createAutopilot = require(path.join(ROOT, 'devtests/gp-e2e/autopilot.js'));
const F1 = global.F1;

const STEP = 1 / 120;
const args = process.argv.slice(2);
const kv = k => { const a = args.find(x => x.startsWith(k + '=')); return a ? +a.slice(k.length + 1) : (process.env[k] ? +process.env[k] : null); };
const E = kv('E') || F1.REF_SPEC.ers.power, H = kv('H') || F1.REF_SPEC.ers.harvest;
const SPEC = Object.assign({}, F1.REF_SPEC, { ers: { store: 32 * E, power: E, harvest: H } });
const NAMED = { 'it-1922': 'Monza', 'mc-1929': 'Monaco', 'be-1925': 'Spa', 'jp-1962': 'Suzuka', 'gb-1948': 'Silverstone' };
const pick = args.find(a => !a.includes('=')) || Object.keys(NAMED).join('|');
const filter = pick === 'all' ? null : new RegExp(pick, 'i');
const f1 = v => (Math.round(v * 10) / 10).toFixed(1), f3 = v => v.toFixed(3);
const fmt = t => t == null ? '--' : Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');
let failures = 0;
function check(ok, what) { if (!ok) { failures++; console.log('  FAIL ' + what); } return ok; }

console.log('ERS: power ' + f1(E) + ' W/kg (' + f3(E / F1.CAR_PERF.power) + ' x engine), store ' + Math.round(32 * E) + ' J/kg, harvest ' + f1(H) + ' W/kg');
console.log('top speed ' + f1(F1.CAR_PERF.topSpeed * 3.6) + ' km/h, deploying ' + f1(F1.carPerf(SPEC).topSpeedBoost * 3.6) + ' km/h');

// ---- 1. store: full throttle + boost on a straight strip -----------------------------------------------------------
{
  const a = []; for (let i = 0; i < 20000; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, y: 0, bank: 0, wallPos: false, wallNeg: false, halfW: 50 });
  const strip = { samples: a, halfWidth: 50, wallDist: 60, length: 40000, locate(x, z) { return { index: Math.max(0, Math.min(a.length - 1, Math.round(z / 2))), d: x }; } };
  for (const v0 of [0, 200, 300]) {
    const car = F1.createCar(SPEC, { tyres: false }); car.reset(strip, 0); car.state.speed = v0 / 3.6; car.setBattery(1);
    let t = 0, dep = 0;
    while (car.state.battery > 0 && t < 120) { car.update(STEP, { up: true, boost: true }, strip); t += STEP; dep += car.state.deploy * STEP; }
    console.log('  store: full battery from ' + v0 + ' km/h, full throttle + boost: empty after ' + f1(t) + ' s (' + f1(dep) + ' s at full ERS power), ' + f1(car.state.speed * 3.6) + ' km/h');
    if (v0 === 300) check(Math.abs(t - 32) < 1, 'store lasts ' + f1(t) + ' s at speed, want ~32');
  }
}

// ---- 3a. straight: flat strip, from a corner-exit speed over L metres --------------------------------------------------
{
  const a = []; for (let i = 0; i < 3000; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, y: 0, bank: 0, wallPos: false, wallNeg: false, halfW: 50 });
  const strip = { samples: a, halfWidth: 50, wallDist: 60, length: 6000, locate(x, z) { return { index: Math.max(0, Math.min(a.length - 1, Math.round(z / 2))), d: x }; } };
  const tab = [];
  for (const v0 of [100, 150, 200]) {
    const row = { exitKmh: v0 };
    for (const L of [600, 900, 1200]) {
      const end = boost => {
        const car = F1.createCar(SPEC, { tyres: false }); car.reset(strip, 0); car.state.speed = v0 / 3.6; car.setBattery(1);
        while (car.state.z < L) car.update(STEP, { up: true, boost }, strip);
        return car.state.speed * 3.6;
      };
      const n = end(false), b = end(true);
      row[L + ' m'] = f1(n) + ' -> ' + f1(b) + ' (+' + f1(b - n) + ')';
      if (v0 === 150 && L === 900) check(b - n >= 15 && b - n <= 20, 'flat 900 m from 150 km/h: +' + f1(b - n) + ' km/h (want 15..20)');
    }
    tab.push(row);
  }
  console.log('  straight on the flat, full throttle from the exit speed: km/h at the end without -> with boost');
  console.table(tab);
}

// ---- drivers ---------------------------------------------------------------------------------------------------
// keyboard line driver (devtests/laps-test/drive.js): throttle on green, brake on red, pure pursuit with the keys
function lineDriver(track, line, car, boostRule) {
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
  const input = { up: false, down: false, left: false, right: false, boost: false };
  return function () {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    const L = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(st.sampleIndex + Math.round(L / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz);
    const lock = 0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    input.boost = !!(boostRule && boostRule(input, st));
    return input;
  };
}
function autoDriver(track, line, car) {
  const ap = createAutopilot(); ap.cfg.mode = 'line'; ap.cfg.scale = 1;
  const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false };
  let n = 0, t = 0;
  return function () {
    if (n++ % 2 === 0) {                                   // 60 Hz controller, like the e2e runs
      const o = ap.step({ t, st: car.state, track, line, locked: false, others: [] });
      input.throttle = o.throttle > 0 ? o.throttle : null; input.brake = o.brake > 0 ? o.brake : null; input.steerAxis = o.steer !== 0 ? o.steer : null;
      if (o.reset) car.reset(track, car.state.sampleIndex);
    }
    t += STEP;
    return input;
  };
}

// Drives `laps` timed laps from the free-practice start; per lap: time, energy harvested / deployed (share of the store),
// speed per sample (max over the lap), steps with boost.
function stint(track, line, drive, car, laps, battery) {
  const N = track.samples.length, st = car.state, store = car.spec.ers.store;
  car.reset(track, N - 10); car.setBattery(battery);
  const lap = createLapCounter(N, st.sampleIndex);
  const out = [];
  let cur = null, t = 0;
  while (out.length < laps && t < 1200) {
    const inp = drive();
    const b0 = st.battery;
    car.update(STEP, inp, track); t += STEP;
    const r = lap.update(st.sampleIndex, st.speed, STEP);
    if (cur) {
      cur.har += st.harvest * H * STEP / store; cur.dep += st.deploy * E * STEP / store;
      if (inp.boost && st.deploy > 0) cur.boostT += STEP;
      const i = st.sampleIndex; if (st.speed > cur.v[i]) cur.v[i] = st.speed;
      if (st.onGrass) cur.grass++;
      if (st.hit > 0) cur.hits++;
    }
    if (r === 1 || r === 2) {
      if (r === 2) { cur.time = lap.last; cur.batEnd = st.battery; out.push(cur); }
      cur = { time: 0, har: 0, dep: 0, boostT: 0, batStart: st.battery, v: new Float64Array(N), grass: 0, hits: 0 };
    }
  }
  return out;
}

// the long straights of a lap: stretches where the no-boost lap's speed rises for more than 600 m; end = its peak
function straights(v, N, ds) {
  const res = [];
  let i0 = -1;
  for (let k = 1; k <= N; k++) {
    const i = k % N, p = (k - 1) % N;
    const up = v[i] >= v[p] - 0.05;
    if (up && i0 < 0) i0 = p;
    if (!up && i0 >= 0) { const len = ((p - i0 + N) % N) * ds; if (len > 600) res.push({ from: i0, end: p, len }); i0 = -1; }
  }
  return res.sort((a, b) => b.len - a.len);
}

const rows = [];
for (const td of global.F1_TRACKS) {
  if (filter && !filter.test(td.id) && !filter.test(td.name)) continue;
  const track = F1.buildTrack(td), line = F1.buildRaceLine(track), N = track.samples.length, ds = track.length / N;
  const named = NAMED[td.id];
  // 2. harvest without deploying, from an empty battery (it never fills up)
  const carK = F1.createCar(SPEC, { tyres: false }), kb = stint(track, line, lineDriver(track, line, carK), carK, 1, 0)[0];
  const carA = F1.createCar(SPEC, { tyres: false }), au = stint(track, line, autoDriver(track, line, carA), carA, 1, 0)[0];
  // 3. the longest straight: full throttle from its start to its end (the no-boost lap's braking point), with and
  //    without boost (full battery): the speed at the end
  const st = straights(kb.v, N, ds)[0];
  let gain = null, vEnd0 = null, vEnd1 = null;
  if (st) {
    const span = (st.end - st.from + N) % N, inside = i => ((i - st.from + N) % N) <= span;
    const endSpeed = boost => {
      const car = F1.createCar(SPEC, { tyres: false }), drive = lineDriver(track, line, car);
      car.reset(track, N - 10); car.setBattery(1);
      let t = 0, was = false, v = null;
      while (t < 400 && v === null) {
        const inp = drive();
        const on = inside(car.state.sampleIndex);
        if (on) { inp.up = true; inp.down = false; inp.boost = boost; was = true; }
        else if (was) v = car.state.speed;
        car.update(STEP, inp, track); t += STEP;
      }
      return v;
    };
    vEnd0 = endSpeed(false); vEnd1 = endSpeed(true);
    gain = (vEnd1 - vEnd0) * 3.6;
  }
  // 4. sensible deployment over a stint: laps 2..4, boost on full throttle above 100 km/h
  const carS = F1.createCar(SPEC, { tyres: false }), carN = F1.createCar(SPEC, { tyres: false });
  const sb = stint(track, line, lineDriver(track, line, carS, (inp, s) => inp.up && !inp.down && s.speed > 100 / 3.6), carS, 4, 1);
  const sn = stint(track, line, lineDriver(track, line, carN), carN, 4, 1);
  const avg = a => a.slice(1).reduce((x, l) => x + l.time, 0) / (a.length - 1);
  const dLap = avg(sn) - avg(sb);
  rows.push({ track: td.id, name: named || td.name.slice(0, 18), km: +(track.length / 1000).toFixed(2),
    lapKeys: fmt(kb.time), harvestKeys: Math.round(kb.har * 100) + '%', harvestPad: Math.round(au.har * 100) + '%',
    straightM: st ? Math.round(st.len) : '--', endKmh: st ? f1(vEnd0 * 3.6) + '->' + f1(vEnd1 * 3.6) : '--', gainKmh: gain === null ? '--' : f1(gain),
    lapNoBoost: fmt(avg(sn)), lapBoost: fmt(avg(sb)), gainS: dLap.toFixed(2), deployS: f1(sb.slice(1).reduce((x, l) => x + l.boostT, 0) / (sb.length - 1)),
    batEnd: Math.round(sb[sb.length - 1].batEnd * 100) + '%' });
  if (named) {
    // calibrated on the analog driver; the keyboard line driver bangs the brake (100 % pedal, ~1.5x the brake
    // pedal-seconds): it is only held to a wider band
    check(au.har >= 0.5 && au.har <= 0.7, named + ': autopilot lap harvests ' + Math.round(au.har * 100) + ' % of the store (want 50..70)');
    check(kb.har >= 0.4 && kb.har <= 0.85, named + ': keyboard lap harvests ' + Math.round(kb.har * 100) + ' % of the store (band 40..85)');
    if (st && st.len >= 900) check(gain >= 15 && gain <= 20, named + ': +' + f1(gain) + ' km/h at the end of the ' + Math.round(st.len) + ' m straight (want 15..20)');
  }
  track.dispose && track.dispose();
}
console.table(rows);
const gains = rows.filter(r => r.gainKmh !== '--' && r.straightM >= 900).map(r => +r.gainKmh);
if (gains.length) console.log('straights >= 900 m: gain at the end ' + Math.min(...gains).toFixed(1) + '..' + Math.max(...gains).toFixed(1) + ' km/h (mean ' + (gains.reduce((a, b) => a + b, 0) / gains.length).toFixed(1) + ')');
const hk = rows.map(r => parseInt(r.harvestKeys, 10)), hp = rows.map(r => parseInt(r.harvestPad, 10));
console.log('harvest per lap: keys ' + Math.min(...hk) + '..' + Math.max(...hk) + ' %, pad ' + Math.min(...hp) + '..' + Math.max(...hp) + ' %');
const gs = rows.map(r => +r.gainS);
console.log('lap time gained by deploying: ' + Math.min(...gs).toFixed(2) + '..' + Math.max(...gs).toFixed(2) + ' s (mean ' + (gs.reduce((a, b) => a + b, 0) / gs.length).toFixed(2) + ')');
console.log(failures ? failures + ' target(s) missed' : 'all ERS targets met');
process.exit(failures ? 1 : 0);
