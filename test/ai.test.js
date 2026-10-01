// node test/ai.test.js - unit tests for js/ai.js (computer drivers) with the REAL track / car / collide / pit / tyres.
// Fast checks (about 15 s): levels and helpers, determinism with a seed, pace by skill (monotonic, legend close to the
// reference, rookie clearly slower), no allocation in think() once optimised, recovery (wrong way, grass, wall, R-like
// moves), a stopped car ahead is never hit, ghosts are ignored, start reaction, a pit stop in its own box at the
// limit, qualifying ignores the others, blue flags, the field's names / cars; and the critic's regressions (a stopped
// car hidden behind others, a car across a narrow street, a brake test in front, a car coming the wrong way, R never
// next to a stopped car, worn tyres changed in time, two cars into the pit lane together); v6.2: Suzuka's over / under
// crossing (two cars meeting there; views and R with the height), the Monaco hairpin at the top of the full-lock range
// and no attack through it, F1.AI.warmUp (every branch seen; the real drivers drive exactly as without it), no
// allocation with race contexts (a numeric race distance), the contact resolver allocation-free. Longer race
// simulations: devtests/ai-test/ (critic-*.js: the stress cases; bridge.js, warmup.js, fingerprint.js).
// Exit code 1 on any failure.
'use strict';
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// think() allocation is measured with the young generation large enough that no scavenge runs inside the measured
// loop: re-run under those flags when they are missing
if (!global.gc && !process.env.AI_TEST_CHILD) {
  const r = require('child_process').spawnSync(process.execPath,
    ['--expose-gc', '--min-semi-space-size=128', '--max-semi-space-size=128', __filename],
    { stdio: 'inherit', env: Object.assign({}, process.env, { AI_TEST_CHILD: '1' }) });
  process.exit(r.status === null ? 1 : r.status);
}

global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
for (const f of ['tracks-data.js', 'js/seasons-data.js', 'js/cars.js', 'js/track.js', 'js/tyres.js', 'js/car.js',
  'js/raceline.js', 'js/collide.js', 'js/laps.js', 'js/pit.js', 'js/ai.js']) require(path.join(ROOT, f));
const F1 = global.F1, AI = F1.AI;
const STEP = 1 / 120;

let failed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); console.log('ok   ' + name + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)'); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e)); }
}

const tracks = {}, lines = {};
function track(id) { return tracks[id] || (tracks[id] = F1.buildTrack(global.F1_TRACKS.find(t => t.id === id))); }
function line(id) { return lines[id] || (lines[id] = F1.buildRaceLine(track(id))); }
function driver(id, o) {
  o = o || {};
  const t = track(id), car = F1.createCar(o.spec || F1.REF_SPEC, o.tyres ? { random: AI.makeRandom(3) } : { tyres: false });
  const ai = F1.createAIDriver(Object.assign({ track: t, raceLine: line(id), car, skill: 1, seed: 1, id: o.id || 1 }, o.ai || {}));
  return { t, car, ai, st: car.state };
}
// views and contexts as the game creates them (one shape: F1.AI.createView / createContext)
function view(id, st, extra) {
  const v = AI.createView(id);
  refresh(v, st);
  if (extra) for (const k in extra) v[k] = extra[k];
  return v;
}
function context(o) { const c = AI.createContext(); if (o) for (const k in o) c[k] = o[k]; return c; }
function refresh(v, st) { v.x = st.x; v.z = st.z; v.heading = st.heading; v.speed = st.speed; v.sampleIndex = st.sampleIndex; v.d = st.d; }
// laps alone from sample 0, standing start; -> lap times (crossings timed inside the step)
function laps(id, opts, n) {
  const d = driver(id, opts), S = d.t.samples, N = S.length, st = d.st, out = [], ctx = context({ phase: 'free' });
  d.car.reset(d.t, 0); d.car.setBattery(1); d.ai.reset();
  let time = 0, prev = 0, start = 0;
  while (out.length < n && time < 200 * n) {
    const inp = d.ai.think(STEP, null, ctx);
    if (inp.reset) AI.resetCar(d.car, d.t);
    d.car.update(STEP, inp, d.t); time += STEP;
    if (prev > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      out.push(tc - start); start = tc;
    }
    prev = st.sampleIndex;
  }
  return out;
}

const T = 'at-1969';   // Red Bull Ring: short lap, slow and fast corners, a pit lane

test('levels, skill parsing, helpers', () => {
  assert.deepStrictEqual(AI.LEVELS.map(l => l.name), ['新手', '業餘', '職業', '傳奇']);
  assert.deepStrictEqual(AI.LEVELS.map(l => l.id), ['rookie', 'amateur', 'pro', 'legend']);
  for (let i = 1; i < 4; i++) assert(AI.LEVELS[i].skill > AI.LEVELS[i - 1].skill && AI.LEVELS[i].lapPct < AI.LEVELS[i - 1].lapPct);
  assert.strictEqual(AI.skillOf('legend'), 1); assert.strictEqual(AI.skillOf('新手'), 0); assert.strictEqual(AI.skillOf(0.42), 0.42);
  assert.strictEqual(AI.skillOf(7), 1); assert.strictEqual(AI.skillOf(-1), 0); assert.strictEqual(AI.skillOf('??'), AI.LEVELS[2].skill);
  assert.strictEqual(AI.levelOf(0.9).id, 'legend'); assert.strictEqual(AI.levelOf(0.1).id, 'rookie');
  for (let s = 0; s <= 1; s += 0.25) { const p = AI.params(s), q = AI.params(Math.min(1, s + 0.25)); assert(q.grip >= p.grip && q.brake >= p.brake && q.mistake <= p.mistake); }
  assert.strictEqual(AI.startCompound(3, 1, 5000), 'S');
  assert.strictEqual(AI.startCompound(30, 1, 5000), 'H');
  assert.strictEqual(AI.startCompound(8, 5, 5800), 'H');
  const r1 = AI.makeRandom(5), r2 = AI.makeRandom(5), a = [], b = [];
  for (let i = 0; i < 50; i++) { a.push(r1()); b.push(r2()); }
  assert.deepStrictEqual(a, b); assert(a.every(x => x >= 0 && x < 1));
});

