// node devtests/track-audit/perception/profile.js <track> [from_m] [to_m] [step_m]
// Prints the game's profile (from out/<track>-samples.json, written by shots.js DUMP=1): s, lat/lon, y, grade %, bank deg,
// curvature (1/m; + = left), plus the steepest climb / descent and the largest banks of the lap.
'use strict';
const fs = require('fs'), path = require('path');
const [tr, a, b, st] = process.argv.slice(2);
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', tr + '-samples.json'), 'utf8'));
const n = D.n, ds = D.length / n, from = +(a || 0), to = +(b || D.length), step = +(st || 20);
for (let s = from; s <= to; s += step) {
  const i = Math.round(s / ds) % n;
  console.log([i, D.s[i], D.lat[i], D.lon[i], D.y[i].toFixed(1), D.grade[i].toFixed(1) + '%', D.bank[i].toFixed(1) + 'deg', D.curv[i].toFixed(4), 'R' + (Math.abs(D.curv[i]) > 1e-4 ? Math.round(1 / Math.abs(D.curv[i])) : '-')].join('\t'));
}
let gx = 0, gn = 0, ix = 0, inn = 0;
for (let i = 0; i < n; i++) { if (D.grade[i] > gx) { gx = D.grade[i]; ix = i; } if (D.grade[i] < gn) { gn = D.grade[i]; inn = i; } }
console.log('max climb ' + gx + '% at s ' + D.s[ix] + ' (' + D.lat[ix] + ', ' + D.lon[ix] + ')   max descent ' + gn + '% at s ' + D.s[inn] + ' (' + D.lat[inn] + ', ' + D.lon[inn] + ')');
const banks = [];
for (let i = 0; i < n; i++) if (Math.abs(D.bank[i]) > 4) banks.push(i);
let runs = [], r0 = -1;
for (let k = 0; k < banks.length; k++) { if (r0 < 0) r0 = banks[k]; if (k === banks.length - 1 || banks[k + 1] !== banks[k] + 1) { runs.push([r0, banks[k]]); r0 = -1; } }
runs.forEach(([p, q]) => { let m = 0, mi = p; for (let i = p; i <= q; i++) if (Math.abs(D.bank[i]) > Math.abs(m)) { m = D.bank[i]; mi = i; }
  console.log('bank > 4 deg: s ' + D.s[p] + '..' + D.s[q] + ' max ' + m + ' deg at s ' + D.s[mi] + ' (' + D.lat[mi] + ', ' + D.lon[mi] + ')'); });
