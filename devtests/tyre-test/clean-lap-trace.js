// node devtests/tyre-test/clean-lap-trace.js [S|M] [--every=5] [--laps=3]   (TYRES_JS=<copy> for another tyre model)
// The coordinator's request (10-02): the human-like keyboard driver on a CLEAN lap with only brief kerb use (looks at
// the road 20 times a second, late braking, the path 0.2 m further inside than the racing line), RB19 at Spa, wear x1:
// per second (printed every `every` s) the wear, temperature, flat spots, slip, grass / kerb time, hits and road load.
'use strict';
const T = require('./lib');
const args = process.argv.slice(2);
const c = args.find(a => /^[SMH]$/.test(a)) || 'S';
const every = +((args.find(a => a.startsWith('--every=')) || '=5').split('=')[1]);
const laps = +((args.find(a => a.startsWith('--laps=')) || '=3').split('=')[1]);
const r = T.drive({ track: 'be-1925', car: '2023-red-bull', driver: 'human', compound: c, laps, lookHz: 20, cut: 0.2, wear: 1 });
console.log('RB19 Spa ' + c + ' x1, human-like clean (20 Hz keys, late braking, 0.2 m inside): laps ' + r.laps.map(x => x.toFixed(2)).join(' ') +
  ', grass/kerb steps ' + r.tot.grassSteps + ', hits ' + r.tot.hits.length + ' (max ' + r.tot.maxHit.toFixed(2) + '), slip steps ' +
  (100 * r.tot.slipSteps / r.tot.steps).toFixed(1) + '%');
console.log('    t lap km/h  wear% FL    FR    RL    RR |  temp FL  FR  RL  RR | flat max | slip avg(max) | grass | hit | load g  compress g (min..max)');
for (const w of r.rows) {
  if (w.t % every && w.punct < 0) continue;
  console.log(String(w.t).padStart(5), String(w.lap).padStart(2), String(w.kmh).padStart(4), '     ', w.wear.map(x => x.toFixed(1).padStart(5)).join(' '), ' |   ',
    w.temp.map(x => x.toFixed(0).padStart(3)).join(' '), ' |', Math.max(...w.flat).toFixed(3), '   |', w.slip.toFixed(3) + '(' + w.slipMax.toFixed(2) + ')',
    '  |', String(w.grass).padStart(4), ' |', w.hit ? w.hit.toFixed(2) + ' ' + w.hitSrc : '  - ', '|', w.load.toFixed(2), '  ', w.comp.toFixed(2), '(' + w.compMin.toFixed(2) + '..' + w.compMax.toFixed(2) + ')',
    w.punct >= 0 ? 'PUNCTURE ' + ['FL', 'FR', 'RL', 'RR'][w.punct] : '');
}
console.log('end: wear % ' + r.wear.map(x => (x * 100).toFixed(1)).join(' ') + ' | no-slip shadow ' + r.wearNoSlip.map(x => (x * 100).toFixed(1)).join(' ') +
  ' | clean shadow ' + r.wearClean.map(x => (x * 100).toFixed(1)).join(' ') + ' | puncture ' + (r.tot.punctAt ? r.tot.punctAt.t.toFixed(1) + ' s ' + r.tot.punctReason : 'none'));
