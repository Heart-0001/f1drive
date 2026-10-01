// Golden rule, my own way: every track (not just the test's 6), a random bang-bang driver (keys held for random
// durations, analog pedals / stick now and then, R resets, odd frame times), the v5 car vs F1.createCar() at wear rate 0
// and vs the DEFAULT car (wear rate 1) - the latter compared only while its grip is exactly 1. Divergence inside the pit
// complex is expected (asphalt, pit wall): both cars are then reset together to a new random spot.
'use strict';
const { F1, V5, STEP, track, inPitArea } = require('./load');
const KEYS = ['x', 'y', 'z', 'heading', 'speed', 'steer', 'pitch', 'roll', 'sampleIndex', 'd', 'onGrass', 'hit'];
let seed = 7;
function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
const T = +(process.argv[2] || 40);
let total = 0, bad = 0, pitResets = 0, gripLeft = 0, firstBad = null;
const notOne = {};
for (const td of global.F1_TRACKS) {
  const { track: tr } = track(td.id), N = tr.samples.length;
  const a = V5.createCar(), b = F1.createCar(); b.tyres.setWearRate(0);
  const c = F1.createCar(F1.REF_SPEC);                      // the game's default: wear rate 1, ERS harvesting
  const cars = [a, b, c];
  let idx = Math.floor(rnd() * N);
  cars.forEach(x => x.reset(tr, idx));
  const inp = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null };
  let t = 0, hold = 0, cOk = true;
  while (t < T) {
    if (hold <= 0) {
      hold = 0.05 + rnd() * 1.5;
      inp.up = rnd() < 0.6; inp.down = rnd() < 0.25; inp.left = rnd() < 0.3; inp.right = rnd() < 0.3;
      inp.throttle = rnd() < 0.3 ? rnd() : null; inp.brake = rnd() < 0.2 ? rnd() : null; inp.steerAxis = rnd() < 0.3 ? rnd() * 2 - 1 : null;
      if (rnd() < 0.03) { idx = Math.floor(rnd() * N); cars.forEach(x => x.reset(tr, idx)); cOk = true; }
    }
    const dt = rnd() < 0.02 ? 0.031 : (rnd() < 0.003 ? 0.2 : STEP);
    hold -= dt; t += Math.min(dt, 0.1);
    const i2 = Object.assign({}, inp);
    cars.forEach(x => x.update(dt, i2, tr));
    if (inPitArea(tr, a.state) || inPitArea(tr, b.state) || inPitArea(tr, c.state)) {
      pitResets++; idx = Math.floor(rnd() * N); cars.forEach(x => x.reset(tr, idx)); cOk = true; continue;
    }
    const g = c.tyres.state.grip;
    const one = g.lat === 1 && g.brake === 1 && g.traction === 1;
    if (!one && cOk) { cOk = false; gripLeft++; const ts = c.tyres.state; notOne[td.id] = (notOne[td.id] || 0) + 1;
      if (gripLeft <= 3) console.log('  grip left 1 on ' + td.id + ' at t=' + t.toFixed(1) + ': ' + JSON.stringify(g) + ' temp ' + ts.temp.map(v => v.toFixed(0)) + ' dirt ' + ts.dirt.toFixed(2) + ' flat ' + ts.flat.map(v => v.toFixed(2)) + ' hit ' + c.state.hit.toFixed(2) + ' grass ' + c.state.onGrass); }
    for (const k of KEYS) {
      total++;
      if (!Object.is(a.state[k], b.state[k])) { bad++; if (!firstBad) firstBad = td.id + ' t=' + t.toFixed(2) + ' ' + k + ' v5 ' + a.state[k] + ' v6 ' + b.state[k]; }
      if (cOk && !Object.is(a.state[k], c.state[k])) { bad++; if (!firstBad) firstBad = td.id + ' t=' + t.toFixed(2) + ' ' + k + ' v5 ' + a.state[k] + ' default ' + c.state[k]; }
    }
  }
}
console.log('values compared ' + total + ', mismatches ' + bad + (firstBad ? ' first: ' + firstBad : '') + ', pit-area resets ' + pitResets + ', default car grip left 1 in ' + gripLeft + ' runs');
console.log('tracks where the default car\'s grip left 1: ' + JSON.stringify(notOne));