test('the field: names, the season\'s cars not taken by humans, two seats per team', () => {
  const cars = F1.cars.list(2026);
  const drivers = id => ({ '2026-mercedes': [{ name: 'George Russell', abbr: 'RUS' }, { name: 'Kimi Antonelli', abbr: 'ANT' }],
    '2026-audi': [{ name: 'Gabriel Bortoleto', abbr: 'BOR' }, { name: 'Nico Hülkenberg', abbr: 'HUL' }] }[id] || []);
  const f = AI.lineup({ cars, taken: ['2026-mercedes'], count: 15, skill: 'pro', seed: 3, drivers, names: ['Player'] });
  assert.strictEqual(f.length, 15);
  assert.strictEqual(new Set(f.map(x => x.name)).size, 15, 'names unique');
  assert(f.every(x => x.name.length <= 16 && x.name !== 'Player'));
  assert.strictEqual(f.filter(x => x.car === '2026-mercedes').length, 1, 'the human took one Mercedes seat');
  assert(f.some(x => x.name === 'Kimi Antonelli') && !f.some(x => x.name === 'George Russell'), 'the human sits in the first seat');
  assert(f.some(x => x.name === 'G. Bortoleto'), 'long names are shortened: ' + f.map(x => x.name).join(', '));
  assert(f.every(x => !/standard/.test(x.car)));
  const teams = new Set(f.slice(0, cars.length - 2).map(x => x.car));
  assert.strictEqual(teams.size, cars.length - 2, 'one seat of every team first');
  assert(f.every(x => Math.abs(x.skill - AI.skillOf('pro')) <= 0.04 + 1e-9));
  const g = AI.lineup({ cars, count: 8, skill: 'mixed', seed: 3 });
  assert(new Set(g.map(x => AI.levelOf(x.skill).id)).size >= 2, 'mixed skills');
  assert.deepStrictEqual(AI.lineup({ cars, count: 8, skill: 'mixed', seed: 3 }), g, 'deterministic');
  // a human taking a seat (a player joining the room with that team's car) leaves every other driver as he was:
  // same level, same randomness (2026-10-02: one generator for the whole list shuffled the levels of everybody after it)
  const seatNames = id => [{ name: 'A ' + id.slice(5) }, { name: 'B ' + id.slice(5) }];
  const g2 = AI.lineup({ cars, count: 8, skill: 'mixed', seed: 3, drivers: seatNames });
  const h = AI.lineup({ cars, taken: [g2[1].car], count: 8, skill: 'mixed', seed: 3, drivers: seatNames });
  const key = x => x.car + '|' + x.name;
  const before = new Map(g2.map(x => [key(x), x]));
  const kept = h.filter(x => before.has(key(x)));
  assert(kept.length >= 6, 'most drivers stay: ' + kept.length);
  assert(kept.every(x => before.get(key(x)).skill === x.skill && before.get(key(x)).seed === x.seed), 'levels / seeds follow the seat: ' +
    kept.filter(x => before.get(key(x)).skill !== x.skill).map(x => x.name).join(', '));
});

test('determinism: the same seed drives the same race, another seed another', () => {
  function race(seeds) {
    const ds = seeds.map((s, i) => driver(T, { id: i + 1, ai: { seed: s, skill: [0.2, 0.6, 0.9][i], slot: i } }));
    ds.forEach((d, i) => { AI.placeOnGrid(d.car, d.t, i); d.ai.reset(); });
    const views = ds.map((d, i) => view(i + 1, d.st)), ctx = context({ phase: 'race' }), hit = AI.createContacts();
    const ent = ds.map(d => ({ state: d.st, car: d.car, solid: true })), trace = [];
    for (let k = 0; k < 120 * 40; k++) {
      ds.forEach((d, i) => refresh(views[i], d.st));
      ds.forEach(d => { const inp = d.ai.think(STEP, views, ctx); d.car.update(STEP, inp, d.t); });
      hit(ent, STEP);
      if (k % 60 === 0) trace.push(ds.map(d => d.st.x.toFixed(6) + ',' + d.st.z.toFixed(6)).join(';'));
    }
    return trace.join('|');
  }
  const a = race([11, 22, 33]), b = race([11, 22, 33]), c = race([11, 22, 34]);
  assert.strictEqual(a, b, 'same seeds, different races');
  assert.notStrictEqual(a, c, 'another seed changed nothing');
});

let refLap = 0;
test('pace by skill: monotonic, legend 0.3..2.5 % off the reference, rookie 4..12 %', () => {
  const ref = Math.min(...laps(T, { ai: { reference: true } }, 3).slice(1));
  refLap = ref;
  const best = [0, 0.35, 0.7, 1].map(s => {
    const l = laps(T, { ai: { skill: s, seed: 9 } }, 3).slice(1);
    return l.reduce((a, b) => a + b, 0) / l.length;
  });
  const pct = best.map(b => (b / ref - 1) * 100);
  for (let i = 1; i < 4; i++) assert(best[i] < best[i - 1], 'not monotonic: ' + best.map(b => b.toFixed(3)).join(' '));
  assert(pct[3] > 0.3 && pct[3] < 2.5, 'legend ' + pct[3].toFixed(2) + ' %');
  assert(pct[0] > 4 && pct[0] < 12, 'rookie ' + pct[0].toFixed(2) + ' %');
  console.log('     reference ' + ref.toFixed(3) + ' s; skills 0 / 0.35 / 0.7 / 1: ' + pct.map(p => '+' + p.toFixed(2) + ' %').join(' / '));
});

test('a faster car (2026 Mercedes vs the 2026 standard car) comes through on top of skill', () => {
  const a = laps(T, { spec: F1.cars.get('2026-mercedes'), ai: { skill: 0.7, seed: 4 } }, 3).slice(1);
  const b = laps(T, { spec: F1.cars.get('2026-standard'), ai: { skill: 0.7, seed: 4 } }, 3).slice(1);
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  assert(ma < mb, 'Mercedes ' + ma.toFixed(3) + ' standard ' + mb.toFixed(3));
});

