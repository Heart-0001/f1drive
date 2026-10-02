// Node loader + drivers for the tyre investigation (devtests/tyre-test/README.md): the REAL game modules (js/car.js
// with its js/tyres.js set, js/raceline.js, js/ai.js ...), loaded as devtests/ai-test/lib.js loads them.
//
//   const T = require('./lib');
//   T.drive({ track: 'be-1925', car: '2023-red-bull', driver: 'line' | 'keys' | 'kerb' | 'ai', compound: 'M',
//             wear: 1, laps: 3, seed: 1, onSecond(row), onStep(ctx) }) -> result
//     line   the end-to-end autopilot (devtests/gp-e2e/autopilot.js): racing line at full pace, analog pedals
//     keys   the calibration's keyboard driver (devtests/seasons-calib/driver.mjs): pure pursuit on the line, every
//            brake / throttle 100 %, its own late braking (brakes only when the line's advice is red)
//     kerb   'keys' driven like a human: brakes LATER than the line advises (levels[2] >= 0.75), cuts the inside
//            (the path is moved 1.3 m further to the inside of every corner: over the kerb), and some sliding
//     human  a keyboard human: looks at the road every 1/15 s and holds / releases the keys until the next look (so the
//            steering overshoots and centres in pulses, as keys do: 3..5 /s turning in, 6 /s centring); brakes late
//            (levels[2] >= 0.75), cuts the inside over the kerbs like 'kerb'; o.lookHz changes the rate, o.cut the cut
//     pad    a controller human: 'human' with the stick instead of the keys - the stick is pushed o.gain (1.5) x as far
//            as the corner needs (full deflection in every slow / medium corner), triggers fully in, late braking, kerbs
//     ai     js/ai.js (F1.createAIDriver, skill 1), alone on the track
//   Shadow sets: the same loads are also fed to two more js/tyres.js sets - 'noSlip' (load.slip = 0) and 'clean'
//   (slip, hit and grass removed) - so the share of the wear the sliding / impacts / grass produced is measured.
//   Each step the tyres are fed by js/car.js itself; a wrapper around car.tyres.update logs what car.js fed them.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
if (!global.THREE) global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
// (TYRES_JS=<path>: another copy of js/tyres.js, e.g. HEAD's, for before / after comparisons)
for (const f of ['tracks-data.js', 'js/seasons-data.js', 'js/cars.js', 'js/track.js', 'js/tyres.js', 'js/car.js',
  'js/raceline.js', 'js/collide.js', 'js/laps.js', 'js/pit.js']) {
  require(f === 'js/tyres.js' && process.env.TYRES_JS ? path.resolve(process.env.TYRES_JS) : path.join(ROOT, f));
}
const F1 = global.F1;
require(path.join(ROOT, 'js/ai.js'));
const createAutopilot = require(path.join(ROOT, 'devtests/gp-e2e/autopilot.js'));
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));

