// Drivers and tyre instrumentation for devtests/tyre-test (node, the REAL game modules via devtests/ai-test/lib.js).
//
//   const D = require('./drivers');
//   D.stint({ track: 'be-1925', car: '2023-red-bull', driver: 'line' | 'ap' | 'human' | 'ai', compound: 'S', wear: 1,
//             laps: 30, seed: 1, ablate: { slip, hit, grass } (true: that input is zeroed before the tyres see it),
//             perSecond: fn(row) | null, onLoad: fn(h, load, car.state) (every load the tyres get), stopAtPuncture: true,
//             stopAtWear: 1.0 (most worn tyre) })
//     -> { laps: [lap times], km, punct: {t, km, lap, wheel, cause, wear[], temp[], lastHit} | null, hits: [...],
//          kmTo / lapsTo: {0.5, 0.75, 0.9, 1}, maxTemp[4], slipS, grassS (s sliding / off the asphalt), flat[4],
//          atCliff: {flat[4], tMax, hits, slipS, grassS} when the most worn tyre reached 75 %,
//          hotAt: {km, wear} the first time a tyre ran 15 deg C over its compound's window }
//
// Drivers (all keyboard-or-pad inputs into car.update at main.js's 1/120 s):
//   line   the seasons calibration's keyboard driver (devtests/seasons-calib/driver.mjs): pure pursuit on the racing
//          line built for this car, throttle / brake keys from the line's own advice (levels[2]), battery held on
//          full throttle above 100 km/h. Clean and quick.
//   ap     the end-to-end autopilot (devtests/gp-e2e/autopilot.js): analog pedals and steering on the line at pace 1.
//   human  a keyboard human: the same pursuit, but it brakes late (red advice >= 0.78 instead of 0.6, and the throttle
//          back on at < 0.5), rides the kerbs (the path is pushed 1.1 m wider than the line at both edges, so the
//          car runs over the painted kerbs outside the white line, which the game treats as off the asphalt), turns
//          in with 25 % more steering than the pursuit asks (understeer slides), and holds the throttle on the exits.
//   sloppy the human, worse: keys decided only every 0.1 s (a held key stays held for the whole period), 50 % more
//          steering than asked, brakes at red >= 0.85: oscillates, slides, runs wide; a bad keyboard lap.
//   ai     js/ai.js (F1.createAIDriver) alone on the track, 'pro' skill unless opts.skill.
'use strict';
const path = require('path');
const L = require('../ai-test/lib');
const F1 = L.F1;
const createAutopilot = require(path.join(L.ROOT, 'devtests/gp-e2e/autopilot.js'));
const createLapCounter = require(path.join(L.ROOT, 'js/laps.js'));

const STEP = 1 / 120;
const W = ['FL', 'FR', 'RL', 'RR'];

function specOf(id) {
  if (!id || id === 'ref') return F1.REF_SPEC;
  const s = F1.cars.get(id) || F1.cars.resolve(id);
  if (!s) throw new Error('unknown car ' + id);
  return s;
}

// The car's line (built for its own limits) - cached per track + spec.
const lineCache = new Map();
function lineFor(t, car) {
  const key = t.id + '|' + car.spec.id;
  if (!lineCache.has(key)) lineCache.set(key, F1.buildRaceLine(t, car.perf));
  return lineCache.get(key);
}

function keyboardDriver(kind) {
  const sloppy = kind === 'sloppy', human = kind === 'human' || sloppy;
  const BRAKE_ON = sloppy ? 0.85 : human ? 0.78 : 0.6, THR_ON = human ? 0.5 : 0.45, GAIN = sloppy ? 1.5 : human ? 1.25 : 1;
  const WIDE = human ? 1.1 : 0, PERIOD = sloppy ? 12 : 1, DEAD = sloppy ? 0.0 : 0.03;   // sloppy: keys decided at 10 Hz
  let n = 0;
  return {
    step(env, input) {
      const { st, track, line, car } = env, S = track.samples, N = S.length, ds = track.length / N, P = line.points;
      if (n++ % PERIOD) return;
      line.update(st);
      const v = Math.max(0, st.speed), lv = line.levels[2];
      input.up = lv < THR_ON || v < 5; input.down = lv >= BRAKE_ON && v >= 5;
      if (human && input.up && input.down) input.up = false;
      input.boost = input.up && !input.down && v > 100 / 3.6;
      const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
      const k = (st.sampleIndex + Math.round(Ld / ds)) % N, tp = P[k];
      let tx = tp.x, tz = tp.z;
      if (WIDE > 0) {
        // the path pushed out towards the edge the line is near: over the kerbs at the apexes and exits
        const s = S[k], hw = s.halfW || track.halfWidth, d = tp.d || 0;
        if (Math.abs(d) > hw - 2.5) {
          const sg = d > 0 ? 1 : -1, nd = sg * Math.min(Math.abs(d) + WIDE, hw + 1.0);
          tx = s.x + s.nx * nd; tz = s.z + s.nz * nd;
        }
      }
      const dx = tx - st.x, dz = tz - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
      const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
      const lock = car.perf.steerLockAt(v, S[st.sampleIndex].bank || 0, kap >= 0 ? 1 : -1);
      const want = Math.max(-1, Math.min(1, GAIN * Math.atan(kap * 3.6) / lock));
      input.left = want > st.steer + DEAD; input.right = want < st.steer - DEAD;
    }
  };
}

