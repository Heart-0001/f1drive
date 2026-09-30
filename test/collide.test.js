// node test/collide.test.js — unit tests for js/collide.js (pure math).
'use strict';
const assert = require('assert');
const resolve = require('../js/collide.js');

const DT = 1 / 120;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}
function car(x, z, heading, speed, y) { return { x, z, heading, speed, y: y || 0, hit: 0 }; }
function fin(s) { return [s.x, s.z, s.heading, s.speed].every(Number.isFinite); }
function step(s) { s.x += Math.sin(s.heading) * s.speed * DT; s.z += Math.cos(s.heading) * s.speed * DT; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

// Both clients run: each moves its own car, then resolves it against a copy of the other one.
// resolveB = false models a player sitting in the menu (their car is frozen, nobody resolves it).
function run(a, b, steps, resolveB, watch) {
  const r = { maxHitA: 0, maxHitB: 0, maxJump: 0, maxPen: 0, contacts: 0 };
  for (let i = 0; i < steps; i++) {
    step(a); if (resolveB !== false) step(b);
    const a0 = Object.assign({}, a), b0 = Object.assign({}, b);
    const pen = resolve.overlap(a0, b0);
    a.hit = 0; b.hit = 0;
    const ha = resolve(a, [b0], DT);
    const hb = resolveB !== false ? resolve(b, [a0], DT) : 0;
    assert(fin(a) && fin(b), 'NaN / Infinity in state at step ' + i);
    if (ha > 0 || hb > 0 || pen > 0) r.contacts++;
    r.maxHitA = Math.max(r.maxHitA, ha); r.maxHitB = Math.max(r.maxHitB, hb);
    // never moved further than the penetration (plus, for a swept contact, its own travel this step)
    const ja = dist(a, a0), jb = dist(b, b0);
    const limA = pen > 0 ? pen : Math.abs(a0.speed) * DT + 1.9, limB = pen > 0 ? pen : Math.abs(b0.speed) * DT + 1.9;
    assert(ja <= limA + 1e-9, 'A moved ' + ja.toFixed(3) + ' m for a penetration of ' + pen.toFixed(3));
    assert(jb <= limB + 1e-9, 'B moved ' + jb.toFixed(3) + ' m for a penetration of ' + pen.toFixed(3));
    r.maxJump = Math.max(r.maxJump, ja, jb);
    r.maxPen = Math.max(r.maxPen, pen);
    if (watch) watch(a, b, i);
  }
  r.finalPen = resolve.overlap(a, b);
  return r;
}

test('no contact: nothing changes', () => {
  const a = car(0, 0, 0, 30), b = car(3, 0, 0, 30);
  const before = JSON.stringify(a);
  assert.strictEqual(resolve(a, [b], DT), 0);
  assert.strictEqual(JSON.stringify(a), before);
  assert.strictEqual(resolve(a, [], DT), 0);
  assert.strictEqual(resolve(a, null, DT), 0);
});

test('head-on 50 vs 50 m/s: both stop/bounce, no pass-through, separated', () => {
  const a = car(0, -30, 0, 50), b = car(0, 30, Math.PI, 50);
  const r = run(a, b, 240, true, (p, q) => assert(p.z < q.z, 'cars passed through each other'));
  assert(r.maxHitA > 0.9 && r.maxHitB > 0.9, 'hit should be strong: ' + r.maxHitA);
  assert(a.speed <= 0 && b.speed <= 0, 'both should have bounced back: ' + a.speed + ', ' + b.speed);
  assert(r.finalPen === 0, 'still overlapping by ' + r.finalPen);
});

test('rear-end: car behind loses speed, car ahead gains speed', () => {
  const a = car(0, -12, 0, 60), b = car(0, 0, 0, 40);
  const r = run(a, b, 240, true, (p, q) => assert(p.z < q.z, 'passed through'));
  assert(r.contacts > 0, 'never touched');
  assert(a.speed < 60 && a.speed > 35, 'A speed ' + a.speed);
  assert(b.speed > 40 && b.speed < 62, 'B speed ' + b.speed);
  assert(b.speed >= a.speed - 1e-6, 'B should now be at least as fast as A');
  assert(Math.abs(a.heading) < 1e-9 && Math.abs(b.heading) < 1e-9, 'straight hit must not turn the cars');
  assert(r.finalPen === 0);
});

test('side swipe: small speed loss, heading nudged away, lateral separation kept', () => {
  // A drifts left into B at a shallow angle; both ~70 m/s, side by side. +X is the driver's left.
  const a = car(0, 0, 0.06, 70), b = car(2.6, 0, 0, 70);
  const r = run(a, b, 120, true, (p, q) => assert(p.x < q.x, 'A went through B sideways'));
  assert(r.contacts > 0, 'never touched');
  assert(a.heading < 0.06, 'A should be turned away from B: ' + a.heading);
  assert(a.speed > 60 && a.speed <= 70, 'A speed after a swipe: ' + a.speed);
  assert(b.speed > 60 && b.speed <= 72, 'B speed after a swipe: ' + b.speed);
  assert(r.maxHitA < 0.5, 'a swipe is not a big hit: ' + r.maxHitA);
  assert(r.finalPen < 0.05, 'still overlapping by ' + r.finalPen);
});

test('T-bone: A drives into the side of a crossing car', () => {
  const a = car(0, -20, 0, 40), b = car(-10, 0, Math.PI / 2, 20);   // B travels +X across A's path
  const r = run(a, b, 240, true);
  assert(r.contacts > 0, 'never touched');
  assert(a.speed < 40, 'A must lose speed: ' + a.speed);
  assert(r.maxHitA > 0.5, 'hit ' + r.maxHitA);
  assert(r.finalPen === 0, 'still overlapping by ' + r.finalPen);
});

test('diagonal contact at 45 degrees', () => {
  const a = car(-15, -15, Math.PI / 4, 45), b = car(15, -15, -Math.PI / 4, 45);
  const r = run(a, b, 240, true);
  assert(r.contacts > 0, 'never touched');
  assert(a.speed < 45 && b.speed < 45, 'both lose speed');
  assert(r.finalPen === 0, 'still overlapping by ' + r.finalPen);
});

test('stationary other car (player in the menu): local car takes the whole correction and stops', () => {
  const a = car(0, -40, 0, 80), b = car(0, 0, 0, 0);
  const r = run(a, b, 240, false, (p, q) => assert(p.z < q.z - 4, 'A is inside / past the parked car: ' + p.z));
  assert(r.maxHitA === 1, 'hit ' + r.maxHitA);
  assert(a.speed <= 0.01, 'A should be stopped or bouncing back: ' + a.speed);
  assert(b.x === 0 && b.z === 0 && b.speed === 0, 'parked car must not be modified');
  assert(r.finalPen === 0, 'still overlapping by ' + r.finalPen);
});

test('stationary other car, both resolvers running: parked car is pushed forward', () => {
  const a = car(0, -40, 0, 50), b = car(0, 0, 0, 0);
  const r = run(a, b, 240, true, (p, q) => assert(p.z < q.z, 'passed through'));
  assert(b.speed > 5, 'B should have been shunted: ' + b.speed);
  assert(a.speed < 50, 'A should have slowed: ' + a.speed);
  assert(r.finalPen === 0);
});

test('no tunnelling at 100 m/s closing speed (every offset of the first contact)', () => {
  for (let k = 0; k < 40; k++) {
    const gap = 20 + k * 0.021;                         // shift the phase of the first overlap
    const a = car(0, -gap, 0, 100), b = car(0, 0, 0, 0);
    run(a, b, 120, false, (p, q) => assert(p.z < q.z - 4, 'tunnelled (gap ' + gap + '): ' + p.z));
    const c = car(0, -gap, 0, 50), d = car(0.4, gap, Math.PI, 50);
    run(c, d, 120, true, (p, q) => assert(p.z < q.z, 'tunnelled head-on (gap ' + gap + ')'));
  }
});

test('no tunnelling across the narrow side at 100 m/s (sweep)', () => {
  for (let k = 0; k < 40; k++) {
    const a = car(-20 - k * 0.021, 0, Math.PI / 2, 100), b = car(0, 0, Math.PI / 2, 0);   // nose to tail, along X
    run(a, b, 120, false, (p, q) => assert(p.x < q.x - 4, 'tunnelled: ' + p.x));
    // crossing a parked car's 1.9 m width at 125 m/s
    const c = car(-20 - k * 0.021, 0, Math.PI / 2, 125), d = car(0, 0, 0, 0);
    run(c, d, 120, false, (p, q) => assert(p.x < q.x, 'tunnelled across: ' + p.x));
  }
});

test('height difference > 1.5 m: no collision (bridge / crossover)', () => {
  const a = car(0, 0, 0, 30, 0), b = car(0, 1, 0, 0, 6);
  const before = JSON.stringify(a);
  assert.strictEqual(resolve(a, [b], DT), 0);
  assert.strictEqual(JSON.stringify(a), before);
  b.y = 1.0;
  assert(resolve.overlap(a, b) > 0);
  resolve(a, [b], DT);
  assert.notStrictEqual(JSON.stringify(a), before);
});

test('garbage input never produces NaN and never throws', () => {
  const bad = [NaN, Infinity, -Infinity, undefined, null, 'x', {}, 1e308];
  for (const v of bad) {
    for (const key of ['x', 'z', 'heading', 'speed', 'y']) {
      const a = car(0, 0, 0, 30), b = car(0, 3, 0, 10);
      b[key] = v;
      resolve(a, [b, null, undefined, {}, 5], DT);
      assert(fin(a), 'other.' + key + ' = ' + v + ' broke the local car: ' + JSON.stringify(a));
      const c = car(0, 0, 0, 30), d = car(0, 3, 0, 10);
      c[key] = v;
      const snapshot = [c.x, c.z, c.heading];
      resolve(c, [d], DT);
      if (key === 'speed') assert(fin(c), 'bad local speed must be repaired');
      else if (v === 1e308) assert(fin(c), 'huge but finite local ' + key);
      else if (key !== 'y') assert.deepStrictEqual([c.x, c.z, c.heading], snapshot, 'bad local state must be left alone');
    }
  }
  for (const dt of [NaN, -1, 0, Infinity, undefined, 1e9]) {
    const a = car(0, 0, 0, 30), b = car(0, 3, 0, 10);
    resolve(a, [b], dt);
    assert(fin(a), 'dt = ' + dt);
  }
  // identical position and heading (degenerate normal)
  const a = car(5, 5, 1, 0), b = car(5, 5, 1, 0);
  resolve(a, [b], DT);
  assert(fin(a));
});

test('random soak: 3000 encounters, always finite, bounded correction, end separated', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let n = 0; n < 3000; n++) {
    const ang = rnd() * Math.PI * 2, r0 = 12 + rnd() * 10;
    const a = car(0, 0, rnd() * Math.PI * 2, rnd() * 100 - 10);
    // B starts on a circle around A, aimed roughly at it
    const b = car(Math.sin(ang) * r0, Math.cos(ang) * r0, ang + Math.PI + (rnd() - 0.5) * 0.8, rnd() * 100);
    const both = rnd() < 0.7;
    if (!both) b.speed = 0;
    run(a, b, 90, both);
  }
});

