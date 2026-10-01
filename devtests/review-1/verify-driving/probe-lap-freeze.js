// Finding laps-time-frozen-during-service: the documented loop (js/pit.js header: "while the car is frozen for a
// service (no physics steps) pit.update once a frame"; js/laps.js: "call update once per physics step") vs the fix
// (lap.update(idx, 0, dt) once a frame while frozen). node devtests/review-1/verify-driving/probe-lap-freeze.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
require(path.join(ROOT, 'js/laps.js'));
const F1 = global.F1;
const N = 2500, STEP = 1 / 120, SERVICE = 4.0, PENALTY = 5.0;
function lapWith(freezeCallsLap) {
  const lap = F1.createLapCounter(N, N - 10);
  let idx = N - 10, wall = 0, t0 = null, res;
  // drive 1 sample per step (240 m/s-ish, irrelevant) over the line, half a lap, stop for the service, then on
  for (let k = 0; ; k++) {
    if (k === N / 2 + 10) {                                   // frozen for the service: no physics steps
      for (let f = 0; f < (SERVICE + PENALTY) * 60; f++) { wall += 1 / 60; if (freezeCallsLap) lap.update(idx, 0, 1 / 60); }
    }
    idx = (idx + 1) % N; wall += STEP;
    res = lap.update(idx, 50, STEP);
    if (res === 1) t0 = wall;
    if (res === 2) return { lap: lap.last, wall: wall - t0 };
  }
}
const a = lapWith(false), b = lapWith(true);
console.log('documented loop (lap.update only in physics steps): lap.last', a.lap.toFixed(3), 's, wall clock', a.wall.toFixed(3), 's, missing', (a.wall - a.lap).toFixed(3), 's');
console.log('lap.update(idx, 0, dt) while frozen             : lap.last', b.lap.toFixed(3), 's, wall clock', b.wall.toFixed(3), 's, missing', (b.wall - b.lap).toFixed(3), 's');