test('no allocation in think() once optimised (8 cars in traffic, race contexts, F1.AI.warmUp first)', () => {
  // F1.AI.warmUp on the track (the game calls it while the track loads), the 8 drivers through 2 minutes of racing,
  // then measured minutes: the heap growth between two GCs is what think() allocated (the young generation is large
  // enough that nothing is collected in between). Real tyres and race contexts as the game fills them - a number for
  // the race distance (a variable that was a number or null boxed it at every call: 16 B), the pit state, the wear.
  if (!global.gc) { console.log('     (skipped: run with --expose-gc)'); return; }
  const t = track('it-1922'), ln = line('it-1922'), P = ln.points, N = t.samples.length, ds = t.length / N;
  const w0 = AI.warmUp(t, ln);
  assert(w0 && w0.calls > 10000 && w0.pitStops === 2, 'warm-up ' + JSON.stringify(w0));
  const cars = [], ais = [], views = [], pos = [], ctxs = [];
  for (let i = 0; i < 8; i++) {
    const car = F1.createCar(F1.REF_SPEC, { random: AI.makeRandom(i + 3) });
    const ai = F1.createAIDriver({ track: t, raceLine: ln, car, skill: i / 7, seed: i + 1, id: i + 1, slot: i });
    car.reset(t, 300 + i * 9); ai.reset(); cars.push(car); ais.push(ai); pos.push(300 + i * 9);
    const w = AI.createView(i + 1); w.pace = ai.pace; views.push(w);
    ctxs.push(context({ phase: 'race', laps: 30, lap: 2, prog: 2, wear: 2, pit: F1.createPit({ random: AI.makeRandom(i + 7) }).state }));
  }
  const VA = ais.map(a => a.profile());
  function move() {        // along the line at 98 % of each profile: every racecraft branch, no car.update (it allocates)
    for (let i = 0; i < 8; i++) {
      const v = Math.min(VA[i][pos[i] | 0] * 0.98, 90);
      pos[i] += v / 120 / ds; if (pos[i] >= N) pos[i] -= N;
      const k = pos[i] | 0, p = P[k], q = P[(k + 1) % N], st = cars[i].state, w = views[i];
      st.x = p.x; st.z = p.z; st.y = p.y; st.heading = Math.atan2(q.x - p.x, q.z - p.z); st.speed = v; st.sampleIndex = k; st.d = p.d;
      w.x = st.x; w.z = st.z; w.y = st.y; w.heading = st.heading; w.speed = v; w.sampleIndex = k; w.d = p.d;
      w.prog = 2 + pos[i] / N; ctxs[i].prog = w.prog;
    }
  }
  for (let k = 0; k < 120 * 120; k++) { move(); for (let i = 0; i < 8; i++) ais[i].think(STEP, views, ctxs[i]); }
  let best = Infinity;
  for (let r = 0; r < 4 && best > 2; r++) {      // (up to 4 minutes: V8 re-optimises now and then, the interpreter boxes meanwhile)
    global.gc(); const h0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < 120 * 60; k++) { move(); for (let i = 0; i < 8; i++) ais[i].think(STEP, views, ctxs[i]); }
    const h1 = process.memoryUsage().heapUsed;
    best = Math.min(best, (h1 - h0) / (120 * 60 * 8));
  }
  assert(best < 2, 'think() allocates ' + best.toFixed(2) + ' B per call');
  console.log('     ' + best.toFixed(3) + ' B per call (warm-up: ' + w0.calls + ' think calls, ' + w0.pitStops + ' stops)');
});

test('the contact resolver allocates nothing per call (cars close together, no contact)', () => {
  if (!global.gc) { console.log('     (skipped: run with --expose-gc)'); return; }
  const t = track(T), S = t.samples, resolve = AI.createContacts(), ent = [];
  for (let i = 0; i < 10; i++) {
    const car = F1.createCar(F1.REF_SPEC, { tyres: false }); car.reset(t, 100 + 5 * i);
    const s = S[car.state.sampleIndex]; car.state.x += s.nx * (i % 2 ? 2.4 : -2.4); car.state.z += s.nz * (i % 2 ? 2.4 : -2.4); car.state.speed = 50;
    ent.push({ state: car.state, car, solid: true });
  }
  for (let k = 0; k < 20000; k++) resolve(ent, STEP);
  global.gc(); const h0 = process.memoryUsage().heapUsed;
  let max = 0;
  for (let k = 0; k < 50000; k++) max = Math.max(max, resolve(ent, STEP));
  const per = (process.memoryUsage().heapUsed - h0) / 50000;
  assert.strictEqual(max, 0, 'the cars touched');
  assert(per < 2, per.toFixed(2) + ' B per call');
});

test('cost: think() well under 0.05 ms per call', () => {
  const ds = [0, 1, 2, 3, 4, 5].map(i => driver(T, { id: i + 1, ai: { seed: i, skill: i / 5, slot: i } }));
  ds.forEach((d, i) => { AI.placeOnGrid(d.car, d.t, i); d.ai.reset(); });
  const views = ds.map((d, i) => view(i + 1, d.st)), ctx = context({ phase: 'race' });
  let ns = 0, n = 0;
  for (let k = 0; k < 120 * 30; k++) {
    ds.forEach((d, i) => refresh(views[i], d.st));
    for (const d of ds) {
      const a = process.hrtime();
      const inp = d.ai.think(STEP, views, ctx);
      const e = process.hrtime(a); if (k > 600) { ns += e[0] * 1e9 + e[1]; n++; }
      d.car.update(STEP, inp, d.t);
    }
  }
  const us = ns / n / 1000;
  assert(us < 20, 'think ' + us.toFixed(2) + ' us');
  console.log('     ' + us.toFixed(2) + ' us per call (6 cars)');
});

test('recovery: facing the wrong way -> stops and asks for R; the move is noticed', () => {
  const d = driver(T, { ai: { skill: 0.5 } }), S = d.t.samples, ctx = context({ phase: 'free' });
  d.car.reset(d.t, 400); d.st.heading += Math.PI; d.car.update(1e-4, null, d.t); d.ai.reset();
  let asked = -1, time = 0;
  for (let k = 0; k < 120 * 10 && asked < 0; k++) {
    const inp = d.ai.think(STEP, null, ctx);
    if (inp.reset) { asked = time; AI.resetCar(d.car, d.t); break; }
    d.car.update(STEP, inp, d.t); time += STEP;
  }
  assert(asked >= 0 && asked < 4, 'no R asked within 4 s (' + asked + ')');
  const i0 = d.st.sampleIndex;
  for (let k = 0; k < 120 * 6; k++) { const inp = d.ai.think(STEP, null, ctx); assert(!inp.reset, 'asked for R again'); d.car.update(STEP, inp, d.t); }
  let moved = d.st.sampleIndex - i0; if (moved < 0) moved += S.length;
  assert(moved > 40 && moved < S.length / 2, 'did not drive on in the racing direction after R (' + moved + ' samples)');
});

