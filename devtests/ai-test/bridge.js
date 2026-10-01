// node devtests/ai-test/bridge.js [deltas=-1,-0.5,-0.25,-0.1,0,0.1,0.25,0.5,1] [skills=0.7,0.2,1]
// Suzuka's over / under crossing (track.bridges: the upper road passes 6.2 m above the lower one, 0.9 m apart in plan).
// Two computer cars, one on each road, start 300 m before the crossing point of their road; the one that would get there
// first is held back so that both arrive together (+ delta s). The REAL js/car.js, contacts through
// F1.AI.createContacts. Checked at every step, for each car: its sample index (car.state and the driver's own
// ai.state.idx) moves on by a few samples at most - never onto the other road; its height stays on its own road surface;
// a view of it located the way a REMOTE car is (F1.AI.updateView with x / y / z only, no sample index) stays on its road.
// Between the two: no contact, and nobody slows or swerves for the car on the other level (each car's speed and lateral
// place through the crossing match the same car driving alone). Also shown: how often a GLOBAL locate without the height
// (no hint; the first locate of a remote car, or after a jump) lands on the wrong road at the crossing. Exit 1 on a fault.
'use strict';
const L = require('./lib'), F1 = L.F1;
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const deltas = arg('deltas', '-1,-0.5,-0.25,-0.1,0,0.1,0.25,0.5,1').split(',').map(Number);
const skills = arg('skills', '0.7,0.2,1').split(',').map(Number);
const STEP = 1 / 120;
const t = L.track('jp-1962'), S = t.samples, N = S.length, ds = t.length / N, line = L.line(t, null);
const br = t.bridges && t.bridges[0];
if (!br) { console.log('no bridge on ' + t.id); process.exit(1); }
const cyc = i => ((i % N) + N) % N;
const rel = (a, b) => { let d = ((b - a) % N + N) % N; return d > N / 2 ? d - N : d; };   // b relative to a, samples
const START = Math.round(300 / ds), STEPS = 120 * 30;

// cfg: {lo: {hold} | null, up: {hold} | null, skill}
function run(cfg) {
  const cars = [], views = [], ents = [];
  for (const which of ['lo', 'up']) {
    if (!cfg[which]) continue;
    const own = which === 'lo' ? br.lo : br.up, car = F1.createCar(F1.REF_SPEC, { tyres: false }), id = which === 'lo' ? 1 : 2;   // (the same id / seed alone and paired)
    const ai = F1.createAIDriver({ track: t, raceLine: line, car, skill: cfg.skill, seed: 5 + id, id, slot: id });
    car.reset(t, cyc(own - START)); ai.reset();
    cars.push({ which, own, car, st: car.state, ai, hold: cfg[which].hold || 0, ctx: Object.assign(F1.AI.createContext(), { phase: 'race', laps: 10 }),
      remote: F1.AI.createView(100 + id), flat: F1.AI.createView(200 + id), faults: [], trace: new Map(), arrive: -1 });
    views.push(F1.AI.createView(id));
    ents.push({ state: car.state, car, solid: true });
  }
  const contacts = F1.AI.createContacts();
  let touches = 0, minPlan = 1e9, minDy = 1e9, flatWrong = 0, time = 0;
  for (let k = 0; k < STEPS; k++) {
    time += STEP;
    cars.forEach((c, i) => { const st = c.st, v = views[i]; v.x = st.x; v.z = st.z; v.y = st.y; v.heading = st.heading; v.speed = st.speed; v.sampleIndex = st.sampleIndex; v.d = st.d; v.pace = c.ai.pace; });
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i], st = c.st;
      if (time < c.hold) { c.ai.think(STEP, views, Object.assign(c.ctx, { locked: true })); st.speed = 0; continue; }
      c.ctx.locked = false;
      const i0 = st.sampleIndex, a0 = c.ai.state.idx;
      const inp = c.ai.think(STEP, views, c.ctx);
      if (inp.reset) c.faults.push('asked for R at ' + st.sampleIndex);
      c.car.update(STEP, inp, t);
      const di = rel(i0, st.sampleIndex), da = rel(a0, c.ai.state.idx);
      if (di < -2 || di > 6) c.faults.push('index jump ' + i0 + ' -> ' + st.sampleIndex);
      if (time - c.hold > 0.05 && (da < -2 || da > 6)) c.faults.push('driver index jump ' + a0 + ' -> ' + c.ai.state.idx);
      const ys = t.surfaceY(st.sampleIndex, st.d);
      if (Math.abs(st.y - ys) > 1.5) c.faults.push('height ' + st.y.toFixed(2) + ', its road ' + ys.toFixed(2) + ' at ' + st.sampleIndex);
      F1.AI.updateView(c.remote, { x: st.x, y: st.y, z: st.z, heading: st.heading, speed: st.speed }, t);
      if (Math.abs(rel(st.sampleIndex, c.remote.sampleIndex)) > 3) c.faults.push('remote view on the other road: ' + c.remote.sampleIndex + ' (car at ' + st.sampleIndex + ')');
      const r = rel(c.own, st.sampleIndex);
      if (r >= -40 && r <= 40) {
        c.flat.sampleIndex = -1;                  // a global locate without the height (v6.1's updateView did that)
        F1.AI.updateView(c.flat, { x: st.x, z: st.z, heading: st.heading, speed: st.speed }, t);
        if (Math.abs(rel(st.sampleIndex, c.flat.sampleIndex)) > 3) flatWrong++;
      }
      if (r >= -60 && r <= 60 && !c.trace.has(r)) c.trace.set(r, [st.speed, st.d]);
      if (c.arrive < 0 && r >= 0 && r < 20) c.arrive = time;
    }
    contacts(ents, STEP, () => { touches++; });
    if (cars.length === 2) {
      const a = cars[0].st, b = cars[1].st, dp = Math.hypot(a.x - b.x, a.z - b.z);
      if (dp < minPlan) { minPlan = dp; minDy = Math.abs(a.y - b.y); }
    }
  }
  return { cars, touches, minPlan, minDy, flatWrong };
}

