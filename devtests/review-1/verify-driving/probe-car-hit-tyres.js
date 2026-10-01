// Verify finding car-car-impacts-invisible-to-tyres: the main.js order (car.update, then F1.resolveCarCollisions,
// then car.state.hit = the frame's strongest hit) vs a wall impact of the same strength, over many seeds.
// node devtests/review-1/verify-driving/probe-car-hit-tyres.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/collide.js'));
const F1 = global.F1;
const STEP = 1 / 120;

function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// straight strip; walls at |d| = 12 (car origin limit 11)
function strip(len, walls) {
  const a = [], n = Math.round(len / 2);
  for (let i = 0; i < n; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, y: 0, bank: 0, wallPos: walls, wallNeg: walls, halfW: 7, wallPosDist: walls ? 12 : 60, wallNegDist: walls ? 12 : 60 });
  return { samples: a, halfWidth: 7, wallDist: walls ? 12 : 60, length: n * 2, locate(x, z) { return { index: Math.max(0, Math.min(a.length - 1, Math.round(z / 2))), d: x }; } };
}
const OPEN = strip(4000, false), WALLED = strip(4000, true);
const summary = (tyres) => ({ flat: Math.max(...tyres.state.flat), punct: tyres.state.puncture });

function carHit(seed, kmh) {
  const car = F1.createCar(undefined, { random: mulberry32(seed) });
  const st = car.state;
  car.reset(OPEN, 0); st.x = 0; st.z = 100; st.heading = 0; car.update(1e-4, null, OPEN);
  st.speed = kmh / 3.6;
  const others = [{ x: 0, z: 112, heading: 0, speed: 0 }];            // a car stopped 12 m ahead
  let maxHit = 0, seenByTyres = 0, frameHit = 0;
  for (let n = 0; n < 240; n++) {                                       // main.js order, one step per frame
    car.update(STEP, { up: true }, OPEN);
    if (st.hit > seenByTyres) seenByTyres = st.hit;                    // what car.update produced itself (walls)
    F1.resolveCarCollisions(st, others, STEP, []);
    frameHit = st.hit; if (frameHit > maxHit) maxHit = frameHit;
    st.hit = frameHit;                                                  // main.js: strongest hit of the frame
  }
  return Object.assign({ hit: maxHit, carUpdateHit: seenByTyres }, summary(car.tyres));
}
function wallHit(seed, v, deg) {
  const car = F1.createCar(undefined, { random: mulberry32(seed) });
  const st = car.state;
  car.reset(WALLED, 0); st.x = 5; st.z = 100; st.heading = deg * Math.PI / 180; car.update(1e-4, null, WALLED);
  st.speed = v;
  let maxHit = 0;
  for (let n = 0; n < 240; n++) { car.update(STEP, { up: true }, WALLED); if (st.hit > maxHit) maxHit = st.hit; }
  return Object.assign({ hit: maxHit }, summary(car.tyres));
}
const SEEDS = 200;
let c = { n: 0, flat: 0, punct: 0, hit: 0 }, w = { n: 0, flat: 0, punct: 0, hit: 0 };
for (let s = 1; s <= SEEDS; s++) {
  const a = carHit(s, 100); c.n++; c.hit = Math.max(c.hit, a.hit); if (a.flat > 0) c.flat++; if (a.punct >= 0) c.punct++;
  if (s === 1) console.log('car-to-car sample:', JSON.stringify(a));
  const b = wallHit(s, 40, 45); w.n++; w.hit = Math.max(w.hit, b.hit); if (b.flat > 0) w.flat++; if (b.punct >= 0) w.punct++;
  if (s === 1) console.log('wall sample      :', JSON.stringify(b));
}
console.log('car-to-car, 100 km/h into a stopped car:', SEEDS, 'runs, max hit', c.hit.toFixed(3), ' tyres flat-spotted', c.flat, ' punctured', c.punct);
console.log('wall, 40 m/s at 45 deg               :', SEEDS, 'runs, max hit', w.hit.toFixed(3), ' tyres flat-spotted', w.flat, ' punctured', w.punct);