function apDriver() {
  const ap = createAutopilot(); ap.cfg.mode = 'line'; ap.cfg.scale = 1;
  return {
    step(env, input) {
      const o = ap.step({ t: env.t, st: env.st, track: env.track, line: env.line, locked: false, others: [] });
      input.throttle = o.throttle > 0 ? o.throttle : null;
      input.brake = o.brake > 0 ? o.brake : null;
      input.steerAxis = o.steer !== 0 ? o.steer : null;
      input.up = input.down = input.left = input.right = false;
      input.boost = o.throttle > 0.95 && !(o.brake > 0) && env.st.speed > 100 / 3.6;
      if (o.reset) env.resetCar();
    }
  };
}

function aiDriver(env0, opts) {
  const ai = F1.createAIDriver({ track: env0.track, raceLine: env0.line, car: env0.car, skill: opts.skill || 'pro',
    seed: opts.seed || 1, id: 1, slot: 0, name: 'tyre-test' });
  const ctx = F1.AI.createContext();
  ctx.phase = 'race'; ctx.locked = false; ctx.laps = 0; ctx.wear = opts.wear || 1; ctx.pit = null;
  const view = F1.AI.createView(1), others = [view];
  ai.reset();
  return {
    ai,
    step(env, input) {
      F1.AI.updateView(view, env.car.state, env.track);
      ctx.lap = env.lapsDone; ctx.prog = env.lapsDone;
      const o = ai.think(STEP, others, ctx);
      for (const k of ['up', 'down', 'left', 'right', 'throttle', 'brake', 'steerAxis', 'boost', 'limiter']) input[k] = o[k];
      if (o.reset) { F1.AI.resetCar(env.car, env.track, undefined, others, 1); env.lap.sync && env.lap.sync(env.car.state.sampleIndex); }
    }
  };
}

