// Review probe: the steering-wheel display's lap DELTA after a track change (js/cockpit.js updateDisplay).
// Suspicion: lapBest is never reset by setSources(), so on a slower track the reference lap is never recorded.
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
let draws = [];
function stubCtx() {
  const grad = { addColorStop() {} };
  const t = {};
  return new Proxy(t, { get(t, k) {
    if (k in t) return t[k];
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'fillText') return function (s, x, y) { draws.push(String(s)); };
    return function () {};
  }, set(t, k, v) { t[k] = v; return true; } });
}
global.window = global;
global.document = { createElement: () => ({ width: 0, height: 0, _ctx: null, getContext() { return this._ctx || (this._ctx = stubCtx()); } }) };
global.THREE = require(ROOT + '/lib/three.min.js');
global.F1 = {};
require(ROOT + '/js/cockpit.js');
const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000);
const ck = F1.createCockpit(cam);

// a fake lap counter as js/laps.js exposes it: started, n, time, last, best, void
function fakeLap() { return { started: true, n: 0, time: 0, last: null, best: null, void: false }; }
// drive N laps of `lapTime` seconds on a track of `samples` samples; returns the labels the display showed on the last lap
function driveLaps(lap, laps, lapTime, samples) {
  const labels = new Set();
  const dt = 1 / 60, perLap = Math.round(lapTime / dt);
  for (let n = 0; n < laps; n++) {
    lap.time = 0;
    for (let i = 0; i < perLap; i++) {
      lap.time += dt;
      const idx = Math.floor(i / perLap * samples);
      draws = [];
      ck.update({ x: 0, z: 0, heading: 0, speed: 50, steer: 0, sampleIndex: idx, hit: 0 }, dt);
      if (n === laps - 1) draws.forEach(s => { if (s === 'LAP' || s === 'DELTA') labels.add(s); });
    }
    lap.last = lapTime; lap.best = lap.best === null ? lapTime : Math.min(lap.best, lapTime); lap.n++;
  }
  return [...labels];
}

let lapA = fakeLap();
ck.setSources({ car: null, lap: lapA });
console.log('track A (80 s laps), 3 laps: display labels on lap 3 =', driveLaps(lapA, 3, 80, 400));

// new track, new lap counter (as main.js would create one) -> setSources again
let lapB = fakeLap();
ck.setSources({ car: null, lap: lapB });
const labelsB = driveLaps(lapB, 3, 100, 500);
console.log('track B (100 s laps, slower than A), 3 laps: display labels on lap 3 =', labelsB);
console.log(labelsB.indexOf('DELTA') < 0 ? 'CONFIRMED: no DELTA on the slower track (lapBest from track A still gates the reference lap)' : 'not reproduced');

// and a faster track after that works
let lapC = fakeLap();
ck.setSources({ car: null, lap: lapC });
console.log('track C (60 s laps, faster than A), 3 laps: display labels on lap 3 =', driveLaps(lapC, 3, 60, 300));