test('recovery: from the grass back onto the road, no R', () => {
  const d = driver(T, { ai: { skill: 0.3 } }), ctx = context({ phase: 'free' });
  d.car.reset(d.t, 700); const s = d.t.samples[d.st.sampleIndex];
  const side = s.wallPosDist > 13 ? 1 : -1;
  d.st.x += s.nx * side * 11; d.st.z += s.nz * side * 11; d.car.update(1e-4, null, d.t); d.ai.reset();
  assert(d.st.onGrass, 'not on the grass');
  let back = -1, time = 0, resets = 0;
  for (let k = 0; k < 120 * 15; k++) {
    const inp = d.ai.think(STEP, null, ctx); if (inp.reset) resets++;
    d.car.update(STEP, inp, d.t); time += STEP;
    if (back < 0 && !d.st.onGrass && Math.abs(d.st.d) < (s.halfW || 7) - 1) back = time;
  }
  assert(back > 0 && back < 6, 'back on the road after ' + back + ' s');
  assert.strictEqual(resets, 0);
});

test('recovery: nose in a wall, standing -> reverse / R, then on its way', () => {
  const d = driver('mc-1929', { ai: { skill: 0.5 } }), S = d.t.samples, N = S.length, ctx = context({ phase: 'free' });
  // a sample with a wall on the +n side close by, the car pointing into it
  let i = 200; while (!(S[i].wallPos && S[i].wallPosDist < 9)) i = (i + 1) % N;
  d.car.reset(d.t, i); const s = S[d.st.sampleIndex];
  d.st.x += s.nx * (s.wallPosDist - 1.6); d.st.z += s.nz * (s.wallPosDist - 1.6);
  d.st.heading = Math.atan2(s.nx, s.nz); d.car.update(1e-4, null, d.t); d.ai.reset();
  const i0 = d.st.sampleIndex; let rs = 0;
  for (let k = 0; k < 120 * 30; k++) {
    const inp = d.ai.think(STEP, null, ctx);
    if (inp.reset) { rs++; AI.resetCar(d.car, d.t); continue; }
    d.car.update(STEP, inp, d.t);
  }
  let moved = d.st.sampleIndex - i0; if (moved < 0) moved += N;
  assert(moved > 100 && moved < N / 2, 'still stuck (' + moved + ' samples, ' + rs + ' R, ' + d.ai.stats.reverses + ' reverses)');
  assert(rs <= 2, rs + ' R');
});

test('a stopped car on the racing line ahead is never hit (passed with room or waited for)', () => {
  for (const skill of [0, 1]) {
    const a = driver(T, { id: 1, ai: { skill, seed: 5 } }), b = driver(T, { id: 2 });
    const P = line(T).points;
    a.car.reset(a.t, 20); a.ai.reset();
    b.car.reset(b.t, 260); const sb = b.t.samples[b.st.sampleIndex];       // parked across the line's place
    b.st.x += sb.nx * P[260].d; b.st.z += sb.nz * P[260].d; b.car.update(1e-4, null, b.t);
    const views = [view(1, a.st), view(2, b.st)], ctx = context({ phase: 'race' });
    let overlap = 0, passed = false;
    for (let k = 0; k < 120 * 40 && !passed; k++) {
      refresh(views[0], a.st);
      const inp = a.ai.think(STEP, views, ctx); a.car.update(STEP, inp, a.t);
      if (F1.resolveCarCollisions.overlap(a.st, b.st) > 0) overlap++;
      let g = a.st.sampleIndex - b.st.sampleIndex; if (g < -a.t.samples.length / 2) g += a.t.samples.length;
      if (g > 6) passed = true;
    }
    assert.strictEqual(overlap, 0, 'skill ' + skill + ': touched the stopped car');
    assert(passed, 'skill ' + skill + ': never got past (' + a.ai.state.mode + ' ' + a.ai.state.cap + ')');
  }
});

test('a car ahead is followed at a gap, never rammed', () => {
  const a = driver(T, { id: 1, ai: { skill: 1, seed: 6 } }), b = driver(T, { id: 2, ai: { skill: 0, seed: 7 } });
  a.car.reset(a.t, 0); b.car.reset(b.t, 15); a.ai.reset(); b.ai.reset();
  const views = [view(1, a.st, { pace: a.ai.pace }), view(2, b.st, { pace: b.ai.pace })], ctx = context({ phase: 'race' });
  let overlap = 0, minGap = 1e9;
  for (let k = 0; k < 120 * 60; k++) {
    refresh(views[0], a.st); refresh(views[1], b.st);
    const ia = a.ai.think(STEP, views, ctx), ib = b.ai.think(STEP, views, ctx);
    a.car.update(STEP, ia, a.t); b.car.update(STEP, ib, b.t);
    if (F1.resolveCarCollisions.overlap(a.st, b.st) > 0) overlap++;
    minGap = Math.min(minGap, Math.hypot(a.st.x - b.st.x, a.st.z - b.st.z));
  }
  assert.strictEqual(overlap, 0, 'the two cars touched (closest ' + minGap.toFixed(2) + ' m)');
});

test('ghosts are ignored (qualifying, pit lane, spectators)', () => {
  for (const mode of ['ghost', 'quali']) {
    const a = driver(T, { id: 1, ai: { skill: 1, seed: 2 } }), b = driver(T, { id: 2 });
    a.car.reset(a.t, 0); a.ai.reset(); b.car.reset(b.t, 150);
    const views = [view(2, b.st, { ghost: mode === 'ghost' })], ctx = context({ phase: mode === 'quali' ? 'quali' : 'race' });
    let minTarget = 1e9;
    for (let k = 0; k < 120 * 6; k++) {
      const inp = a.ai.think(STEP, views, ctx); a.car.update(STEP, inp, a.t);
      if (a.st.sampleIndex > 100 && a.st.sampleIndex < 150) minTarget = Math.min(minTarget, a.ai.state.targetSpeed);
    }
    assert(a.ai.state.cap !== 'follow' && minTarget > 40, mode + ': slowed for a ghost (' + minTarget.toFixed(1) + ')');
  }
});

