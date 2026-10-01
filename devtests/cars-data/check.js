// node devtests/cars-data/check.js
// Format check of js/cars-data.js (window.F1_CARS): loads it the three ways it can be loaded and validates
// every entry. Exit code 1 on any failure.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FILE = path.join(__dirname, '..', '..', 'js', 'cars-data.js');
const src = fs.readFileSync(FILE, 'utf8');
let failures = 0;
const check = (ok, what) => { if (!ok) { failures++; console.log('FAIL: ' + what); } return ok; };

// 1. node: require() returns the array
const viaRequire = require(FILE);
check(Array.isArray(viaRequire), 'require() returns an array');

// 2. browser-like: a global `window`, no `module`
const win = {};
vm.runInNewContext(src, { window: win }, { filename: 'cars-data.js' });
check(Array.isArray(win.F1_CARS), 'window.F1_CARS is set when there is a window and no module');

// 3. no window at all (worker / plain script): globalThis.F1_CARS
const ctx = vm.createContext({});
vm.runInContext(src, ctx, { filename: 'cars-data.js' });
check(Array.isArray(vm.runInContext('globalThis.F1_CARS', ctx)), 'globalThis.F1_CARS is set without a window');
check(JSON.stringify(win.F1_CARS) === JSON.stringify(viaRequire), 'all loaders give the same data');

const CARS = win.F1_CARS || [];
const PERF = ['power', 'drag', 'downforce', 'grip', 'brake', 'traction', 'ersPower', 'ersHarvest'];
const RATINGS = ['topSpeed', 'accel', 'cornering', 'braking', 'ers'];
const ids = new Set();
check(CARS.length === 12, '12 entries (standard + 11 teams), got ' + CARS.length);
check(CARS[0] && CARS[0].id === 'standard', "'standard' is first");
CARS.forEach((c, i) => {
  const at = (c && c.id) || '#' + i;
  check(typeof c.id === 'string' && /^[a-z0-9_-]{1,24}$/.test(c.id), at + ': id format');
  check(!ids.has(c.id), at + ': id unique');
  ids.add(c.id);
  for (const k of ['team', 'teamZh', 'teamEn', 'car', 'pu', 'engine', 'note']) check(typeof c[k] === 'string' && c[k].length > 0, at + '.' + k + ' is a non-empty string');
  check(!/[\r\n]/.test(c.note), at + ': note is one line');
  for (const k of ['colour', 'colour2', 'colourTeam']) check(/^#[0-9a-f]{6}$/i.test(c[k]), at + '.' + k + ' is #rrggbb');
  check(c.perf && Object.keys(c.perf).join() === PERF.join(), at + ': perf has exactly the 8 multipliers');
  for (const k of PERF) {
    const v = c.perf && c.perf[k];
    check(typeof v === 'number' && v >= 0.95 && v <= 1.05, at + '.perf.' + k + ' within 0.95 .. 1.05 (' + v + ')');
    if (i === 0) check(v === 1, 'standard.perf.' + k + ' is exactly 1');
  }
  check(c.ratings && Object.keys(c.ratings).join() === RATINGS.join(), at + ': ratings has exactly the 5 bars');
  for (const k of RATINGS) {
    const v = c.ratings && c.ratings[k];
    check(Number.isInteger(v) && v >= 0 && v <= 100, at + '.ratings.' + k + ' is an integer 0..100 (' + v + ')');
    if (i === 0) check(v === 50, 'standard.ratings.' + k + ' is 50');
  }
  check(c.est && typeof c.est.lapPct === 'number' && typeof c.est.topKmh === 'number', at + ': est');
});
const teams = CARS.slice(1);
const spread = Math.max.apply(null, teams.map(c => c.est.lapPct)) - Math.min.apply(null, teams.map(c => c.est.lapPct));
check(spread >= 1 && spread <= 1.5, 'estimated lap-time spread 1 .. 1.5 % (' + spread.toFixed(2) + ')');
for (const k of RATINGS) {
  const v = teams.map(c => c.ratings[k]);
  check(Math.max.apply(null, v) - Math.min.apply(null, v) >= 30, 'rating ' + k + ' spreads over at least 30 points');
}
console.log(failures ? failures + ' failure(s)' : 'js/cars-data.js OK: ' + CARS.length + ' cars, ids ' + CARS.map(c => c.id).join(' ') + '; lap-time spread ' + spread.toFixed(2) + ' %');
process.exitCode = failures ? 1 : 0;