test('reported impulse (applyCarImpulse): shunt from behind, from the side, garbage', () => {
  const a = car(0, 0, 0, 0);
  assert(resolve.applyImpulse(a, 0, 12) > 0);
  assert(Math.abs(a.speed - 12) < 1e-9 && a.heading === 0 && a.x === 0 && a.z === 0, JSON.stringify(a));
  const b = car(0, 0, 0, 50);
  resolve.applyImpulse(b, 6, 0);                       // pushed towards the driver's left
  assert(b.speed < 50 && b.speed > 48 && b.heading > 0 && b.heading <= 0.05, JSON.stringify(b));
  const contacts = [];
  const p = car(0, -5, 0, 20), q = car(0, 0, 0, 0);
  resolve(p, [q], DT, contacts);
  assert(contacts.length === 1 && contacts[0].i === 0 && contacts[0].iz < 0 && Math.abs(contacts[0].iz + 12) < 1e-6, JSON.stringify(contacts));
  for (const v of [NaN, Infinity, undefined, null, 'x']) {
    const g = car(1, 2, 0.5, 10);
    assert.strictEqual(resolve.applyImpulse(g, v, 1), 0);
    assert.strictEqual(resolve.applyImpulse(g, 1, v), 0);
    assert(g.speed === 10 && g.heading === 0.5);
  }
  assert.strictEqual(resolve.applyImpulse(null, 1, 1), 0);
});

test('three cars: local car between two others stays finite', () => {
  const a = car(0, 0, 0, 20), b = car(0, 4, 0, 0), c = car(0, -4, 0, 40);
  for (let i = 0; i < 240; i++) { step(a); resolve(a, [b, c], DT); assert(fin(a)); }
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall collide tests passed');
process.exit(failed ? 1 : 0);