test('start: pad at rest while locked, a skill-dependent reaction at lights out', () => {
  const react = [0, 1].map(skill => {
    const d = driver(T, { ai: { skill, seed: 8 } }), ctx = { phase: 'grid', locked: true };
    AI.placeOnGrid(d.car, d.t, 3); d.ai.reset();
    for (let k = 0; k < 120; k++) { const inp = d.ai.think(STEP, null, ctx); assert(inp.throttle === 0 && inp.brake === 0 && !inp.boost); }
    ctx.locked = false; ctx.phase = 'race';
    let t0 = -1;
    for (let k = 0; k < 120 * 2 && t0 < 0; k++) { const inp = d.ai.think(STEP, null, ctx); d.car.update(STEP, inp, d.t); if (inp.throttle > 0) t0 = k * STEP; }
    return t0;
  });
  assert(react[0] > react[1], 'rookie ' + react[0] + ' s, legend ' + react[1] + ' s');
  assert(react[1] > 0.15 && react[1] < 0.3 && react[0] > 0.3 && react[0] < 0.6, react.join(' / '));
});

test('a pit stop: at the limit with the limiter, stopped in its own box, the compound fitted, out again', () => {
  const id = 'it-1922', d = driver(id, { tyres: true, ai: { skill: 0.7, seed: 3, slot: 5 } }), t = d.t, N = t.samples.length;
  const pit = F1.createPit({ random: AI.makeRandom(4) });
  d.car.reset(t, (t.pit.from - 600 + N) % N); d.car.tyres.fit('M'); d.ai.reset();
  d.ai.planStop('H');
  const ctx = context({ phase: 'race', lap: 2, laps: 10, pit: pit.state });
  const ev = []; let fitted = null, maxLane = 0, limiterOff = 0, held = 0, time = 0;
  let after = 0;
  for (let k = 0; k < 120 * 90 && after < 120 * 12; k++) {
    if (ev.includes('exit')) after++;
    const inp = d.ai.think(STEP, null, ctx);
    if (pit.state.service) { d.st.speed = 0; held += STEP; }
    else d.car.update(STEP, inp, t);
    const e = pit.update(STEP, d.st, t, { slot: 5, limiter: inp.limiter });
    if (e) { ev.push(e); const c = d.ai.onPit(e); if (c) { d.car.tyres.fit(c); fitted = c; } }
    if (pit.state.inLane) { maxLane = Math.max(maxLane, Math.abs(d.st.speed) * 3.6); if (!inp.limiter) limiterOff++; }
    time += STEP;
  }
  assert(ev.includes('enter') && ev.includes('serviceStart') && ev.includes('serviceDone') && ev.includes('exit'), 'events ' + ev.join(','));
  assert(!ev.includes('speeding') && !ev.includes('penaltyStart'), 'speeding: ' + ev.join(','));
  assert.strictEqual(fitted, 'H'); assert.strictEqual(d.car.tyres.state.compound, 'H');
  assert(maxLane <= t.pit.limitKmh + 3, 'lane speed ' + maxLane.toFixed(1));
  assert.strictEqual(limiterOff, 0, 'limiter off in the lane');
  assert(held > 1.9 && held < 4.6, 'held ' + held.toFixed(2) + ' s');
  assert.strictEqual(d.ai.plan, null, 'the plan is over once the car is back on the track');
  assert.strictEqual(d.ai.stats.offs, 0, 'off the asphalt on the way');
});

test('blue flag: a car a lap up the road right behind -> off the line, lets it by', () => {
  const a = driver(T, { id: 1, ai: { skill: 0, seed: 2 } }), b = driver(T, { id: 2, ai: { skill: 1, seed: 3 } });
  a.car.reset(a.t, 300); b.car.reset(b.t, 285); a.ai.reset(); b.ai.reset();
  const va = view(1, a.st, { prog: 0.3, pace: a.ai.pace }), vb = view(2, b.st, { prog: 1.29, pace: b.ai.pace }), views = [va, vb];
  const ctxA = context({ phase: 'race', prog: 0.3 }), ctxB = context({ phase: 'race', prog: 1.29 });
  let yielded = false, passed = false;
  for (let k = 0; k < 120 * 40 && !passed; k++) {
    refresh(va, a.st); refresh(vb, b.st);
    const ia = a.ai.think(STEP, views, ctxA), ib = b.ai.think(STEP, views, ctxB);
    a.car.update(STEP, ia, a.t); b.car.update(STEP, ib, b.t);
    if (a.ai.state.mode === 'yield') yielded = true;
    let g = b.st.sampleIndex - a.st.sampleIndex; if (g < -a.t.samples.length / 2) g += a.t.samples.length;
    if (g > 5) passed = true;
  }
  assert(yielded, 'never yielded'); assert(passed, 'the leader did not get by');
});

// ---- the critic's regressions (devtests/ai-test/critic-*.js found each of these failing) -------------------------
// a small race of computer cars + extra "actor" cars, the real car physics, every pair resolved as the game does
function pack(id, specs, steps, onStep, onInit) {
  const t = track(id), ln = line(id), N = t.samples.length, P = ln.points, contacts = AI.createContacts();
  const cs = specs.map((sp, i) => {
    const car = F1.createCar(sp.spec || F1.REF_SPEC, { tyres: false }), st = car.state, k = ((sp.at % N) + N) % N;
    car.reset(t, k); const s = t.samples[k], d = sp.d != null ? sp.d : P[k].d;
    st.x = s.x + s.nx * d; st.z = s.z + s.nz * d; st.heading = Math.atan2(s.tx, s.tz) + (sp.yaw || 0);
    car.update(1e-4, null, t); st.speed = sp.v || 0;
    const ai = sp.kind === 'ai' ? F1.createAIDriver({ track: t, raceLine: ln, car, skill: sp.skill == null ? 0.7 : sp.skill, seed: 11 + i, id: i + 1, slot: i }) : null;
    if (ai) ai.reset();
    return { sp, car, st, ai, view: AI.createView(i + 1), ctx: context({ phase: 'race', laps: 30 }), wrongPos: k, R: 0 };
  });
  const views = cs.map(c => c.view), ent = cs.map(c => ({ state: c.st, car: c.car, solid: true }));
  if (onInit) onInit(cs);
  let maxHit = [0, 0], touches = 0;
  for (let k = 0; k < steps; k++) {
    cs.forEach(c => { refresh(c.view, c.st); c.view.pace = c.ai ? c.ai.pace : NaN; });
    for (const c of cs) {
      if (c.sp.kind === 'parked') { c.st.speed = 0; continue; }
      if (c.sp.kind === 'wrong') {          // kinematic: back along the racing line at sp.v
        c.wrongPos -= c.sp.v * STEP / (t.length / N); if (c.wrongPos < 0) c.wrongPos += N;
        const j = Math.floor(c.wrongPos), p = P[j], q = P[(j + 1) % N], a = c.wrongPos - j;
        c.st.x = p.x + (q.x - p.x) * a; c.st.z = p.z + (q.z - p.z) * a; c.st.heading = Math.atan2(p.x - q.x, p.z - q.z); c.st.speed = c.sp.v;
        c.st.sampleIndex = j; c.st.d = p.d; continue;
      }
      const inp = c.ai.think(STEP, views, c.ctx);
      if (onStep) onStep(k, c, inp);
      if (inp.reset) { AI.resetCar(c.car, t, c.st.sampleIndex, views, c.view.id); c.R++; continue; }
      c.car.update(STEP, inp, t);
    }
    contacts(ent, STEP, (i, j, dv) => { touches++; const h = Math.min(1, dv / 18); if (cs[i].sp.kind !== 'ai' || cs[j].sp.kind !== 'ai') maxHit[1] = Math.max(maxHit[1], h); else maxHit[0] = Math.max(maxHit[0], h); });
  }
  return { cs, t, maxAI: maxHit[0], maxActor: maxHit[1], touches };
}

