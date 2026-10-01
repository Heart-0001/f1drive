// Probe: one wall impact, stepped with dt = 1/120 vs dt = 0.1 (many sub-steps): how much flat spot / how many
// puncture draws do the tyres see? (state.hit is not reset per sub-step)
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
const F1 = global.F1;
// straight flat test track with walls
function strip(len, n) {
  const S = [];
  for (let i = 0; i < n; i++) S.push({ x: 0, z: i * (len / n), tx: 0, tz: 1, nx: 1, nz: 0, s: i * (len / n), y: 0, bank: 0, wallPos: true, wallNeg: true });
  return { samples: S, length: len, halfWidth: 7, wallDist: 12,
    locate: (x, z, hint) => { let i = Math.round(z / (len / n)); i = Math.max(0, Math.min(n - 1, i)); return { index: i, d: x }; }, pit: null };
}
for (const dt of [1 / 120, 1 / 60, 1 / 30, 0.1]) {
  let draws = 0;
  const car = F1.createCar(null, { random: () => { draws++; return 0.99; } });   // 0.99: never a puncture, count the draws
  const track = strip(2000, 1000), st = car.state;
  car.reset(track, 10);
  st.x = 5; st.heading = -0.6; st.speed = 60;    // 216 km/h, 34 deg into the +n wall
  const fitDraws = draws; draws = 0;
  let t = 0, maxHit = 0, hits = 0;
  while (t < 1.0) { car.update(dt, { up: true }, track); t += dt; if (st.hit > 0) { hits++; maxHit = Math.max(maxHit, st.hit); } }
  const f = car.tyres.state.flat.map(v => v.toFixed(3)).join(' ');
  console.log('dt', dt.toFixed(4), 'updates with hit', hits, 'maxHit', maxHit.toFixed(2), 'random draws (impacts seen)', draws, 'flat spots', f, 'v', (st.speed * 3.6).toFixed(0));
}
