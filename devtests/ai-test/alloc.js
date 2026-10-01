// node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 devtests/ai-test/alloc.js [track] [cars]
//      [races=N] [minutes=M] [warm=S] [sample=K]
// think()'s allocation per call. Optionally N real races first (sim.js: 15 cars, qualifying + 5 laps, wear x3, the
// real car / tyres / pit / laps / session: V8 sees every branch of a race), then the measured drivers: `cars` computer
// cars with REAL tyres (softs worn to ~45 %), real contexts (phase 'race', race distance, pit state, wear) moved along
// the racing line at 98 % of their profile speed (no car.update: js/car.js allocates on its own), the views refreshed
// in place; `warm` s of warm-up, then M one-minute windows. With a young generation of 256 MB no scavenge runs inside
// a window, so the heap growth is what think() allocated (the moves alone are measured and subtracted).
// sample=K: V8's sampling heap profiler from minute K on: where the bytes come from, by function (the profiler itself
// disturbs V8 when it starts: that minute reads high).
'use strict';
const L = require('./lib'), F1 = L.F1;
const pos = process.argv.slice(2).filter(a => !a.includes('='));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const trackName = pos[0] || 'monza', n = +(pos[1] || 8);
const races = +arg('races', 0), minutes = +arg('minutes', 2), warm = +arg('warm', 60);
if (!global.gc) { console.log('run with --expose-gc --min-semi-space-size=256 --max-semi-space-size=256'); process.exit(2); }

if (races > 0) {
  const { createRace } = require('./sim');
  const cars = F1.cars.list(2026).filter(c => !/standard/.test(c.id));
  for (let r = 0; r < races; r++) {
    const spec = [];
    for (let i = 0; i < 15; i++) spec.push({ skill: [0, 0.35, 0.7, 1][(i + r) % 4], car: cars[(i + r) % cars.length].id, name: 'c' + i });
    const t0 = Date.now();
    createRace({ track: trackName, cars: spec, laps: 5, quali: 1, wear: 3, seed: 3 + r, grid: 'quali' }).run();
    console.log('warm-up race ' + (r + 1) + ' (' + trackName + ', 15 cars) ' + (Date.now() - t0) + ' ms');
  }
}

const t = L.track(L.IDS[trackName] || trackName), line = L.line(t, null), P = line.points, N = t.samples.length, ds = t.length / N;
const cars = [], ais = [], views = [], at = [], ctxs = [], pits = [];
for (let i = 0; i < n; i++) {
  const car = F1.createCar(F1.REF_SPEC, { random: F1.AI.makeRandom(i + 5) });
  car.tyres.fit('S'); car.tyres.setWearRate(3);
  const ai = F1.createAIDriver({ track: t, raceLine: line, car, skill: i / Math.max(1, n - 1), seed: i + 1, id: i + 1, slot: i });
  car.reset(t, 300 + i * 9); ai.reset(); cars.push(car); ais.push(ai); at.push(300 + i * 9);
  const w = F1.AI.createView(i + 1); w.pace = ai.pace; views.push(w);
  const pit = F1.createPit({ random: F1.AI.makeRandom(i + 9) }); pits.push(pit);
  ctxs.push(Object.assign(F1.AI.createContext(), { phase: 'race', laps: 50, lap: 3, prog: 3, pit: pit.state, wear: 3 }));
}
// worn tyres: hard work on every set until it is ~45 % worn (grip < 1)
const work = { speed: 60, lat: 0.9, brake: 0.6, drive: 0.6, slip: 0.2, onGrass: false, hit: 0 };
for (const c of cars) for (let k = 0; k < 120 * 3600 && Math.max(...c.tyres.state.wear) < 0.45; k++) { work.lat = (k >> 9) & 1 ? 0.9 : -0.9; c.tyres.update(1 / 120, work); }
console.log('tyres: wear ' + cars[0].tyres.state.wear.map(x => x.toFixed(2)).join(' ') + ', grip lat ' + cars[0].tyres.state.grip.lat.toFixed(3));
const VA = ais.map(a => a.profile());
function move() {
  for (let i = 0; i < n; i++) {
    const v = Math.min(VA[i][at[i] | 0] * 0.98, 90);
    at[i] += v / 120 / ds; if (at[i] >= N) at[i] -= N;
    const k = at[i] | 0, p = P[k], q = P[(k + 1) % N], st = cars[i].state, w = views[i];
    st.x = p.x; st.z = p.z; st.y = p.y; st.heading = Math.atan2(q.x - p.x, q.z - p.z); st.speed = v; st.sampleIndex = k; st.d = p.d;
    w.x = st.x; w.z = st.z; w.heading = st.heading; w.speed = v; w.sampleIndex = k; w.d = p.d;
    w.prog = 3 + at[i] / N; ctxs[i].prog = w.prog;
  }
}
function stepAll() { move(); for (let i = 0; i < n; i++) ais[i].think(1 / 120, views, ctxs[i]); }
for (let k = 0; k < 120 * warm; k++) stepAll();
const steps = 120 * 60, out = [];
// sample=K: V8's sampling heap profiler from minute K on (young garbage included): where the bytes come from (by
// function; frames inlined into another function are counted in that one)
const sampleFrom = arg('sample', '') === '' ? -1 : +arg('sample', '');
let session = null;
const post = (m, p) => new Promise((res, rej) => session.post(m, p || {}, (e, r) => e ? rej(e) : res(r)));
(async () => {
  for (let m = 0; m < minutes; m++) {
    if (m === sampleFrom) {
      const inspector = require('inspector'); session = new inspector.Session(); session.connect();
      await post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    }
    global.gc(); const h0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < steps; k++) stepAll();
    const h1 = process.memoryUsage().heapUsed;
    global.gc(); const g0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < steps; k++) move();
    const g1 = process.memoryUsage().heapUsed;
    const bytes = (h1 - h0) - (g1 - g0);
    out.push(bytes / (steps * n));
    console.log('minute ' + (m + 1) + ': ' + (steps * n) + ' think() calls, ' + (bytes / 1048576).toFixed(2) + ' MB = ' + (bytes / (steps * n)).toFixed(2) + ' B/call');
  }
  console.log('B/call per minute: ' + out.map(x => x.toFixed(2)).join(' ') + '  (mistakes ' + ais.reduce((s, a) => s + a.stats.mistakes, 0) + ')');
  if (session) {
    const { profile } = await post('HeapProfiler.stopSampling');
    const sites = new Map();
    (function walk(nd, stack) {
      const cf = nd.callFrame, here = (cf.functionName || '(anon)') + ' ' + (cf.url || '').replace(/^.*[\/]/, '') + ':' + (cf.lineNumber + 1);
      const st = stack.concat(here);
      if (nd.selfSize > 0) { const key = st.slice(-3).reverse().join(' <- '); sites.set(key, (sites.get(key) || 0) + nd.selfSize); }
      for (const c of nd.children) walk(c, st);
    })(profile.head, []);
    console.log('sampled allocation sites (KB, the innermost frames first):');
    for (const [k, v] of [...sites].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log((v / 1024).toFixed(0).padStart(8) + '  ' + k);
  }
})();