test('a car standing on the line hidden behind others: a stream of 6 cars gets past it, nobody hits it hard, no R', () => {
  // Monza main straight, the stopped car on the racing line; the stream arrives at full speed 1 s apart (single file
  // past it under the yellow: 40 s for all six)
  const specs = [{ kind: 'parked', at: 2300 }];
  for (let i = 0; i < 6; i++) specs.push({ kind: 'ai', skill: i / 5, at: 1800 - i * 35, v: 75 });
  const r = pack('it-1922', specs, 120 * 40);
  const N = r.t.samples.length;
  assert(r.maxActor <= 0.15, 'the standing car was hit at ' + r.maxActor.toFixed(2));
  assert(r.maxAI <= 0.3, 'computer cars hit each other at ' + r.maxAI.toFixed(2));
  for (const c of r.cs.slice(1)) {
    let past = c.st.sampleIndex - 2300; if (past < -N / 2) past += N;
    assert(past > 20, 'car ' + c.view.id + ' did not get past (at ' + c.st.sampleIndex + ', ' + c.ai.state.mode + ' ' + c.ai.state.cap + ')');
    assert.strictEqual(c.R, 0, 'R');
  }
});

test('a car standing ACROSS a narrow street (Baku castle): the computer cars get by (R puts one past it at worst)', () => {
  const t = track('az-2016'), S = t.samples; let nar = 0;
  for (let i = 0; i < S.length; i++) if (S[i].halfW < S[nar].halfW) nar = i;
  const specs = [{ kind: 'parked', at: nar, d: 0, yaw: Math.PI / 2 }];
  for (let i = 0; i < 3; i++) specs.push({ kind: 'ai', skill: 0.5, at: nar - 200 - i * 20, v: 30 });
  const r = pack('az-2016', specs, 120 * 60);
  for (const c of r.cs.slice(1)) {
    let past = c.st.sampleIndex - nar; if (past < -S.length / 2) past += S.length;
    assert(past > 10, 'car ' + c.view.id + ' still behind it (' + c.ai.state.mode + ' ' + c.ai.state.cap + ', R ' + c.R + ')');
    assert(c.R <= 1, c.R + ' R');
  }
  assert(r.maxActor <= 0.2, 'hit at ' + r.maxActor.toFixed(2));
});

test('a car in front braking as hard as it can on a straight (a brake test) is not hit', () => {
  const r = pack('it-1922', [{ kind: 'ai', skill: 1, at: 2060, v: 80 }, { kind: 'ai', skill: 0, at: 2045, v: 80 }], 120 * 8, (k, c, inp) => {
    if (c.view.id === 1 && k > 120 * 3 && k < 120 * 5) { inp.throttle = 0; inp.brake = 1; inp.boost = false; }   // car 1 stands on the brakes
  });
  assert.strictEqual(r.touches, 0, 'the follower ran into it');
});

test('a car coming the wrong way down a straight at 15 m/s: the computer car goes round it', () => {
  const r = pack('it-1922', [{ kind: 'wrong', at: 2330, v: 15 }, { kind: 'ai', skill: 0.5, at: 1990, v: 70 }], 120 * 8);
  assert(r.maxActor === 0, 'head-on at ' + r.maxActor.toFixed(2));
});

test('F1.AI.resetCar with the others: never put down on (or just behind) a standing car', () => {
  const t = track('it-1922'), N = t.samples.length;
  const a = F1.createCar(F1.REF_SPEC, { tyres: false }), b = F1.createCar(F1.REF_SPEC, { tyres: false });
  b.reset(t, 1000); const vb = view(2, b.state);
  a.reset(t, 998); a.state.x += 3;                       // beside / behind it
  const idx = AI.resetCar(a, t, 998, [view(1, a.state), vb], 1);
  assert(Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z) >= 7, 'put down ' + Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z).toFixed(1) + ' m from it');
  assert(((idx - 998) % N + N) % N < 50, 'moved too far (' + idx + ')');
  assert.strictEqual(AI.resetCar(a, t, 500, [vb], 1), a.state.sampleIndex, 'a free place is kept');
});

test('worn tyres at wear x5: stops are made in time - never past 97 %, no puncture (the stop search used to give up)', () => {
  const id = 'gb-1948', t = track(id), N = t.samples.length;
  const car = F1.createCar(F1.REF_SPEC, { random: AI.makeRandom(4) }), st = car.state;
  car.tyres.fit('H'); car.tyres.setWearRate(5);
  const ai = F1.createAIDriver({ track: t, raceLine: line(id), car, skill: 0.7, seed: 3, id: 1, slot: 2 }), pit = F1.createPit({ random: AI.makeRandom(5) });
  car.reset(t, 10); ai.reset();
  const ctx = context({ phase: 'race', laps: 7, pit: pit.state, wear: 5 });
  let laps = 0, prev = st.sampleIndex, maxW = 0, punct = false, stops = 0;
  for (let k = 0; k < 120 * 800 && laps < 7; k++) {
    ctx.lap = laps;
    const inp = ai.think(STEP, null, ctx);
    if (pit.state.service) st.speed = 0; else car.update(STEP, inp, t);
    const e = pit.update(STEP, st, t, { slot: 2, limiter: inp.limiter });
    if (e) { const c = ai.onPit(e); if (c) { car.tyres.fit(c); stops++; } }
    maxW = Math.max(maxW, ...car.tyres.state.wear); if (car.tyres.state.puncture >= 0) punct = true;
    if (prev > N * 0.75 && st.sampleIndex < N * 0.25) laps++;
    prev = st.sampleIndex;
  }
  assert(laps >= 7, 'only ' + laps + ' laps');
  assert(!punct, 'a puncture'); assert(maxW <= 0.97, 'wear reached ' + maxW.toFixed(3));
  assert(stops >= 1, 'no stop');
});

