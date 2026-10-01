// D5 verification: a qualifying run (the car START_BACK = 10 samples before the line, as placeStart alone) on a fresh
// set at the Grand Prix wear option x5 (main.js wearRate() applies it in qualifying too). Keyboard line driver and
// analog autopilot, mediums and softs, several carcass draws (random 0.0 / 0.5 / 0.99 -> life 1.03 .. 1.12).
// Laps until the puncture (lap 1 = the first timed lap), wear and grip at each line crossing.
'use strict';
const { F1, STEP, KMH, track, lineWant, keysSteer, createAutopilot } = require('../driving/load');
function keyDriver(tr, line, car) {
  const inp = { up: false, down: false, left: false, right: false };
  return () => { const w = lineWant(tr, line, car.state), v = car.state.speed; inp.up = w.level < 0.45 || v < 5; inp.down = w.level >= 0.6 && v >= 5; keysSteer(inp, car.state, w.steer); return inp; };
}
function padDriver(tr, line, car) {
  const ap = createAutopilot(); ap.cfg.mode = 'line'; ap.cfg.scale = 1;
  const inp = { throttle: null, brake: null, steerAxis: null }; let n = 0, t = 0;
  return () => { if (n++ % 2 === 0) { const o = ap.step({ t, st: car.state, track: tr, line, locked: false, others: [] }); inp.throttle = o.throttle > 0 ? o.throttle : null; inp.brake = o.brake > 0 ? o.brake : null; inp.steerAxis = o.steer !== 0 ? o.steer : null; if (o.reset) car.reset(tr, car.state.sampleIndex); } t += STEP; return inp; };
}
function qrun(tr, line, mk, compound, rate, rnd, laps) {
  const car = F1.createCar(null, { random: () => rnd }), st = car.state, ty = car.tyres;
  ty.fit(compound); ty.setWearRate(rate);
  const N = tr.samples.length; car.reset(tr, N - 10);
  const lap = F1.createLapCounter(N, st.sampleIndex), drive = mk(tr, line, car);
  const out = { times: [], punct: null, punctFrac: null };
  let t = 0;
  while (out.times.length < laps && t < 1200) {
    car.update(STEP, drive(), tr); t += STEP;
    const r = lap.update(st.sampleIndex, st.speed, STEP);
    if (r === 2) out.times.push(lap.last.toFixed(1) + ' (w' + Math.round(100 * Math.max(...ty.state.wear)) + ' g' + ty.state.grip.lat.toFixed(2) + ')');
    if (ty.state.puncture >= 0 && out.punct === null) { out.punct = out.times.length + 1; out.punctFrac = lap.progress ? lap.progress(st.sampleIndex) : null; }
  }
  return out;
}
const rows = [];
for (const id of ['it-1922', 'gb-1948', 'mc-1929', 'jp-1962', 'hu-1986']) {
  const { track: tr, line } = track(id);
  for (const [dn, mk] of [['keys', keyDriver], ['pad', padDriver]]) {
    for (const c of ['M', 'S']) {
      for (const rnd of [0, 0.5, 0.99]) {
        const r = qrun(tr, line, mk, c, 5, rnd, 4);
        rows.push({ track: id, driver: dn, set: c, rnd, punctureInLap: r.punct === null ? 'none in 4' : r.punct, laps: r.times.join(' | ') });
      }
    }
  }
}
console.table(rows);
