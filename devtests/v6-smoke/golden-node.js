// Node side of devtests/v6-smoke/smoke.js part golden: F1.createCar(F1.REF_SPEC) on Monza, placed and stepped exactly
// as js/main.js does it in the time-warped game (frames 1/60 s apart from t = 1000 ms, the first frame dt 0, fixed
// 1/120 s physics steps from an accumulator), fed the same recorded keys. Reads {program} as JSON on stdin, prints the
// state before every frame as JSON: [[x, z, heading, speed, steer, y, pitch, roll, sampleIndex, d], ...].
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
const F1 = global.F1;
const program = JSON.parse(require('fs').readFileSync(0, 'utf8')).program;
const track = F1.buildTrack(global.F1_TRACKS.find(t => t.id === 'it-1922'));
const car = F1.createCar(F1.REF_SPEC), st = car.state, n = track.samples.length;
car.reset(track, ((n - 10) % n + n) % n);            // main.js placeAtStart (START_BACK 10)
car.setBattery(1); car.tyres.fit('M'); car.tyres.setWearRate(1);   // main.js freshStart
const STEP = 1 / 120, FRAME_MS = 1000 / 60, input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false, limiter: false };
const rec = [];
let t = 1000, lastT = 0, acc = 0, k = 0;
const frames = program[program.length - 1][0] + 1;
for (let f = 1; f <= frames; f++) {
  rec.push([st.x, st.z, st.heading, st.speed, st.steer, st.y, st.pitch, st.roll, st.sampleIndex, st.d]);
  while (k + 1 < program.length && program[k + 1][0] <= f) k++;
  const keys = program[k][1] || '';
  input.up = keys.indexOf('W') >= 0; input.down = keys.indexOf('S') >= 0; input.left = keys.indexOf('A') >= 0; input.right = keys.indexOf('D') >= 0;
  t += FRAME_MS;
  let dt = lastT ? (t - lastT) / 1000 : 0;
  lastT = t;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  while (acc >= STEP) { acc -= STEP; car.update(STEP, input, track); }
}
process.stdout.write(JSON.stringify(rec));