test('two cars stopping on the same lap do not run into each other on the way into the pit lane', () => {
  const id = 'it-1922', t = track(id), N = t.samples.length, from = t.pit.from;
  const specs = [{ kind: 'ai', skill: 0.7, at: from - 260, v: 70, d: -3 }, { kind: 'ai', skill: 0.7, at: from - 262, v: 70, d: 2 }];
  const pits = [F1.createPit({ random: AI.makeRandom(1) }), F1.createPit({ random: AI.makeRandom(2) })], entered = [false, false];
  const r = pack(id, specs, 120 * 14, (k, c, inp) => {
    const i = c.view.id - 1;
    if (pits[i].update(STEP, c.st, t, { slot: i, limiter: inp.limiter }) === 'enter') entered[i] = true;
  }, cs => cs.forEach((c, i) => { c.ctx.pit = pits[i].state; c.ai.planStop('M'); }));
  assert.strictEqual(r.touches, 0, 'they touched');
  assert(entered[0] && entered[1], 'not both went in: ' + entered);
});


// ---- v6.2: Suzuka's over / under crossing, the Monaco hairpin at full lock, the warm-up ------------------------------
test('Suzuka bridge: two cars meeting at the crossing stay on their roads, never touch, ignore each other', () => {
  // (devtests/ai-test/bridge.js: 3 skills x 9 timings) one car on each road, timed to be at the crossing together
  const t = track('jp-1962'), ln = line('jp-1962'), S = t.samples, N = S.length, ds = t.length / N, br = t.bridges[0];
  assert(br && br.separation > 5, 'no bridge');
  const rel = (a, b) => { let d = ((b - a) % N + N) % N; return d > N / 2 ? d - N : d; };
  const START = Math.round(300 / ds);
  function run(cfg) {
    const cs = [];
    for (const w of ['lo', 'up']) {
      if (!cfg[w]) continue;
      const own = w === 'lo' ? br.lo : br.up, car = F1.createCar(F1.REF_SPEC, { tyres: false }), id = w === 'lo' ? 1 : 2;
      const ai = F1.createAIDriver({ track: t, raceLine: ln, car, skill: 0.7, seed: 5 + id, id, slot: id });
      car.reset(t, (own - START + N) % N); ai.reset();
      cs.push({ w, own, car, st: car.state, ai, hold: cfg[w].hold || 0, view: AI.createView(id), remote: AI.createView(10 + id), ctx: context({ phase: 'race', laps: 9 }), at: -1, trace: new Map(), faults: 0 });
    }
    const views = cs.map(c => c.view), ent = cs.map(c => ({ state: c.st, car: c.car, solid: true })), hit = AI.createContacts();
    let touches = 0, minPlan = 1e9, time = 0;
    for (let k = 0; k < 120 * 25; k++) {
      time += STEP;
      cs.forEach(c => refresh(c.view, c.st));
      for (const c of cs) {
        const st = c.st;
        c.ctx.locked = time < c.hold;
        const i0 = st.sampleIndex, a0 = c.ai.state.idx, inp = c.ai.think(STEP, views, c.ctx);
        if (c.ctx.locked) { st.speed = 0; continue; }
        c.car.update(STEP, inp, t);
        if (rel(i0, st.sampleIndex) < -2 || rel(i0, st.sampleIndex) > 6) c.faults++;
        if (time - c.hold > 0.05 && (rel(a0, c.ai.state.idx) < -2 || rel(a0, c.ai.state.idx) > 6)) c.faults++;
        if (Math.abs(st.y - t.surfaceY(st.sampleIndex, st.d)) > 1.5) c.faults++;
        AI.updateView(c.remote, { x: st.x, y: st.y, z: st.z, heading: st.heading, speed: st.speed }, t);
        if (Math.abs(rel(st.sampleIndex, c.remote.sampleIndex)) > 3) c.faults++;
        const r = rel(c.own, st.sampleIndex);
        if (r >= -60 && r <= 60 && !c.trace.has(r)) c.trace.set(r, st.speed);
        if (c.at < 0 && r >= 0 && r < 20) c.at = time;
      }
      hit(ent, STEP, () => { touches++; });
      if (cs.length === 2) minPlan = Math.min(minPlan, Math.hypot(cs[0].st.x - cs[1].st.x, cs[0].st.z - cs[1].st.z));
    }
    return { cs, touches, minPlan };
  }
  const aLo = run({ lo: {} }).cs[0], aUp = run({ up: {} }).cs[0];
  const lag = aLo.at - aUp.at, cfg = { lo: { hold: lag < 0 ? -lag - 0.25 : 0 }, up: { hold: lag > 0 ? lag - 0.25 : 0 } };
  const r = run(cfg), sLo = run({ lo: cfg.lo }).cs[0], sUp = run({ up: cfg.up }).cs[0];
  assert(r.minPlan < 3, 'the two cars did not meet at the crossing (closest ' + r.minPlan.toFixed(1) + ' m)');
  assert.strictEqual(r.touches, 0, 'contact across the bridge');
  for (const [c, s] of [[r.cs[0], sLo], [r.cs[1], sUp]]) {
    assert.strictEqual(c.faults, 0, c.w + ': jumped to the other road (index / height / remote view)');
    for (const [k, v] of c.trace) assert(Math.abs(v - s.trace.get(k)) < 0.01, c.w + ': slowed for the car on the other level');
  }
});