function seeded(s) { s = s >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// One stint: a new set, the car standing on the centreline at sample 0 (the start line; the first lap includes the
// launch), driven until the puncture (stopAtPuncture, default), the most worn tyre reaching stopAtWear (< 1), or
// `laps` laps of distance.
function stint(o) {
  const t = L.track(L.IDS[o.track] || o.track);
  const spec = specOf(o.car);
  const car = F1.createCar(spec, { random: seeded(o.seed || 1) });
  const line = lineFor(t, car);
  const st = car.state, S = t.samples, N = S.length;
  car.reset(t, 0);
  car.setBattery(1);
  const ty = car.tyres;
  ty.fit(o.compound || 'M');
  ty.setWearRate(o.wear === undefined ? 1 : o.wear);
  const lap = createLapCounter(N, st.sampleIndex);
  const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false, limiter: false };
  const env = { t: 0, st, track: t, line, car, lap, lapsDone: 0, resetCar() { F1.AI.resetCar(car, t, undefined, [], 1); } };
  const drv = o.driver === 'ap' ? apDriver() : o.driver === 'ai' ? aiDriver(env, o) : keyboardDriver(o.driver || 'line');

  // ---- instrumentation: every load the tyres see (car.js calls tyres.update(h, load) per sub-step)
  const ab = o.ablate || {};
  const acc = { slipS: 0, grassS: 0 };
  const hits = [];
  let lastHitT = -1, cur = { hit: 0 };
  const origUpdate = ty.update;
  ty.update = function (h, load) {
    if (ab.slip) load.slip = 0;
    if (ab.grass) load.onGrass = false;
    if (ab.hit) load.hit = 0;
    if (load.slip > 0) acc.slipS += h;
    if (load.onGrass) acc.grassS += h;
    if (load.hit > 0) {
      const s = S[st.sampleIndex], hw = s.halfW || t.halfWidth;
      const wd = st.d > 0 ? (s.wallPosDist === undefined ? t.wallDist : s.wallPosDist) : (s.wallNegDist === undefined ? t.wallDist : s.wallNegDist);
      const src = st.inPit || (t.pit && t.pit.paved(st.sampleIndex, st.d)) ? 'pit wall' : (Math.abs(st.d) >= wd - 1.0 - 0.05 ? 'outer wall' : 'other');
      if (env.t - lastHitT > 0.3) hits.push({ t: +env.t.toFixed(2), lap: env.lapsDone, idx: st.sampleIndex, frac: +(st.sampleIndex / N).toFixed(3),
        d: +st.d.toFixed(2), halfW: +hw.toFixed(2), wall: +wd.toFixed(2), kmh: Math.round(Math.abs(load.speed) * 3.6), hit: +load.hit.toFixed(3), src });
      else if (hits.length && load.hit > hits[hits.length - 1].hit) hits[hits.length - 1].hit = +load.hit.toFixed(3);
      lastHitT = env.t;
    }
    if (o.onLoad) o.onLoad(h, load, st);
    origUpdate(h, load);
  };

  const maxLaps = o.laps || 40, stopWear = o.stopAtWear || 1.0, stopP = o.stopAtPuncture !== false;
  const kmTo = {}, lapsTo = {}, maxTemp = [0, 0, 0, 0];
  let punct = null, dist = 0, secAcc = 0, lastWear = [0, 0, 0, 0], atCliff = null, hotAt = null;
  const laps = [];
  let lapT0 = 0;
  const secRow = { slip: 0, grass: 0, hit: 0 };
  while (dist < maxLaps * t.length && env.t < maxLaps * 400) {
    drv.step(env, input);
    const x0 = st.x, z0 = st.z;
    car.update(STEP, input, t);
    env.t += STEP;
    const dd = Math.hypot(st.x - x0, st.z - z0);
    if (dd < 5) dist += dd;
    if (st.slip > secRow.slip) secRow.slip = st.slip;
    if (st.onGrass) secRow.grass += STEP;
    if (st.hit > secRow.hit) secRow.hit = st.hit;
    const c = lap.update(st.sampleIndex, st.speed, STEP);
    if (c === 1 || c === 2) { env.lapsDone++; laps.push(env.t - lapT0); lapT0 = env.t; }
    const w = ty.state.wear, mw = Math.max(w[0], w[1], w[2], w[3]);
    for (let i = 0; i < 4; i++) if (ty.state.temp[i] > maxTemp[i]) maxTemp[i] = ty.state.temp[i];
    for (const th of [0.5, 0.75, 0.9, 1]) if (kmTo[th] === undefined && mw >= th) {
      kmTo[th] = dist / 1000; lapsTo[th] = dist / t.length;
      if (th === 0.75) atCliff = { flat: ty.state.flat.map(x => +x.toFixed(3)), tMax: Math.max(...maxTemp), hits: hits.length, slipS: acc.slipS, grassS: acc.grassS };
    }
    if (!hotAt && Math.max(...ty.state.temp) > F1.Tyres.COMPOUNDS[ty.state.compound].hot + 15) hotAt = { km: +(dist / 1000).toFixed(1), wear: +mw.toFixed(3) };
    if (punct === null && ty.state.puncture >= 0) {
      const p = ty.state.puncture;
      const cause = env.t - lastHitT < 0.02 ? 'impact' : (w[p] >= 1 ? 'worn through' : '?');   // (an impact punctures in its own step)
      punct = { t: +env.t.toFixed(1), km: +(dist / 1000).toFixed(2), lap: +(dist / t.length).toFixed(2), wheel: W[p], cause,
        wear: w.map(x => +x.toFixed(3)), temp: ty.state.temp.map(x => +x.toFixed(0)), frac: +(st.sampleIndex / N).toFixed(3),
        lastHit: hits.length ? hits[hits.length - 1] : null };
      if (stopP) break;
    }
    if (stopWear < 1 && mw >= stopWear) break;
    secAcc += STEP;
    if (secAcc >= 1 - 1e-9) {
      secAcc -= 1;
      if (o.perSecond) {
        o.perSecond({ t: Math.round(env.t), km: dist / 1000, lap: dist / t.length, kmh: Math.round(st.speed * 3.6), wear: w.slice(),
          dw: w.map((x, i) => x - lastWear[i]), temp: ty.state.temp.slice(), flat: ty.state.flat.slice(), dirt: ty.state.dirt,
          grip: Object.assign({}, ty.state.grip), slip: secRow.slip, grass: secRow.grass, hit: secRow.hit, load: st.load, compress: st.compress,
          punct: ty.state.puncture, frac: st.sampleIndex / N });
      }
      lastWear = w.slice();
      secRow.slip = 0; secRow.grass = 0; secRow.hit = 0;
    }
  }
  ty.update = origUpdate;
  return { track: t.id, car: spec.id, driver: o.driver || 'line', compound: ty.state.compound, wear: o.wear === undefined ? 1 : o.wear,
    laps, km: dist / 1000, lapKm: t.length / 1000, t: env.t, punct, hits, kmTo, lapsTo, maxTemp, slipS: acc.slipS, grassS: acc.grassS,
    finalWear: ty.state.wear.slice(), flat: ty.state.flat.slice(), atCliff, hotAt, ai: drv.ai ? drv.ai.stats : null };
}

module.exports = { L, F1, STEP, W, stint, specOf, seeded };
