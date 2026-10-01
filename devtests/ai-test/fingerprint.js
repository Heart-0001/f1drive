// node devtests/ai-test/fingerprint.js [only=a,b,...] [AI_JS=<path>]
// A bit-exact fingerprint of the computer drivers' behaviour: a set of races and stress scenarios with the REAL modules
// (sim.js: quali + race with pit stops and tyre wear; critic-sim.js: a parked car, a car coming the wrong way, erratic
// "humans"), hashing every car's x / z / heading / speed (the IEEE bits) after EVERY physics step, plus the
// classification. Two versions of js/ai.js that drive identically print identical lines: run it before and after a
// refactor (AI_JS=<copy of the old file> for the old one) and diff. warm=1: F1.AI.warmUp on every track first (must print
// the same lines: the warm-up changes nothing in how the real drivers drive). ~30 s.
'use strict';
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const { createRace } = require('./sim');
const { createScenario, F1, L } = require('./critic-sim');

// FNV-1a over the 32-bit halves of doubles
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
function hasher() {
  let h = 0x811c9dc5 >>> 0;
  return {
    num(v) { f64[0] = v; for (let k = 0; k < 2; k++) { h ^= u32[k]; h = Math.imul(h, 0x01000193) >>> 0; } },
    str(s) { for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; } },
    get hex() { return ('00000000' + h.toString(16)).slice(-8); }
  };
}
function hashCars(H, cars) {
  for (const c of cars) { const s = c.car.state; H.num(s.x); H.num(s.z); H.num(s.heading); H.num(s.speed); }
}

const only = arg('only', '').split(',').filter(Boolean), warm = arg('warm', '0') === '1';
function warmTrack(name) { if (!warm) return; const t = L.track(L.IDS[name] || name); F1.AI.warmUp(t, L.line(t, null)); }
const want = name => !only.length || only.includes(name);
const cars26 = F1.cars.list(2026).filter(c => !/standard/.test(c.id));
function field(n, k0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ skill: [0, 0.35, 0.7, 1][(i + k0) % 4], car: cars26[(i + k0) % cars26.length].id, name: 'c' + i });
  return out;
}

const races = [
  { name: 'suzuka15', track: 'suzuka', cars: field(15, 0), laps: 4, quali: 1, wear: 3, seed: 3, grid: 'quali' },
  { name: 'monaco12', track: 'monaco', cars: field(12, 1), laps: 3, quali: 0, wear: 4, seed: 5, grid: 'random' },
  { name: 'monza8', track: 'monza', cars: field(8, 2), laps: 5, quali: 0, wear: 5, seed: 7, grid: 'reverse' },
  { name: 'spa10', track: 'spa', cars: field(10, 3), laps: 3, quali: 1, wear: 2, seed: 9, grid: 'quali' }
];
const t0 = Date.now();
for (const r of races) {
  if (!want(r.name)) continue;
  warmTrack(r.track);
  const sim = createRace(r), H = hasher();
  const maxS = r.quali * 140 + r.laps * 150 + 200;
  while (sim.time < maxS && sim.session.phase !== 'results') { sim.step(); hashCars(H, sim.cars); }
  const sum = sim.cars.map(c => c.ai.stats);
  const sp = sim.session.snapshot();
  H.str(JSON.stringify(sp.order)); H.str(JSON.stringify(sum));
  console.log(r.name.padEnd(12) + ' ' + H.hex + '  t ' + sim.time.toFixed(3) + '  order ' + sp.order.join(',') +
    '  passes ' + sum.reduce((a, s) => a + s.passes, 0) + ' stops ' + sum.reduce((a, s) => a + s.pitStops, 0) +
    ' R ' + sum.reduce((a, s) => a + s.resets, 0) + ' mistakes ' + sum.reduce((a, s) => a + s.mistakes, 0));
}

const scen = [
  { name: 'parked', track: 'spa', laps: 2, seed: 4, cars: [{ kind: 'parked', at: 900 }].concat(field(6, 0).map((c, i) => Object.assign({ kind: 'ai', at: 700 - i * 30, v: 40 }, c))) },
  { name: 'wrongway', track: 'monza', laps: 2, seed: 6, cars: [{ kind: 'wrong', at: 2300, v: 15 }].concat(field(5, 1).map((c, i) => Object.assign({ kind: 'ai', at: 1900 - i * 30, v: 50 }, c))) },
  { name: 'erratic', track: 'hungaroring', laps: 3, seed: 8, start: 'grid', cars: [{ kind: 'erratic', skill: 0.5, name: 'H1' }, { kind: 'human', skill: 0.6, name: 'H2' }].concat(field(6, 2).map(c => Object.assign({ kind: 'ai' }, c))) }
];
for (const s of scen) {
  if (!want(s.name)) continue;
  warmTrack(s.track);
  const sc = createScenario(s), H = hasher();
  const maxS = s.laps * 200 + 60;
  while (sc.time < maxS && !sc.cars.every(c => c.kind !== 'ai' || c.fin)) { sc.step(); hashCars(H, sc.cars); }
  const st = sc.cars.filter(c => c.ai).map(c => c.ai.stats);
  H.str(JSON.stringify(st));
  console.log(s.name.padEnd(12) + ' ' + H.hex + '  t ' + sc.time.toFixed(3) + '  R ' + st.reduce((a, x) => a + x.resets, 0) + ' passes ' + st.reduce((a, x) => a + x.passes, 0));
}
console.error('(' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