let bad = 0;
console.log('Suzuka bridge: lower road sample ' + br.lo + ' (y ' + S[br.lo].y.toFixed(1) + '), upper ' + br.up + ' (y ' + S[br.up].y.toFixed(1) + '), ' + br.separation.toFixed(2) + ' m apart');
for (const skill of skills) {
  const soloLo = run({ lo: {}, skill }).cars[0], soloUp = run({ up: {}, skill }).cars[0];
  const first = soloLo.arrive < soloUp.arrive ? 'lo' : 'up', lag = Math.abs(soloLo.arrive - soloUp.arrive);
  console.log('skill ' + skill + ': alone the lower car reaches the crossing after ' + soloLo.arrive.toFixed(2) + ' s, the upper after ' + soloUp.arrive.toFixed(2) + ' s');
  for (const dl of deltas) {
    const hold = Math.max(0, lag + dl), cfg = { skill, lo: { hold: first === 'lo' ? hold : 0 }, up: { hold: first === 'up' ? hold : 0 } };
    const r = run(cfg);
    // alone, with the same hold
    const aLo = run({ lo: cfg.lo, skill }).cars[0], aUp = run({ up: cfg.up, skill }).cars[0];
    let out = '  delta ' + String(dl).padStart(5) + ' s: closest ' + r.minPlan.toFixed(1) + ' m in plan (' + r.minDy.toFixed(1) + ' m apart in height), touches ' + r.touches;
    if (r.touches) bad++;
    for (const [c, a] of [[r.cars[0], aLo], [r.cars[1], aUp]]) {
      let dv = 0, dd = 0;
      for (const [k, [v, d]] of c.trace) { const s = a.trace.get(k); if (s) { dv = Math.max(dv, Math.abs(v - s[0]) * 3.6); dd = Math.max(dd, Math.abs(d - s[1])); } }
      out += ' | ' + c.which + (c.faults.length ? ' ' + c.faults.length + ' FAULTS (' + c.faults[0] + ')' : ' ok') + ', vs alone ' + dv.toFixed(2) + ' km/h ' + dd.toFixed(2) + ' m';
      if (c.faults.length || dv > 1 || dd > 0.3) { bad++; out += ' <-- FAIL'; }
    }
    out += ' | global locate without height: ' + r.flatWrong + ' steps wrong';
    console.log(out);
  }
}
console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
