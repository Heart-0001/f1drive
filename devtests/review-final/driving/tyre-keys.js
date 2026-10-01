// Tyre model under the two kinds of driver: the keyboard line driver (100 % pedals, bang-bang steering) and the analog
// autopilot, 6 laps each at wear rate 1 on mediums; wear / flat spots / peak temperature / grip at the end; lap times.
// Then: wear x5 on softs with the autopilot - laps until the puncture.
'use strict';
const { F1, STEP, KMH, track, lineWant, keysSteer, createAutopilot } = require('./load');
const ids = (process.argv[2] || 'it-1922,gb-1948,mc-1929,jp-1962').split(',');
function keyDriver(tr, line, car) {
  const inp = { up: false, down: false, left: false, right: false };
  return () => { const w = lineWant(tr, line, car.state), v = car.state.speed; inp.up = w.level < 0.45 || v < 5; inp.down = w.level >= 0.6 && v >= 5; keysSteer(inp, car.state, w.steer); return inp; };
}
function padDriver(tr, line, car) {
  const ap = createAutopilot(); ap.cfg.mode = 'line'; ap.cfg.scale = 1;
  const inp = { throttle: null, brake: null, steerAxis: null }; let n = 0, t = 0;
  return () => { if (n++ % 2 === 0) { const o = ap.step({ t, st: car.state, track: tr, line, locked: false, others: [] }); inp.throttle = o.throttle > 0 ? o.throttle : null; inp.brake = o.brake > 0 ? o.brake : null; inp.steerAxis = o.steer !== 0 ? o.steer : null; if (o.reset) car.reset(tr, car.state.sampleIndex); } t += STEP; return inp; };
}
function stint(tr, line, mk, laps, compound, rate) {
  const car = F1.createCar(null, { random: () => 0.5 }), st = car.state, ty = car.tyres;
  ty.fit(compound); ty.setWearRate(rate);
  const N = tr.samples.length; car.reset(tr, N - 10);
  const lap = F1.createLapCounter(N, st.sampleIndex), drive = mk(tr, line, car);
  const out = { laps: [], maxT: 0, slipSteps: 0, steps: 0, punctureLap: null, minGrip: 1 };
  let t = 0;
  while (out.laps.length < laps && t < 900) {
    car.update(STEP, drive(), tr); t += STEP; out.steps++;
    if (st.slip > 0) out.slipSteps++;
    out.maxT = Math.max(out.maxT, ...ty.state.temp);
    out.minGrip = Math.min(out.minGrip, ty.state.grip.lat);
    const r = lap.update(st.sampleIndex, st.speed, STEP);
    if (r === 2) out.laps.push({ t: +lap.last.toFixed(2), wear: ty.state.wear.map(w => (w * 100).toFixed(0)).join('/'), flat: ty.state.flat.map(w => (w * 100).toFixed(0)).join('/'), grip: ty.state.grip.lat.toFixed(3) + '/' + ty.state.grip.brake.toFixed(3) + '/' + ty.state.grip.traction.toFixed(3), T: Math.max(...ty.state.temp).toFixed(0) });
    if (ty.state.puncture >= 0 && out.punctureLap === null) out.punctureLap = out.laps.length + 1;
    if (ty.state.puncture >= 0) break;
  }
  return out;
}
for (const id of ids) {
  const { track: tr, line } = track(id);
  for (const [name, mk] of [['keys', keyDriver], ['pad', padDriver]]) {
    const r = stint(tr, line, mk, 6, 'M', 1);
    console.log(id + ' ' + name + ': slip steps ' + (100 * r.slipSteps / r.steps).toFixed(1) + '% of steps, peak temp ' + r.maxT.toFixed(0) + ' C, min lat grip ' + r.minGrip.toFixed(3));
    console.table(r.laps);
  }
}
// wear x5 on softs, autopilot: laps to the puncture
for (const id of ids.slice(0, 2)) {
  const { track: tr, line } = track(id);
  const r = stint(tr, line, padDriver, 12, 'S', 5);
  console.log(id + ' softs x5 (pad): puncture in lap ' + r.punctureLap + '; laps: ' + r.laps.map(l => l.t + 's wear ' + l.wear + ' grip ' + l.grip).join(' | '));
}
