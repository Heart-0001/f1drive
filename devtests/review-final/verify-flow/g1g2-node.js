// Verifier probe (flow G1 / G2), node only, real modules. Not part of the project.
//  G1: how far / how long is the qualifying roll to the line (solo START_BACK = 10 samples; room grid slots 0..15)?
//  G2: what a room year change does to a guest's car at speed: spec swap mid-corner (path vs. no swap), battery,
//      buildRaceLine cost (the frame hitch).
'use strict';
const { F1, STEP, track, lineWant, keysSteer } = require('../driving/load');
const KMH = 3.6;

/* ---------- G1 ---------- */
for (const id of ['it-1922', 'mc-1929', 'be-1925', 'gb-1948']) {
  let tr; try { tr = track(id).track; } catch (e) { console.log(id, 'n/a'); continue; }
  const N = tr.samples.length, ds = tr.length / N;
  const g = tr.grid || [];
  const back = i => { const k = ((N - i) % N + N) % N; return k; };
  const slotDist = g.length ? g.map(b => Math.round(back(b.index) * ds)) : [];
  console.log(`G1 ${id}: sample spacing ${ds.toFixed(2)} m; solo START_BACK=10 -> ${(10 * ds).toFixed(0)} m to the line; grid slots (m behind the line): ${slotDist.join(',')}`);
  // drive the solo roll: full throttle from rest, time until the line
  const car = F1.createCar(null, { random: () => 0.5 }), st = car.state;
  car.reset(tr, ((N - 10) % N + N) % N);
  const lap = F1.createLapCounter(N, st.sampleIndex);
  let t = 0;
  while (!lap.started && t < 30) { car.update(STEP, { up: true }, tr); lap.update(st.sampleIndex, st.speed, STEP); t += STEP; }
  console.log(`G1 ${id}: solo roll from standstill to the line: ${t.toFixed(2)} s (speed at the line ${(st.speed * KMH).toFixed(0)} km/h)`);
}

/* ---------- G2 ---------- */
const cars = F1.cars;
const tr = track('it-1922').track, line = track('it-1922').line;
const N = tr.samples.length;
function run(swapAt, toYear) {
  const spec25 = cars.resolve('2025-ferrari', 2025);
  const car = F1.createCar(spec25, { random: () => 0.5 }), st = car.state;
  let ln = line;
  car.reset(tr, 0);
  car.setBattery(1);
  const inp = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false, limiter: false };
  let t = 0, hits = 0, maxHit = 0, swapped = null, off = 0, minV = 1e9;
  const log = [];
  for (let k = 0; k < 120 * 70; k++) {
    if (swapAt != null && !swapped && st.speed * KMH > 150 && t > swapAt) {
      const before = { id: car.spec.id, gear: st.gear, v: st.speed * KMH, bat: st.battery, idx: st.sampleIndex };
      const t0 = process.hrtime.bigint();
      car.setSpec(cars.resolve('2025-ferrari', toYear)); car.setBattery(1);
      const t1 = process.hrtime.bigint();
      ln = F1.buildRaceLine(tr, car.perf);
      const t2 = process.hrtime.bigint();
      swapped = { before, after: { id: car.spec.id, gear: st.gear, v: st.speed * KMH, bat: st.battery }, setSpecMs: Number(t1 - t0) / 1e6, buildLineMs: Number(t2 - t1) / 1e6, t };
    }
    const w = lineWant(tr, ln, st);
    keysSteer(inp, st, w.steer);
    // follow the line's speed levels crudely: brake when faster than the line's target
    const tgt = ln.points[st.sampleIndex].v || ln.points[st.sampleIndex].speed;
    if (typeof tgt === 'number') { inp.up = st.speed < tgt; inp.down = st.speed > tgt + 2; } else { inp.up = true; inp.down = false; }
    car.update(STEP, inp, tr);
    if (st.hit > 0) { hits++; if (st.hit > maxHit) maxHit = st.hit; }
    if (Math.abs(st.d) > tr.samples[st.sampleIndex].halfW) off++;
    if (!Number.isFinite(st.speed) || !Number.isFinite(st.x)) { log.push('NaN at ' + t); break; }
    t += STEP;
  }
  return { swapped, hits, maxHit: +maxHit.toFixed(3), offSteps: off, finalIdx: st.sampleIndex, log };
}
console.log('G2 line point keys:', Object.keys(line.points[0]).join(','));
console.log('G2 no swap        :', JSON.stringify(run(null)));
console.log('G2 swap to 2010   :', JSON.stringify(run(8, 2010)));
console.log('G2 swap to 2014   :', JSON.stringify(run(8, 2014)));
// buildRaceLine cost on several tracks
for (const id of ['it-1922', 'be-1925', 'sa-2021', 'us-2023', 'mc-1929']) {
  let T; try { T = track(id).track; } catch (e) { continue; }
  const c = F1.createCar(cars.resolve('2025-ferrari', 2010));
  const ms = [];
  for (let k = 0; k < 3; k++) { const a = process.hrtime.bigint(); F1.buildRaceLine(T, c.perf).dispose(); ms.push(Number(process.hrtime.bigint() - a) / 1e6); }
  console.log(`G2 buildRaceLine ${id} (${T.samples.length} samples): ${ms.map(m => m.toFixed(1)).join(' / ')} ms`);
}
