// node devtests/ai-test/calibrate.js [tracks=...] [car=<spec id>]
// Solves the pace factor p of every level (js/ai.js PACE) so that the MEDIAN over the circuits of
//   best flying lap of a computer car alone at that level / best flying lap of the reference driver (opts.reference)
// is 1 + lapPct / 100 (F1.AI.LEVELS). Prints the table to paste into js/ai.js. Bisection on p, F1.AI.PACE patched live.
'use strict';
const L = require('./lib'), F1 = L.F1;
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const tracks = arg('tracks', 'monza,monaco,spa,suzuka,bahrain,zandvoort,singapore,silverstone,hungaroring,interlagos').split(',');
const spec = arg('car', '') ? F1.cars.get(arg('car', '')) : F1.REF_SPEC;
const STEP = 1 / 120;
function lap(t, opts) {
  const car = F1.createCar(spec, { tyres: false }), line = L.line(t, null);
  const ai = F1.createAIDriver(Object.assign({ track: t, raceLine: line, car, seed: 77, id: 1 }, opts));
  car.reset(t, 0); car.setBattery(1); ai.reset();
  const S = t.samples, N = S.length, st = car.state, laps = [], ctx = F1.AI.createContext();
  let time = 0, lapStart = 0, prev = 0;
  while (laps.length < 4 && time < 600) {
    const inp = ai.think(STEP, null, ctx);
    if (inp.reset) F1.AI.resetCar(car, t);
    car.update(STEP, inp, t); time += STEP;
    if (prev > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - lapStart); lapStart = tc;
    }
    prev = st.sampleIndex;
  }
  const fly = laps.slice(1);
  return fly.reduce((a, b) => a + b, 0) / fly.length;     // mean of the flying laps (noise included)
}
const T = tracks.map(n => L.track(L.IDS[n] || n));
const ref = T.map(t => lap(t, { reference: true }));
console.log('reference laps: ' + T.map((t, i) => t.id + ' ' + L.fmt(ref[i])).join(', '));
const PACE = F1.AI.PACE;
function median(a) { a = a.slice().sort((x, y) => x - y); return a.length % 2 ? a[a.length >> 1] : 0.5 * (a[a.length / 2 - 1] + a[a.length / 2]); }
for (let li = 0; li < F1.AI.LEVELS.length; li++) {
  const lv = F1.AI.LEVELS[li], want = 1 + lv.lapPct / 100;
  let lo = 0.6, hi = 1.05, ratio = 0;
  for (let it = 0; it < 9; it++) {
    const mid = 0.5 * (lo + hi);
    PACE[li][1] = mid;
    const r = T.map((t, i) => lap(t, { skill: lv.skill }) / ref[i]);
    ratio = median(r);
    if (ratio > want) lo = mid; else hi = mid;
  }
  PACE[li][1] = Math.round(0.5 * (lo + hi) * 1000) / 1000;
  const r = T.map((t, i) => lap(t, { skill: lv.skill }) / ref[i]);
  console.log(lv.id.padEnd(8) + ' p ' + PACE[li][1].toFixed(3) + '  median ' + ((median(r) - 1) * 100).toFixed(2) + ' % (want ' + lv.lapPct + ')  per track: ' +
    r.map((x, i) => T[i].id.slice(0, 2) + ' ' + ((x - 1) * 100).toFixed(1)).join(' '));
}
console.log('PACE = ' + JSON.stringify(PACE));
