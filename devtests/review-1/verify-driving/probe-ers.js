// Verify finding sanitize-ers-zero. node devtests/review-1/verify-driving/probe-ers.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
const F1 = global.F1;
const cases = { 'null': null, 'false': false, 'undefined (missing)': undefined, '0': 0, "''": '', 'NaN': NaN, '{}': {}, "'x'": 'x',
  '{store:0,power:0,harvest:0} (2010: powerElectric 0 kW)': { store: 0, power: 0, harvest: 0 } };
for (const [k, v] of Object.entries(cases)) {
  const spec = Object.assign({}, F1.REF_SPEC, { id: '2010-test', year: 2010 });
  if (v === undefined) delete spec.ers; else spec.ers = v;
  const s = F1.sanitizeSpec(spec);
  const car = F1.createCar(spec); car.setBattery(1);
  console.log(('ers ' + k).padEnd(62), '->', JSON.stringify(s.ers), ' battery', car.state.battery, ' topBoost km/h', (car.perf.topSpeedBoost * 3.6).toFixed(1));
}