test('Suzuka bridge: views and R with the height (updateView, resetCar)', () => {
  const t = track('jp-1962'), S = t.samples, br = t.bridges[0];
  const lo = F1.createCar(F1.REF_SPEC, { tyres: false }), up = F1.createCar(F1.REF_SPEC, { tyres: false });
  lo.reset(t, br.lo); up.reset(t, br.up);
  assert(Math.abs(up.state.y - lo.state.y) > 5, 'heights ' + up.state.y + ' / ' + lo.state.y);
  // a remote view with no sample index yet (its first locate is global): the road of its height
  for (const [car, own] of [[lo, br.lo], [up, br.up]]) {
    const v = AI.createView(7); v.sampleIndex = -1;
    AI.updateView(v, { x: car.state.x, y: car.state.y, z: car.state.z, heading: car.state.heading, speed: 30 }, t);
    assert(Math.abs(v.sampleIndex - own) <= 3, 'located on ' + v.sampleIndex + ', its road is at ' + own);
    assert.strictEqual(v.y, car.state.y);
  }
  // R on the lower road right under a car standing on the bridge: the place is free (the other level is no obstacle)
  const vu = AI.createView(2); refresh(vu, up.state); vu.y = up.state.y; vu.speed = 0;
  const idx = AI.resetCar(lo, t, br.lo, [vu], 1);
  assert(Math.abs(idx - br.lo) <= 2, 'R moved on to ' + idx + ' (the car above is on the other road)');
  vu.y = NaN;                                    // (height unknown: as before, the car counts)
  assert(Math.abs(AI.resetCar(lo, t, br.lo, [vu], 1) - br.lo) > 2);
});

test('Monaco hairpin: the profile at the top of the full-lock range (~50 km/h), taken without touching a wall', () => {
  const t = track('mc-1929'), ln = line('mc-1929'), N = t.samples.length;
  const car0 = F1.createCar(F1.REF_SPEC, { tyres: false });
  const prof = AI.profile(AI.prepare(t, ln), car0.perf, 0.86 * AI.paceOf(1), 0.8 * Math.pow(AI.paceOf(1), 1.5));
  let hp = 0; for (let i = 0; i < N; i++) if (prof[i] < prof[hp]) hp = i;
  assert(prof[hp] * 3.6 > 40 && prof[hp] * 3.6 < 56, 'slowest profile point ' + (prof[hp] * 3.6).toFixed(1) + ' km/h');
  for (const skill of [0, 1]) {
    const d = driver('mc-1929', { ai: { skill, seed: 3 } }), ctx = context({ phase: 'race' });
    d.car.reset(t, (hp - 250 + N) % N); d.ai.reset();
    let vMin = 1e9, hits = 0, grass = 0, steerMax = 0;
    for (let k = 0; k < 120 * 20; k++) {
      const inp = d.ai.think(STEP, null, ctx); d.car.update(STEP, inp, t);
      const r = ((d.st.sampleIndex - hp) % N + N) % N;
      if (r < 25 || r > N - 25) { vMin = Math.min(vMin, d.st.speed); steerMax = Math.max(steerMax, Math.abs(d.st.steer)); if (d.st.hit > 0.02) hits++; if (d.st.onGrass) grass++; }
    }
    assert(vMin * 3.6 > (skill ? 40 : 35), 'skill ' + skill + ': ' + (vMin * 3.6).toFixed(1) + ' km/h at the hairpin');
    assert.strictEqual(hits, 0, 'skill ' + skill + ': wall'); assert.strictEqual(grass, 0, 'skill ' + skill + ': grass');
    assert(steerMax > 0.85, 'not at full lock (' + steerMax.toFixed(2) + ')');
  }
});

test('Monaco hairpin: a quicker car behind does not attack through it (no line to choose), no contact', () => {
  const t = track('mc-1929'), ln = line('mc-1929'), N = t.samples.length;
  const prof = AI.profile(AI.prepare(t, ln), F1.createCar(F1.REF_SPEC, { tyres: false }).perf, 0.86, 0.8);
  let hp = 0; for (let i = 0; i < N; i++) if (prof[i] < prof[hp]) hp = i;
  const r = pack('mc-1929', [{ kind: 'ai', skill: 0, at: hp - 120, v: 20, spec: F1.cars.get('2010-hrt') }, { kind: 'ai', skill: 1, at: hp - 132, v: 22, spec: F1.cars.get('2026-mercedes') }], 120 * 14, (k, c) => {
    if (c.view.id !== 2) return;
    const rr = ((c.st.sampleIndex - hp) % N + N) % N, near = rr <= 15 || rr >= N - 20;
    if (near && c.ai.state.mode === 'overtake') throw new Error('attacking in the hairpin at sample ' + c.st.sampleIndex);
  });
  assert.strictEqual(r.touches, 0, 'contact');
});

test('F1.AI.warmUp: every track, the real drivers drive exactly as without it (G.pitLoss from the first real driver)', () => {
  // two copies of the same track: one warmed up first, one not; the same drivers on both must drive identically
  const td = global.F1_TRACKS.find(x => x.id === 'gb-1948');
  const tA = F1.buildTrack(td), tB = F1.buildTrack(td), lA = F1.buildRaceLine(tA), lB = F1.buildRaceLine(tB);
  const w = AI.warmUp(tB, lB);
  assert(w && w.pitStops === 2 && w.calls > 10000, JSON.stringify(w));
  assert.deepStrictEqual(AI.warmUp(tB, lB), { steps: 0, calls: 0 }, 'a second call on the same track is free');
  function race(t, l) {
    const ds = [0, 1, 2].map(i => { const car = F1.createCar(F1.REF_SPEC, { random: AI.makeRandom(i + 1) }); return { car, st: car.state, ai: F1.createAIDriver({ track: t, raceLine: l, car, skill: [0.2, 0.6, 0.95][i], seed: 40 + i, id: i + 1, slot: i }) }; });
    ds.forEach((d, i) => { AI.placeOnGrid(d.car, t, i); d.ai.reset(); });
    const views = ds.map((d, i) => view(i + 1, d.st)), ctx = context({ phase: 'race', laps: 5, wear: 5 }), hit = AI.createContacts(), trace = [];
    const ent = ds.map(d => ({ state: d.st, car: d.car, solid: true }));
    for (let k = 0; k < 120 * 30; k++) {
      ds.forEach((d, i) => refresh(views[i], d.st));
      ds.forEach(d => { const inp = d.ai.think(STEP, views, ctx); d.car.update(STEP, inp, t); });
      hit(ent, STEP);
      if (k % 60 === 0) trace.push(ds.map(d => d.st.x.toFixed(6) + ',' + d.st.z.toFixed(6)).join(';'));
    }
    return trace.join('|');
  }
  assert.strictEqual(race(tB, lB), race(tA, lA), 'the warm-up changed how the drivers drive');
  assert.strictEqual(AI.prepare(tB, lB).pitLoss, AI.prepare(tA, lA).pitLoss, 'pit loss');
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall ai tests passed');
process.exit(failed ? 1 : 0);
