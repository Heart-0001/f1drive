// node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 devtests/ai-test/alloc.js [track] [cars]
// think() alone, allocation per call: the harness moves the cars along the racing line at 98 % of their profile speed
// (no car.update: js/car.js allocates on its own), the views refreshed in place. With a young generation of 256 MB no
// scavenge runs inside the measured loop, so the heap growth is what think() allocated.
'use strict';
const L = require('./lib'), F1 = L.F1;
const t = L.track(L.IDS[process.argv[2] || 'monza'] || process.argv[2]), line = L.line(t, null), P = line.points, N = t.samples.length, ds = t.length / N;
const n = +(process.argv[3] || 8);
function run(withOthers) {
  const cars = [], ais = [], views = [], pos = [];
  for (let i = 0; i < n; i++) {
    const car = F1.createCar(F1.REF_SPEC, { tyres: false });
    const ai = F1.createAIDriver({ track: t, raceLine: line, car, skill: i / Math.max(1, n - 1), seed: i + 1, id: i + 1, slot: i });
    car.reset(t, 300 + i * 9); ai.reset(); cars.push(car); ais.push(ai); pos.push(300 + i * 9);
    const w = F1.AI.createView(i + 1); w.pace = ai.pace; views.push(w);
  }
  const VA = ais.map(a => a.profile()), none = [], ctx = Object.assign(F1.AI.createContext(), { phase: 'race', laps: 10 });
  function move() {
    for (let i = 0; i < n; i++) {
      const k = pos[i] | 0, v = Math.min(VA[i][k] * 0.98, 90);
      pos[i] += v / 120 / ds; if (pos[i] >= N) pos[i] -= N;
      const k2 = pos[i] | 0, p = P[k2], q = P[(k2 + 1) % N], st = cars[i].state, w = views[i];
      st.x = p.x; st.z = p.z; st.heading = Math.atan2(q.x - p.x, q.z - p.z); st.speed = v; st.sampleIndex = k2; st.d = p.d;
      w.x = st.x; w.z = st.z; w.heading = st.heading; w.speed = v; w.sampleIndex = k2; w.d = p.d;
    }
  }
  for (let k = 0; k < 120 * 60; k++) { move(); for (let i = 0; i < n; i++) ais[i].think(1 / 120, withOthers ? views : none, ctx); }
  global.gc(); const h0 = process.memoryUsage().heapUsed;
  const steps = 120 * 300;
  for (let k = 0; k < steps; k++) { move(); for (let i = 0; i < n; i++) ais[i].think(1 / 120, withOthers ? views : none, ctx); }
  const h1 = process.memoryUsage().heapUsed;
  global.gc(); const g0 = process.memoryUsage().heapUsed;
  for (let k = 0; k < steps; k++) move();
  const g1 = process.memoryUsage().heapUsed;
  const calls = steps * n, bytes = (h1 - h0) - (g1 - g0);
  console.log((withOthers ? 'with' : 'without') + ' the other cars: ' + calls + ' think() calls (5 min of race, ' + n + ' cars): ' + bytes + ' B = ' + (bytes / calls).toFixed(3) + ' B/call; mistakes ' + ais.reduce((s, a) => s + a.stats.mistakes, 0));
  return bytes / calls;
}
if (!global.gc) { console.log('run with --expose-gc --min-semi-space-size=256 --max-semi-space-size=256'); process.exit(2); }
const order = (process.env.ORDER || "tf").split(""); for (const o of order) run(o === "t");
