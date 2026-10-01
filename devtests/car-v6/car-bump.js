// node devtests/car-v6/car-bump.js [seeds = 200]
//
// Review finding car-car-impacts-invisible-to-tyres (devtests/review-1/verify-driving/probe-car-hit-tyres.js): the
// impacts of F1.resolveCarCollisions are set on car.state.hit AFTER car.update, and the next car.update cleared them
// before js/tyres.js saw them. car.bump(strength) hands them to the next update. This follows the main.js order
// (car.update, F1.resolveCarCollisions, car.bump with its return value, car.state.hit = the frame's strongest hit):
//   car-to-car   a car at 100 km/h into a stopped car, with car.bump            -> flat spots / punctures as a wall
//   without bump the same, the old main.js (no car.bump)                       -> none (the finding)
//   wall         40 m/s at 45 deg into a wall (car.js's own impact)             -> the reference
//   path         the same car-to-car run without tyres, with and without car.bump: bit-identical x / z / speed / heading
// Exit code 1 when car-to-car with car.bump damages no tyre, or the path differs.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/collide.js'));
const F1 = global.F1;
const STEP = 1 / 120, SEEDS = +process.argv[2] || 200;

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
const summary = tyres => tyres ? { flat: Math.max(...tyres.state.flat), punct: tyres.state.puncture } : {};

function carHit(seed, kmh, useBump, opts) {
  const car = F1.createCar(undefined, opts || { random: mulberry32(seed) });
  const st = car.state;
  car.reset(OPEN, 0); st.x = 0; st.z = 100; st.heading = 0; car.update(1e-4, null, OPEN);
  st.speed = kmh / 3.6;
  const others = [{ x: 0, z: 112, heading: 0, speed: 0 }];            // a car stopped 12 m ahead
  let maxHit = 0, updHit = 0;
  const traj = [];
  for (let n = 0; n < 240; n++) {                                       // main.js order, one step per frame
    car.update(STEP, { up: true }, OPEN);
    if (st.hit > updHit) updHit = st.hit;                               // what car.update itself reports
    const h = F1.resolveCarCollisions(st, others, STEP, []);
    if (useBump) car.bump(h);
    if (st.hit > maxHit) maxHit = st.hit;
    st.hit = Math.max(st.hit, h);                                       // main.js: strongest hit of the frame
    traj.push([st.x, st.z, st.speed, st.heading]);
  }
  return Object.assign({ hit: maxHit, carUpdateHit: updHit, traj }, summary(car.tyres));
}
function wallHit(seed, v, deg) {
  const car = F1.createCar(undefined, { random: mulberry32(seed) });
  const st = car.state;
  car.reset(WALLED, 0); st.x = 5; st.z = 100; st.heading = deg * Math.PI / 180; car.update(1e-4, null, WALLED);
  st.speed = v;
  let maxHit = 0;
  for (let n = 0; n < 240; n++) { car.update(STEP, { up: true }, WALLED); if (st.hit > maxHit) maxHit = st.hit; }
  return Object.assign({ hit: maxHit, carUpdateHit: maxHit }, summary(car.tyres));
}

const tally = () => ({ n: 0, flat: 0, punct: 0, hit: 0, updHit: 0 });
const add = (t, r) => { t.n++; t.hit = Math.max(t.hit, r.hit); t.updHit = Math.max(t.updHit, r.carUpdateHit || 0); if (r.flat > 0) t.flat++; if (r.punct >= 0) t.punct++; };
const withBump = tally(), noBump = tally(), wall = tally();
for (let s = 1; s <= SEEDS; s++) {
  add(withBump, carHit(s, 100, true));
  add(noBump, carHit(s, 100, false));
  add(wall, wallHit(s, 40, 45));
}
// the path: no tyres (nothing for the bump to damage), with and without car.bump
const a = carHit(1, 100, true, { tyres: false }), b = carHit(1, 100, false, { tyres: false });
let pathDiff = 0;
for (let i = 0; i < a.traj.length; i++) for (let j = 0; j < 4; j++) if (!Object.is(a.traj[i][j], b.traj[i][j])) pathDiff++;

const line = (label, t) => console.log(label.padEnd(46), t.n, 'runs, max hit', t.hit.toFixed(3), ' seen by car.update', t.updHit.toFixed(3),
  ' flat-spotted', t.flat, ' punctured', t.punct);
line('car-to-car 100 km/h, car.bump', withBump);
line('car-to-car 100 km/h, no car.bump (old main.js)', noBump);
line('wall 40 m/s at 45 deg', wall);
console.log('path without tyres, with vs without car.bump: ' + pathDiff + ' values differ over ' + a.traj.length + ' steps');
const ok = withBump.flat === SEEDS && withBump.punct > 0 && pathDiff === 0;
console.log(ok ? 'OK' : 'FAIL');
process.exit(ok ? 0 : 1);
