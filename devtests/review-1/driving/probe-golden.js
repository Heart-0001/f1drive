// Independent golden-rule check: v5 car (devtests/car-v6/car-v5.js) vs v6 car with fresh mediums at wear rate 1,
// same random inputs on real tracks, bitwise identical state?
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
const F1 = global.F1;
require(path.join(ROOT, 'devtests/car-v6/car-v5.js'));
const createV5 = F1.createCar;
delete F1.createCar;
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
const createV6 = F1.createCar;
let seed = 5; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
let diffs = 0, steps = 0;
for (const id of ['it-1922', 'mc-1929', 'jp-1962', 'be-1925', 'az-2016']) {
  const td = global.F1_TRACKS.find(t => t.id === id), track = F1.buildTrack(td);
  const a = createV5(), b = createV6();
  a.reset(track, 0); b.reset(track, 0);
  const inp = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null };
  let hold = 0, t = 0, first = null;
  while (t < 90) {
    if (hold <= 0) { hold = 0.1 + rnd() * 1.5; const m = rnd(); inp.up = m < 0.6; inp.down = m > 0.85; inp.throttle = rnd() < 0.3 ? rnd() : null; inp.brake = rnd() < 0.15 ? rnd() : null;
      if (rnd() < 0.5) { inp.steerAxis = rnd() * 2 - 1; inp.left = inp.right = false; } else { inp.steerAxis = null; const q = rnd(); inp.left = q < 0.3; inp.right = q > 0.7; } }
    const dt = rnd() < 0.05 ? [1 / 60, 1 / 30, 0.1][Math.floor(rnd() * 3)] : 1 / 120;
    a.update(dt, inp, track); b.update(dt, inp, track); t += dt; hold -= dt; steps++;
    for (const k of ['x', 'y', 'z', 'heading', 'speed', 'steer', 'pitch', 'roll', 'sampleIndex', 'd', 'onGrass', 'hit']) {
      if (a.state[k] !== b.state[k]) { diffs++; if (!first) first = { id, t: t.toFixed(2), k, v5: a.state[k], v6: b.state[k], wear: b.tyres.state.wear.map(w => w.toFixed(3)), grip: b.tyres.state.grip }; }
    }
  }
  console.log(id, 'v6 tyre wear after 90 s', b.tyres.state.wear.map(w => w.toFixed(3)).join(' '), 'grip', JSON.stringify(b.tyres.state.grip), 'battery', b.state.battery.toFixed(3), first ? 'FIRST DIFF ' + JSON.stringify(first) : 'identical');
  track.dispose();
}
console.log('steps', steps, 'field diffs', diffs);
