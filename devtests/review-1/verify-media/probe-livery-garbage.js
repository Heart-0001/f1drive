// Verifier probe for "carmodel-setlivery-per-frame-garbage": how much garbage / time does the per-frame
// model.setColour(p.colour) + model.setName(p.name) of js/main.js updateRemotes() really cost with 15 remote cars?
// Also setLivery(c1, c2, acc) (what the v6 glue is told to call instead).
//   node --expose-gc devtests/review-1/verify-media/probe-livery-garbage.js
const path = require('path');
const { PerformanceObserver, performance } = require('perf_hooks');
const ROOT = path.resolve(__dirname, '..', '..', '..');
function stubCtx() { return new Proxy({}, { get(t, k) { if (k in t) return t[k]; if (k === 'measureText') return () => ({ width: 10 }); return function () {}; }, set(t, k, v) { t[k] = v; return true; } }); }
global.window = global;
global.document = { createElement: () => ({ width: 0, height: 0, _c: null, getContext() { return this._c || (this._c = stubCtx()); } }) };
global.THREE = require(ROOT + '/lib/three.min.js');
global.F1 = {};
require(ROOT + '/js/carmodel.js');

const CARS = 15, FRAMES = 36000;                      // 15 remote cars, 10 minutes at 60 fps
const models = [], cols = [], cols2 = [], names = [];
for (let i = 0; i < CARS; i++) {
  cols.push('#' + ((i * 0x123457) & 0xffffff).toString(16).padStart(6, '0'));
  cols2.push('#' + ((i * 0x654321 + 0x111111) & 0xffffff).toString(16).padStart(6, '0'));
  names.push('Player ' + i);
  models.push(F1.createCarModel(cols[i], names[i]));
}

let gcs = [];
const obs = new PerformanceObserver(list => { for (const e of list.getEntries()) gcs.push(e); });
obs.observe({ entryTypes: ['gc'] });

async function measure(label, perFrame) {
  if (global.gc) global.gc();
  await new Promise(r => setTimeout(r, 50));
  gcs = [];
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) perFrame();
  const ms = performance.now() - t0;
  await new Promise(r => setTimeout(r, 50));     // let the observer deliver
  const minor = gcs.filter(e => (e.detail ? e.detail.kind : e.kind) === 1);
  const maxGc = gcs.reduce((m, e) => Math.max(m, e.duration), 0);
  console.log(label.padEnd(44), 'per frame', (ms / FRAMES * 1000).toFixed(2), 'us |', 'GCs in 10 min:', gcs.length,
    '(scavenges', minor.length + ')', '| longest GC', maxGc.toFixed(2), 'ms | total GC', gcs.reduce((s, e) => s + e.duration, 0).toFixed(1), 'ms');
}

(async () => {
  await measure('baseline (empty loop)', () => {});
  await measure('setColour + setName x15 (current glue)', () => { for (let i = 0; i < CARS; i++) { models[i].setColour(cols[i]); models[i].setName(names[i]); } });
  await measure('setLivery(c1,c2,acc) + setName x15 (v6)', () => { for (let i = 0; i < CARS; i++) { models[i].setLivery(cols[i], cols2[i], cols[i]); models[i].setName(names[i]); } });
  // the reviewer's suggested early-out on the raw inputs, for comparison
  const last = new Array(CARS).fill('');
  await measure('raw-input early-out + setName x15', () => { for (let i = 0; i < CARS; i++) { const k = cols[i] + '|' + cols2[i] + '|' + cols[i]; if (k !== last[i]) { last[i] = k; models[i].setLivery(cols[i], cols2[i], cols[i]); } models[i].setName(names[i]); } });
  obs.disconnect();
})();
