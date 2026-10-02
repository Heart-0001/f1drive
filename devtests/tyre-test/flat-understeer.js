// node devtests/tyre-test/flat-understeer.js   (TYRES_JS=<copy> for another tyre model, e.g. HEAD's)
// Secondary issue: an understeer slide WITHOUT braking (load.slip > FLAT_SLIP 0.4, what car.js reports while the key /
// stick asks more steering than the grip: full lock between ~60 and ~250 km/h) grows flat spots on all the sliding
// tyres (FLAT_LAT 0.2 of the lock-up rate), although nothing locked. (a) synthetic: 150 km/h, lat 1, brake 0, slip
// 0.6 for 30 s; (b) closed loop: the pad driver (stick 4x what the corner needs) at Spa, RB19, 3 laps.
'use strict';
const path = require('path');
const T = require('./lib');
const Ty = T.F1.Tyres;
const ty = Ty.createTyres({ random: T.seeded(1) }); ty.fit('M');
const l = { speed: 150 / 3.6, lat: 1, brake: 0, drive: 0, slip: 0.6, onGrass: false, hit: 0 };
let out = [];
for (let s = 1; s <= 30 * 120; s++) { ty.update(1 / 120, l); if (s % (5 * 120) === 0) out.push((s / 120) + ' s: flat ' + ty.state.flat.map(x => x.toFixed(2)).join(' ')); }
console.log('(a) understeer, no brake, slip 0.6 at 150 km/h:\n   ' + out.join('\n   '));
for (const c of ['M', 'S']) {
  const r = T.drive({ track: 'be-1925', car: '2023-red-bull', driver: 'pad', compound: c, laps: 3, gain: 4, lookHz: 10, cut: 0.5 });
  console.log('(b) pad driver ' + c + ': lock-up steps (slip > 0.4 with brake > 0.5) ' + r.tot.lockSteps + ', slip steps ' + r.tot.slipSteps +
    ', max hit ' + r.tot.maxHit.toFixed(2) + ' -> flat ' + r.flat.map(x => x.toFixed(2)).join(' ') +
    ', puncture ' + (r.tot.punctAt ? r.tot.punctAt.t.toFixed(0) + ' s ' + r.tot.punctReason : 'none'));
}
