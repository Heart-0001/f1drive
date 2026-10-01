// car.js analog input tests + bit-for-bit regression of boolean input against the pre-change car.js
const assert = require('assert');
const vm = require('vm'), fs = require('fs');
let T = 0; const ok = (n, f) => { f(); T++; console.log('ok  ' + n); };
function loadCar(file) { const g = { Math, Infinity, NaN }; g.globalThis = g; vm.runInNewContext(fs.readFileSync(file, 'utf8'), g); return g.F1; }
const NEW = loadCar(require('path').resolve(__dirname, '..', '..') + '/js/car.js');
// car.orig.js = js/car.js from before analog input was added (baseline of the bit-for-bit regression). It is not in
// the repo; without it the baseline is the v5 car (devtests/car-v6/car-v5.js, with analog input: boolean input
// behaves as before it), which v6's js/car.js must still match exactly (the golden rule).
const ORIG = fs.existsSync(__dirname + '/car.orig.js') ? __dirname + '/car.orig.js' : require('path').resolve(__dirname, '..', 'car-v6', 'car-v5.js');
const HAVE_OLD = fs.existsSync(ORIG);
const OLD = HAVE_OLD ? loadCar(ORIG) : null;
const okOld = (n, f) => HAVE_OLD ? ok(n, f) : console.log('SKIP ' + n + ' (no baseline car.js)');
const DT = 1 / 120;

// flat, wide, straight strip (no walls) and a real-ish oval with walls, elevation and banking
function strip() {
  const a = []; for (let i = 0; i < 6000; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, y: 0, bank: 0, wallPos: false, wallNeg: false, halfW: 1e6 });
  return { samples: a, halfWidth: 1e6, wallDist: 1e6, locate(x, z) { return { index: Math.max(0, Math.min(a.length - 1, Math.round(z / 2))), d: x }; } };
}
function oval() {
  const R = 60, n = Math.round(2 * Math.PI * R / 2), a = [];
  for (let i = 0; i < n; i++) { const h = i / n * 2 * Math.PI, tx = Math.sin(h), tz = Math.cos(h), nx = Math.cos(h), nz = -Math.sin(h);
    a.push({ x: -nx * R, z: -nz * R, tx, tz, nx, nz, s: i * 2, y: 4 * Math.sin(2 * h), bank: -0.05 + 0.04 * Math.sin(3 * h), grade: 0, wallPos: true, wallNeg: true, halfW: 7, wallPosDist: 12, wallNegDist: 12 }); }
  return { samples: a, halfWidth: 7, wallDist: 12, locate(x, z) { let b = 0, bd = 1e18; for (let i = 0; i < n; i++) { const d = (x - a[i].x) ** 2 + (z - a[i].z) ** 2; if (d < bd) { bd = d; b = i; } } return { index: b, d: (x - a[b].x) * a[b].nx + (z - a[b].z) * a[b].nz }; } };
}
function run(F1, track, steps, inputFn, each) {
  const car = F1.createCar(); car.reset(track, 0);
  for (let i = 0; i < steps; i++) { car.update(DT, inputFn(i, car.state), track); if (each) each(i, car.state); }
  return car.state;
}

okOld('F1.CAR_PERF unchanged', () => {
  for (const k of Object.keys(OLD.CAR_PERF)) {
    if (typeof OLD.CAR_PERF[k] === 'function') for (const v of [0, 20, 50, 90]) for (const b of [-0.1, 0, 0.1])
      assert.strictEqual(NEW.CAR_PERF[k](v, b, 0.03, 0.001, 1), OLD.CAR_PERF[k](v, b, 0.03, 0.001, 1), k);
    else assert.strictEqual(NEW.CAR_PERF[k], OLD.CAR_PERF[k], k);
  }
  // v6 adds fields (gearFor, rpmFor, ...) after the old ones
  assert.deepStrictEqual(Object.keys(NEW.CAR_PERF).slice(0, Object.keys(OLD.CAR_PERF).length), Object.keys(OLD.CAR_PERF));
});