const STEP = 1 / 120;
const tracks = new Map(), lines = new Map();
function track(id) {
  if (tracks.has(id)) return tracks.get(id);
  const td = global.F1_TRACKS.find(t => t.id === id || t.name === id);
  if (!td) throw new Error('unknown track ' + id);
  const t = F1.buildTrack(td); t.id = td.id; t.name = td.name; t.km = td.lengthKm;
  tracks.set(id, t);
  return t;
}
function line(t, perf) {
  const key = t.id + '|' + (perf && perf.spec ? perf.spec.id : 'ref');
  if (lines.has(key)) return lines.get(key);
  const l = F1.buildRaceLine(t, perf);
  lines.set(key, l);
  return l;
}
function seeded(s) { s = s >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function spec(id) { return id ? (F1.cars.get(id) || F1.cars.resolve(id)) : F1.REF_SPEC; }

// The hit's source: which wall, kerb / terrain / bump. car.js sets state.hit only at a wall face (outer walls, the pit
// wall) or from car.bump; we classify by where the car is.
function hitSource(t, st) {
  const s = t.samples[st.sampleIndex], d = st.d;
  const wd = d > 0 ? (typeof s.wallPosDist === 'number' ? s.wallPosDist : t.wallDist) : (typeof s.wallNegDist === 'number' ? s.wallNegDist : t.wallDist);
  if (Math.abs(d) >= wd - 1.0 - 0.05) return 'wall' + (d > 0 ? '+' : '-');
  if (t.pit && t.pit.paved && t.pit.paved(st.sampleIndex, d)) return 'pitwall';
  return 'other(d ' + d.toFixed(1) + ')';
}

function drive(o) {
  const t = track(o.track || 'be-1925'), S = t.samples, N = S.length, ds = t.length / N;
  const sp = spec(o.car);
  const car = F1.createCar(sp, { random: seeded(o.seed || 1) });
  const ln = line(t, car.perf);
  const P = ln.points, st = car.state, ty = car.tyres;
  ty.fit(o.compound || 'M'); ty.setWearRate(o.wear === undefined ? 1 : o.wear);
  const driver = o.driver || 'line';
  let ai = null, ctx = null, ap = null, others = [];
  if (driver === 'ai') {
    ai = F1.createAIDriver({ track: t, raceLine: ln, car, skill: o.skill === undefined ? 1 : o.skill, seed: o.seed || 1, id: 1, slot: 0, name: 'AI' });
    ctx = F1.AI.createContext(); ctx.phase = 'free'; ctx.wear = o.wear || 1; ctx.laps = 0; ctx.done = false; ctx.prog = NaN;
    F1.AI.placeOnGrid(car, t, 0); ai.reset();
  } else if (o.startIndex !== undefined) {
    car.reset(t, o.startIndex);
  } else {
    car.reset(t, (N - 10) % N);
  }
  if (driver === 'line') { ap = createAutopilot(); ap.cfg.mode = 'line'; ap.cfg.scale = o.scale || 1; }
  const lap = createLapCounter(N, st.sampleIndex);
  const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false };

  // log what car.js feeds the tyres
  const sec = { n: 0, hitMax: 0, hitSrc: '', slipSum: 0, slipMax: 0, grass: 0, latSum: 0, brkSum: 0, drvSum: 0, vSum: 0, load: 0, comp: 0, compMin: 9, compMax: -9 };
  const tot = { steps: 0, hits: [], slipSteps: 0, grassSteps: 0, maxHit: 0, punctAt: null, punctReason: '', lockSteps: 0 };
  const realUpdate = ty.update;
  const shadow = { noSlip: F1.createTyres({ random: seeded(o.seed || 1) }), clean: F1.createTyres({ random: seeded(o.seed || 1) }) };
  for (const k in shadow) { shadow[k].fit(o.compound || 'M'); shadow[k].setWearRate(o.wear === undefined ? 1 : o.wear); }
  const lNo = { speed: 0, lat: 0, brake: 0, drive: 0, slip: 0, onGrass: false, hit: 0 }, lCl = Object.assign({}, lNo);
  let lastSlip = 0, lastHit = 0, lastBrake = 0;
  ty.update = function (dt, l) {
    if (l) {
      sec.n++; sec.slipSum += l.slip; if (l.slip > sec.slipMax) sec.slipMax = l.slip; if (l.onGrass) sec.grass++;
      sec.latSum += Math.abs(l.lat); sec.brkSum += l.brake; sec.drvSum += l.drive; sec.vSum += l.speed;
      if (l.hit > sec.hitMax) sec.hitMax = l.hit;
      lastSlip = l.slip; lastHit = l.hit; lastBrake = l.brake;
      if (l.slip > 0) tot.slipSteps++;
      if (l.onGrass) tot.grassSteps++;
      if (l.slip > 0.4 && l.brake > 0.5) tot.lockSteps++;
    }
    const before = ty.state.puncture;
    const r = realUpdate.call(ty, dt, l);
    if (l) {
      Object.assign(lNo, l); lNo.slip = 0; shadow.noSlip.update(dt, lNo);
      Object.assign(lCl, l); lCl.slip = 0; lCl.hit = 0; lCl.onGrass = false; shadow.clean.update(dt, lCl);
    }
    if (before < 0 && ty.state.puncture >= 0 && tot.punctAt === null) {
      const p = ty.state.puncture;
      tot.punctAt = { t: time, lap: lapsDone + lapFrac(), wheel: p, wear: ty.state.wear.slice(), hit: l ? l.hit : 0, slip: l ? l.slip : 0 };
      tot.punctReason = l && l.hit > 0.4 ? 'impact ' + l.hit.toFixed(2) : (ty.state.wear[p] >= 1 ? 'worn through' : 'impact? hit ' + (l ? l.hit : 0));
    }
    return r;
  };

  let time = 0, lapsDone = 0, nextSec = 1, kerbSteps = 0;
  const laps = [], rows = [];
  const maxLaps = o.laps || 3;
  function lapFrac() { return ((st.sampleIndex - (lap.startIdx || 0)) % N + N) % N / N; }
  const maxT = o.maxT || maxLaps * 200 + 60;
  while (lapsDone < maxLaps && time < maxT) {
    // ---- the driver
    if (driver === 'line') {
      const out = ap.step({ t: time, st, track: t, line: ln, locked: false, others: [] });
      input.throttle = out.throttle > 0 ? out.throttle : null;
      input.brake = out.brake > 0 ? out.brake : null;
      input.steerAxis = out.steer !== 0 ? out.steer : null;
      if (out.reset) car.reset(t, st.sampleIndex);
    } else if (driver === 'keys' || driver === 'kerb' || driver === 'human' || driver === 'pad') {
      const look = (driver !== 'human' && driver !== 'pad') || (tot.steps % Math.max(1, Math.round(120 / (o.lookHz || 15)))) === 0;
      if (!look) { /* keys held as they were */ } else {
      ln.update(st);
      const v = Math.max(0, st.speed), lv = ln.levels[2];
      if (driver === 'keys') { input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5; }
      else {                                   // later on the brakes, back on the throttle earlier
        const lv1 = ln.levels[1];
        input.up = lv < 0.5 || v < 5; input.down = lv >= 0.75 && lv1 >= 0.75 && v >= 5;
      }
      input.boost = input.up && !input.down && v > 100 / 3.6;
      const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
      const k = (st.sampleIndex + Math.round(Ld / ds)) % N, tp = P[k];
      let tx = tp.x, tz = tp.z;
      if (driver === 'kerb' || ((driver === 'human' || driver === 'pad') && o.cut !== 0)) {               // cut the inside: the target moves to the inside of the corner by up to 1.3 m past the line
        const c = tp.curvature || 0, s = S[k], hw = typeof s.halfW === 'number' ? s.halfW : t.halfWidth;
        if (Math.abs(c) > 1 / 250) {
          const inside = c > 0 ? 1 : -1;     // +curvature = left turn -> inside = +n
          const cut = driver !== 'kerb' && o.cut !== undefined ? o.cut : 1.3;
          const dTarget = Math.max(-hw - 1.3, Math.min(hw + 1.3, (tp.d || 0) + inside * cut));
          const extra = dTarget - (tp.d || 0);
          tx += s.nx * extra; tz += s.nz * extra;
        }
      }
      const dx = tx - st.x, dz = tz - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
      const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
      const lock = car.perf.steerLockAt(v, S[st.sampleIndex].bank || 0, kap >= 0 ? 1 : -1);
      const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
      if (driver === 'pad') {
        const g = o.gain || 1.5, ax = Math.max(-1, Math.min(1, g * want));
        input.steerAxis = ax !== 0 ? ax : null; input.left = input.right = false;
        input.throttle = input.up ? 1 : null; input.brake = input.down ? 1 : null; input.up = input.down = false;
      } else {
        const dead = driver === 'human' ? 0.05 : 0.03;
        input.left = want > st.steer + dead; input.right = want < st.steer - dead;
      }
      }
    } else if (driver === 'ai') {
      const inp = ai.think(STEP, others, ctx);
      if (inp.reset) { F1.AI.resetCar(car, t, st.sampleIndex); lap.sync(st.sampleIndex); }
      Object.assign(input, inp);
    }
    if (o.onStep) o.onStep({ time, st, car, input, ty });
    car.update(STEP, input, t);
    time += STEP;
    tot.steps++;
    if (st.hit > 0) {
      const src = hitSource(t, st);
      if (st.hit > tot.maxHit) tot.maxHit = st.hit;
      if (st.hit > sec.hitMax - 1e-9) sec.hitSrc = src;
      if (tot.hits.length < 400) tot.hits.push([+time.toFixed(2), +st.hit.toFixed(3), src, st.sampleIndex, +st.d.toFixed(2), +(st.speed * 3.6).toFixed(0)]);
    }
    const hw = typeof S[st.sampleIndex].halfW === 'number' ? S[st.sampleIndex].halfW : t.halfWidth;
    if (Math.abs(st.d) > hw - 1.0 && !st.onGrass) kerbSteps++;
    sec.load += st.load; sec.comp += st.compress; if (st.compress < sec.compMin) sec.compMin = st.compress; if (st.compress > sec.compMax) sec.compMax = st.compress;
    if (ctx) { ctx.lap = lapsDone; }
    const c = lap.update(st.sampleIndex, st.speed, STEP);
    if (c === 2) { laps.push(lap.last); lapsDone++; }
    if (time >= nextSec) {
      const s = ty.state, n = Math.max(1, sec.n), m = Math.max(1, Math.round(1 / STEP));
      const row = { t: Math.round(time), lap: lapsDone, idx: st.sampleIndex, kmh: +(sec.vSum / n * 3.6).toFixed(0),
        wear: s.wear.map(x => +(x * 100).toFixed(2)), temp: s.temp.map(x => +x.toFixed(1)), flat: s.flat.map(x => +x.toFixed(3)),
        grip: [s.grip.lat, s.grip.brake, s.grip.traction].map(x => +x.toFixed(4)), punct: s.puncture, dirt: +s.dirt.toFixed(2),
        lat: +(sec.latSum / n).toFixed(2), brk: +(sec.brkSum / n).toFixed(2), drv: +(sec.drvSum / n).toFixed(2),
        slip: +(sec.slipSum / n).toFixed(3), slipMax: +sec.slipMax.toFixed(2), grass: sec.grass, hit: +sec.hitMax.toFixed(3), hitSrc: sec.hitSrc,
        load: +(sec.load / m).toFixed(2), comp: +(sec.comp / m).toFixed(2), compMin: +sec.compMin.toFixed(2), compMax: +sec.compMax.toFixed(2) };
      rows.push(row);
      if (o.onSecond) o.onSecond(row);
      nextSec += 1;
      Object.assign(sec, { n: 0, hitMax: 0, hitSrc: '', slipSum: 0, slipMax: 0, grass: 0, latSum: 0, brkSum: 0, drvSum: 0, vSum: 0, load: 0, comp: 0, compMin: 9, compMax: -9 });
    }
    if (o.stopOnPuncture && tot.punctAt) break;
  }
  ty.update = realUpdate;
  return { track: t.id, km: t.length / 1000, car: sp.id, driver, laps, lapsDone, time, rows, tot, kerbSteps,
    wear: ty.state.wear.slice(), temp: ty.state.temp.slice(),
    wearNoSlip: shadow.noSlip.state.wear.slice(), wearClean: shadow.clean.state.wear.slice(), flat: ty.state.flat.slice(), puncture: ty.state.puncture,
    aiStats: ai ? ai.stats : null };
}

module.exports = { F1, ROOT, STEP, track, line, spec, seeded, drive, hitSource };
