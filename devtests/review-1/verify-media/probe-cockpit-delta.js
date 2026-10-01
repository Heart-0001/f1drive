// Verifier probe for "cockpit-delta-never-on-slower-track": js/cockpit.js's wheel display with the REAL lap counter
// (js/laps.js), as main.js uses it: one counter per loaded track, cockpit.setSources({car, lap}) after each new counter.
//   node devtests/review-1/verify-media/probe-cockpit-delta.js
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
let texts = [];
function stubCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData' || k === 'createImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4 || 4)) });
      if (k === 'fillText' || k === 'strokeText') return function (s) { texts.push(String(s)); };
      return function () {};
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}
global.window = global;
global.document = { createElement: () => ({ width: 0, height: 0, style: {}, _c: null, getContext() { return this._c || (this._c = stubCtx()); } }) };
global.THREE = require(ROOT + '/lib/three.min.js');
global.F1 = {};
require(ROOT + '/js/laps.js');
require(ROOT + '/js/cockpit.js');
const ck = F1.createCockpit(new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000));

const DT = 1 / 60;
// drive `laps` flying laps of lapTime s round a track of n samples with the real lap counter; -> labels seen per lap
function drive(n, lapTime, laps) {
  const lap = F1.createLapCounter(n, n - 10);        // placed 10 samples behind the line, as main.js does
  ck.setSources({ car: null, lap });
  const perLap = Math.round(lapTime / DT), labels = [];
  let idx = n - 10, f = 0, seen = new Set();
  const total = Math.round((laps + 0.02) * perLap) + Math.round(10 / n * perLap);
  const speed = n / perLap;                            // samples per frame
  let pos = n - 10;
  for (; f < total; f++) {
    pos += speed; idx = Math.floor(pos) % n;
    const r = lap.update(idx, 50, DT);
    texts = [];
    ck.update({ x: 0, y: 0, z: 0, heading: 0, speed: 50, steer: 0, sampleIndex: idx, hit: 0 }, DT);
    texts.forEach(s => { if (s === 'LAP' || s === 'DELTA') seen.add(s); });
    if (r === 2) { labels.push({ lapDone: lap.n - 1, last: +lap.last.toFixed(2), shown: [...seen] }); seen = new Set(); }
  }
  labels.push({ lapInProgress: lap.n, shown: [...seen] });
  return labels;
}
const A = drive(600, 80, 3);
console.log('track A (600 samples, 80 s laps):', JSON.stringify(A));
const B = drive(700, 100, 4);
console.log('track B (700 samples, 100 s laps, slower than A):', JSON.stringify(B));
const anyDeltaB = B.some(l => l.shown.indexOf('DELTA') >= 0);
console.log(anyDeltaB ? 'NOT reproduced: DELTA shown on track B' : 'REPRODUCED: DELTA never shown on the slower track B');
const C = drive(500, 60, 3);
console.log('track C (500 samples, 60 s laps, faster than A):', JSON.stringify(C));
// control: a fresh cockpit straight onto track B shows DELTA from lap 2 on