// pseudo-random boolean key sequences (incl. both keys at once, reversing, walls, grass)
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function keyScript(seed) {
  const r = lcg(seed); let cur = { up: false, down: false, left: false, right: false }, left = 0;
  return () => { if (left-- <= 0) { left = 5 + Math.floor(r() * 140); const u = r(), s = r();
      cur = { up: u < 0.62 || u > 0.95, down: u > 0.80, left: s < 0.35 || s > 0.97, right: s > 0.62 };
      if (r() < 0.12) { left = 500 + Math.floor(r() * 500); cur.up = false; cur.down = true; } } return cur; };
}
okOld('boolean input: trajectories bit-for-bit identical to the old car.js (strip + walled banked oval, 12 x 60 s)', () => {
  let cmp = 0;
  for (const mk of [strip, oval]) for (let seed = 1; seed <= 6; seed++) {
    const tr = mk(), a = OLD.createCar(), b = NEW.createCar(); a.reset(tr, 0); b.reset(tr, 0);
    const ka = keyScript(seed), kb = keyScript(seed);
    let hits = 0, grass = 0, rev = 0;
    for (let i = 0; i < 7200; i++) {
      const dt = i % 97 === 0 ? 0.031 : DT;          // odd frame times too
      a.update(dt, ka(), tr);
      const k = kb();
      // new car gets the same booleans, in turn: plain / with null analog fields / with undefined / with NaN
      const m = i % 4, inp = m === 0 ? k : { up: k.up, down: k.down, left: k.left, right: k.right,
        throttle: m === 1 ? null : (m === 2 ? undefined : NaN), brake: m === 1 ? null : undefined, steerAxis: m === 1 ? null : (m === 2 ? undefined : NaN) };
      b.update(dt, inp, tr);
      for (const f of Object.keys(a.state)) { if (!Object.is(a.state[f], b.state[f])) assert.fail(`${mk.name} seed ${seed} step ${i} ${f}: ${a.state[f]} vs ${b.state[f]}`); cmp++; }
      if (a.state.hit > 0) hits++; if (a.state.onGrass) grass++; if (a.state.speed < -0.5) rev++;
    }
    if (mk === oval) assert(hits > 0 && grass > 0, 'oval run should exercise walls and grass');
    assert(rev > 0, 'run should exercise reversing');
  }
  console.log('      ' + cmp + ' state values compared');
});
ok('analog equal to the keys (throttle 1 / brake 1) is identical to the keys', () => {
  const tr = strip(), a = NEW.createCar(), b = NEW.createCar(); a.reset(tr, 0); b.reset(tr, 0);
  for (let i = 0; i < 3000; i++) {
    const acc = i < 1800;
    a.update(DT, { up: acc, down: !acc }, tr); b.update(DT, { throttle: acc ? 1 : 0, brake: acc ? 0 : 1 }, tr);
    assert(Object.is(a.state.speed, b.state.speed) && Object.is(a.state.z, b.state.z), 'step ' + i);
  }
  assert(a.state.speed < -1, 'brake trigger held at a stop reverses, like S');
});
ok('flat-track performance numbers: 330 km/h, 0-100 in 2.73 s, 4.38 g peak braking (keys and full triggers)', () => {
  for (const full of [{ up: true }, { throttle: 1 }]) {
    const tr = strip(); let t100 = null;
    const st = run(NEW, tr, 120 * 80, () => full, (i, s) => { if (t100 === null && s.speed * 3.6 >= 100) t100 = (i + 1) * DT; });
    assert(Math.abs(st.speed * 3.6 - 330) < 0.5, 'top ' + st.speed * 3.6); assert(Math.abs(t100 - 2.73) < 0.02, '0-100 ' + t100);
  }
  for (const full of [{ down: true }, { brake: 1 }]) {
    const tr = strip(), car = NEW.createCar(); car.reset(tr, 0); car.state.speed = 300 / 3.6;
    const old = HAVE_OLD ? OLD.createCar() : null; if (old) { old.reset(tr, 0); old.state.speed = 300 / 3.6; old.update(DT, { down: true }, tr); }
    const v0 = 300 / 3.6; car.update(DT, full, tr); if (old) assert.strictEqual(car.state.speed, old.state.speed);
    const g = (v0 - car.state.speed) / DT / 9.81; assert(Math.abs(g - 4.38) < 0.03, 'peak g from 300 km/h ' + g);
  }
});
ok('half throttle accelerates less and tops out lower; monotonic in throttle', () => {
  const v = t => run(NEW, strip(), 360, () => ({ throttle: t })).speed;
  const v25 = v(0.25), v50 = v(0.5), v75 = v(0.75), v100 = v(1);
  assert(v25 > 1 && v25 < v50 && v50 < v75 && v75 < v100, [v25, v50, v75, v100].join(' '));
  assert(Math.abs(v50 / v100 - 0.5) < 0.12, 'half throttle ~ half the speed after 3 s: ' + v50 / v100);
  const top50 = run(NEW, strip(), 120 * 90, () => ({ throttle: 0.5 })).speed * 3.6;
  assert(top50 > 200 && top50 < 300, 'half-throttle top speed ' + top50);
  assert.strictEqual(run(NEW, strip(), 600, () => ({ throttle: 0 })).speed, 0);
  assert.strictEqual(v(7), v100, 'out-of-range throttle is clamped');
});
function brakeDist(b) {
  const tr = strip(), car = NEW.createCar(); car.reset(tr, 0); car.state.speed = 60; const z0 = car.state.z;
  let n = 0; while (car.state.speed > 1 && n++ < 5000) car.update(DT, { brake: b }, tr);
  return car.state.z - z0;
}
ok('half brake stops in a longer distance; monotonic', () => {
  const d25 = brakeDist(0.25), d50 = brakeDist(0.5), d100 = brakeDist(1);
  assert(d100 < d50 && d50 < d25, [d25, d50, d100].join(' ')); assert(d50 > 1.5 * d100, 'half brake clearly weaker: ' + d50 + ' vs ' + d100);
});
ok('brake overrides throttle in proportion; full brake + full throttle = braking only', () => {
  const dec = inp => { const tr = strip(), car = NEW.createCar(); car.reset(tr, 0); car.state.speed = 50; car.update(DT, inp, tr); return (50 - car.state.speed) / DT; };
  assert.strictEqual(dec({ throttle: 1, brake: 1 }), dec({ brake: 1 })); assert.strictEqual(dec({ up: true, down: true }), dec({ down: true }));
  assert(dec({ throttle: 1, brake: 0.3 }) < dec({ brake: 0.3 }));
});
ok('key + analog on the same axis: larger magnitude wins', () => {
  const v = inp => run(NEW, strip(), 240, () => inp).speed;
  assert.strictEqual(v({ up: true, throttle: 0.3 }), v({ up: true })); assert.strictEqual(v({ up: false, throttle: 0.3 }), v({ throttle: 0.3 }));
  const s = inp => run(NEW, strip(), 240, () => inp).steer;
  assert.strictEqual(s({ left: true, steerAxis: 0.4 }), 1); assert.strictEqual(s({ right: true, steerAxis: 0.4 }), -1);
  assert.strictEqual(s({ steerAxis: 0.4 }), 0.4); assert.strictEqual(s({ steerAxis: -5 }), -1);
});
ok('analog steer is a TARGET: half stick holds half lock, wider radius than full; + = left', () => {
  function radius(axis) {       // steady-state turn radius at ~10 m/s (below the grip limit)
    const tr = strip(), car = NEW.createCar(); car.reset(tr, 0); car.state.speed = 10; car.state.x = 0;
    let h0 = 0, z = 0;
    for (let i = 0; i < 240; i++) { car.state.speed = 10; car.update(DT, { steerAxis: axis }, tr); if (i === 119) h0 = car.state.heading; }
    assert.strictEqual(car.state.steer, axis); return 10 / ((car.state.heading - h0) / 1);
  }
  const rHalf = radius(0.5), rFull = radius(1), rNeg = radius(-0.5);
  assert(rFull > 0 && rHalf > 1.8 * rFull, `half ${rHalf} full ${rFull}`); assert(Math.abs(rNeg + rHalf) < 1e-6, 'symmetric, negative = right');
});
ok('analog steer follows quickly but not instantly; keyboard rate unchanged; release re-centres', () => {
  const tr = strip(), car = NEW.createCar(); car.reset(tr, 0);
  car.update(DT, { steerAxis: 1 }, tr); assert(car.state.steer > 0 && car.state.steer < 0.2, 'not instant: ' + car.state.steer);
  let n = 1; while (car.state.steer < 1 && n < 500) { car.update(DT, { steerAxis: 1 }, tr); n++; }
  assert(n * DT > 0.05 && n * DT < 0.15, 'stick reaches lock in ' + n * DT + ' s');
  const k = NEW.createCar(); k.reset(tr, 0); let m = 0; while (k.state.steer < 1 && m < 500) { k.update(DT, { left: true }, tr); m++; }
  assert(m * DT > 0.18 && m > 2 * n, 'keys stay slower: ' + m * DT + ' s');
  // release (mergeInput passes null at rest): back to 0 at the stick rate
  n = 0; while (car.state.steer !== 0 && n < 500) { car.update(DT, { steerAxis: null }, tr); n++; } assert(n * DT < 0.12, 'centres in ' + n * DT);
  // after using a key the keyboard rates apply again
  for (let i = 0; i < 200; i++) car.update(DT, { left: true }, tr);
  n = 0; while (car.state.steer !== 0 && n < 500) { car.update(DT, {}, tr); n++; }
  m = 0; while (k.state.steer !== 0 && m < 500) { k.update(DT, {}, tr); m++; } assert.strictEqual(n, m);
});
ok('speed-sensitive lock and grip cap still apply to the stick (no spin / NaN at 300 km/h full stick)', () => {
  const tr = strip(), car = NEW.createCar(); car.reset(tr, 0); car.state.speed = 300 / 3.6; let maxLat = 0, h = 0;
  for (let i = 0; i < 240; i++) { h = car.state.heading; const v = car.state.speed; car.update(DT, { steerAxis: 1, throttle: 1 }, tr); maxLat = Math.max(maxLat, v * (car.state.heading - h) / DT); }
  assert(isFinite(car.state.x) && isFinite(car.state.speed)); assert(maxLat > 5 && maxLat <= 44.01, 'lat accel ' + maxLat);
});
ok('reverse-when-stopped with the brake trigger; throttle brakes while reversing; hill-hold with no input', () => {
  const tr = strip(), car = NEW.createCar(); car.reset(tr, 10);
  for (let i = 0; i < 360; i++) car.update(DT, { brake: 0.6 }, tr); const vr = car.state.speed; assert(vr < -2 && vr >= -40 / 3.6 - 1e-9, 'reversing ' + vr);
  const full = NEW.createCar(); full.reset(tr, 10); for (let i = 0; i < 120; i++) full.update(DT, { brake: 1 }, tr);
  const half = NEW.createCar(); half.reset(tr, 10); for (let i = 0; i < 120; i++) half.update(DT, { brake: 0.5 }, tr); assert(half.state.speed > full.state.speed, 'half trigger reverses more gently');
  car.update(DT, { throttle: 1 }, tr); assert(car.state.speed > vr, 'throttle slows the reversing car');
  for (let i = 0; i < 120 * 60; i++) car.update(DT, { throttle: null, brake: null, steerAxis: null }, tr); assert.strictEqual(car.state.speed, 0);
  car.update(1e-4, null, tr); assert.strictEqual(car.state.speed, 0);
});
console.log('car: ' + T + ' tests passed');
