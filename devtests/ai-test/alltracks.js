// node devtests/ai-test/alltracks.js [tracks=regex] [skills=0,1] [laps=2]
// Every circuit of tracks-data.js: a computer car alone (2025 standard car, tyres on, wear x1) for a few laps from a
// standing start at sample 0 at each skill, and then a pit stop in box 7 (planned at the start of lap 2: in at the
// limit with the limiter, stopped in its box, the tyre change, out again). Reports per circuit: laps, offs, wall hits,
// resets / reverses / stuck, the lap gap to the reference of the car, and the pit stop (events, lane top speed, time
// held). Exit code 1 when a car is stuck, resets, speeds in the pit lane or does not complete its stop.
'use strict';
const L = require('./lib'), F1 = L.F1;
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const re = new RegExp(arg('tracks', '.'), 'i'), skills = arg('skills', '0,1').split(',').map(Number), LAPS = +arg('laps', 2);
const STEP = 1 / 120;
let bad = 0;
const t0 = Date.now();
for (const td of global.F1_TRACKS.filter(t => re.test(t.id) || re.test(t.name))) {
  const t = L.track(td.id), line = L.line(t, null), S = t.samples, N = S.length;
  const parts = [];
  // reference lap of the car
  let ref = 0;
  {
    const car = F1.createCar(F1.REF_SPEC, { tyres: false });
    const ai = F1.createAIDriver({ track: t, raceLine: line, car, reference: true, seed: 1, id: 1 });
    car.reset(t, 0); car.setBattery(1); ai.reset();
    const st = car.state, ctx = F1.AI.createContext(); let time = 0, prev = 0, start = 0, n = 0;
    while (n < 2 && time < 500) {
      car.update(STEP, ai.think(STEP, null, ctx), t); time += STEP;
      if (prev > N * 0.75 && st.sampleIndex < N * 0.25) { n++; if (n === 2) ref = time - start; start = time; }
      prev = st.sampleIndex;
    }
  }
  for (const skill of skills) {
    const car = F1.createCar(F1.REF_SPEC, { random: F1.AI.makeRandom(11) });
    car.tyres.fit('M'); car.tyres.setWearRate(1);
    const ai = F1.createAIDriver({ track: t, raceLine: line, car, skill, seed: 5, id: 1, slot: 7 });
    const pit = F1.createPit({ random: F1.AI.makeRandom(12) });
    car.reset(t, 0); car.setBattery(1); ai.reset();
    const st = car.state, ctx = Object.assign(F1.AI.createContext(), { phase: 'race', laps: LAPS + 1, pit: pit.state });
    let time = 0, prev = 0, start = 0, laps = [], walls = 0, hitOn = false, ev = [], laneMax = 0, held = 0, planned = false, R = 0;
    while (laps.length < LAPS + 1 && time < 200 * (LAPS + 2)) {
      ctx.lap = laps.length;
      if (laps.length === 1 && !planned && t.pit) { ai.planStop('H'); planned = true; }
      const inp = ai.think(STEP, null, ctx);
      if (inp.reset) { R++; F1.AI.resetCar(car, t); continue; }
      if (pit.state.service) { st.speed = 0; held += STEP; } else car.update(STEP, inp, t);
      const e = pit.update(STEP, st, t, { slot: 7, limiter: inp.limiter });
      if (e) { ev.push(e); const c = ai.onPit(e); if (c) car.tyres.fit(c); }
      if (pit.state.inLane) laneMax = Math.max(laneMax, Math.abs(st.speed) * 3.6);
      const h = st.hit > 0.02; if (h && !hitOn) walls++; hitOn = h;
      time += STEP;
      if (prev > N * 0.75 && st.sampleIndex < N * 0.25) { laps.push(time - start); start = time; }
      prev = st.sampleIndex;
    }
    const s = ai.stats, fly = laps.length > 1 ? laps[1 - 1 + 1] : NaN;          // lap 2 (the flying lap before the stop)
    const gap = ref > 0 && laps.length > 1 ? (laps[1] / ref - 1) * 100 : NaN;
    const stopOk = !t.pit || (ev.includes('serviceStart') && ev.includes('serviceDone') && ev.includes('exit') && !ev.includes('speeding') && !ev.includes('penaltyStart'));
    const ok = laps.length >= LAPS + 1 && R === 0 && s.stuck === 0 && stopOk;
    if (!ok) bad++;
    parts.push('s' + skill + ': ' + laps.length + ' laps, lap 2 ' + (isNaN(gap) ? '--' : '+' + gap.toFixed(1) + '%') + ', offs ' + s.offs + ', hits ' + walls + ', R ' + R + ', rev ' + s.reverses + ', stuck ' + s.stuck +
      ', mist ' + s.mistakes + (t.pit ? ', pit ' + (stopOk ? 'ok' : 'FAIL ' + ev.join('/')) + ' (lane max ' + laneMax.toFixed(0) + '/' + t.pit.limitKmh + ', held ' + held.toFixed(1) + ' s)' : ', no pit lane') + (ok ? '' : '  <-- FAIL'));
  }
  console.log(td.id.padEnd(8) + td.name.slice(0, 22).padEnd(23) + parts.join(' | '));
}
console.log((bad ? bad + ' FAILED' : 'all ok') + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
process.exit(bad ? 1 : 0);
