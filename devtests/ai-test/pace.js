// node devtests/ai-test/pace.js [tracks=monza,monaco,...] [skills=0,0.35,0.7,1] [laps=4] [car=<spec id>] [tyres=0|1]
// One computer car alone per run, standing start on the centreline at sample 0 (as the calibration driver), the REAL
// js/car.js at 1/120 s; laps timed at the line crossing (interpolated inside the step). Compared with the REFERENCE:
// the racing line's own margins driven perfectly (F1.createAIDriver({reference: true}): what F1.AI.LEVELS' lapPct is
// calibrated against, devtests/ai-test/calibrate.js); also shown: the seasons calibration's keyboard driver
// (devtests/seasons-calib/driver.mjs) and the line's own lap prediction (no battery).
'use strict';
const L = require('./lib'), F1 = L.F1;
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const tracks = arg('tracks', 'monza,monaco,spa,suzuka,bahrain,zandvoort,singapore').split(',');
const skills = arg('skills', '0,0.35,0.7,1').split(',').map(Number);
const LAPS = +arg('laps', 4), carId = arg('car', ''), withTyres = arg('tyres', '0') === '1';
const spec = carId ? F1.cars.get(carId) : F1.REF_SPEC;
const STEP = 1 / 120;

function drive(t, skill, seed, reference) {
  const car = F1.createCar(spec, withTyres ? { random: F1.AI.makeRandom(seed + 99) } : { tyres: false });
  const line = L.line(t, null);
  const ai = F1.createAIDriver({ track: t, raceLine: line, car, skill, seed, id: 1, reference: !!reference });
  car.reset(t, 0); car.setBattery(1); ai.reset();
  const S = t.samples, N = S.length, st = car.state;
  let time = 0, lapStart = 0, prev = 0, grass = 0, hits = 0, cost = 0n, calls = 0;
  const laps = [], ctx = F1.AI.createContext();
  while (laps.length < LAPS && time < 120 * LAPS + 60) {
    const h0 = process.hrtime.bigint();
    const inp = ai.think(STEP, null, ctx);
    cost += process.hrtime.bigint() - h0; calls++;
    if (inp.reset) F1.AI.resetCar(car, t);
    car.update(STEP, inp, t);
    time += STEP;
    if (st.onGrass) grass++;
    if (st.hit > 0) hits++;
    if (prev > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - lapStart); lapStart = tc;
    }
    prev = st.sampleIndex;
  }
  return { laps, best: laps.length > 1 ? Math.min(...laps.slice(1)) : NaN, grass, hits, stats: ai.stats, us: Number(cost) / calls / 1000 };
}

const summary = {};
for (const name of tracks) {
  const t = L.track(L.IDS[name] || name);
  const kb = L.refLap(t, spec), ref = { flying: drive(t, 1, 1, true).best };
  console.log('\n' + name + ' (' + t.id + ')  reference (the line\'s margins driven perfectly) ' + L.fmt(ref.flying) +
    '   keyboard calibration driver ' + L.fmt(kb.flying) + '   line prediction (no battery) ' + L.fmt(kb.pred));
  for (const s of skills) {
    const r = drive(t, s, 1234);
    const pct = (r.best / ref.flying - 1) * 100;
    const fly = r.laps.slice(1);
    const sd = fly.length > 1 ? Math.sqrt(fly.reduce((a, x) => a + (x - r.best) ** 2, 0) / fly.length) : 0;
    (summary[s] = summary[s] || []).push(pct);
    console.log('  skill ' + s.toFixed(2) + '  laps ' + r.laps.map(L.fmt).join(' ') + '  best ' + L.fmt(r.best) + '  ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + ' %' +
      '  spread ' + (Math.max(...fly) - Math.min(...fly)).toFixed(3) + ' s  grass ' + r.grass + ' hits ' + r.hits +
      '  mistakes ' + r.stats.mistakes + ' offs ' + r.stats.offs + ' resets ' + r.stats.resets + ' rev ' + r.stats.reverses + '  think ' + r.us.toFixed(2) + ' us');
  }
}
console.log('\nmedian gap to the reference per skill:');
for (const s of skills) { const a = summary[s].slice().sort((x, y) => x - y); console.log('  ' + s.toFixed(2) + ': median ' + a[a.length >> 1].toFixed(2) + ' %  min ' + a[0].toFixed(2) + '  max ' + a[a.length - 1].toFixed(2)); }
