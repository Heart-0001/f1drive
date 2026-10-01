// How low does tyres.state.grip.traction get from wear alone (real js/tyres.js), and what does that do to the
// reference car's top speed through car.js's min(K.traction, muTraction * an) * gTrac?
// node devtests/review-1/verify-driving/probe-tyre-wear-top.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
const F1 = global.F1, R = F1.REF_SPEC;
let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const t = F1.createTyres({ random: rnd }); t.fit('M'); t.setWearRate(5);
const marks = [0.5, 0.75, 0.85, 0.9, 0.95, 0.99]; let mi = 0;
for (let n = 0; n < 2e6 && mi < marks.length; n++) {
  // alternate light cornering both ways with some throttle: keeps the tyres near their window
  const lat = (Math.floor(n / 600) % 2 ? 0.5 : -0.5);
  t.update(1 / 120, { speed: 60, lat, brake: 0, drive: 0.6, slip: 0, onGrass: false, hit: 0 });
  const rw = Math.min(t.state.wear[2], t.state.wear[3]);
  if (rw >= marks[mi]) {
    const g = t.state.grip.traction, T = R.traction * g;
    const vt = Math.sqrt((T - 0.5) / R.dragK) * 3.6;
    console.log('rear wear', rw.toFixed(3), ' temps', t.state.temp.map(x => x.toFixed(0)).join('/'), ' puncture', t.state.puncture,
      ' grip.traction', g.toFixed(4), ' -> top speed cap', Math.min(330, vt).toFixed(1), 'km/h (drag limit 330)');
    mi++;
  }
}
