// node devtests/tyre-test/repro-spa.js [driver] [compound] [wear] [--car=2023-red-bull] [--track=be-1925] [--laps=N]
//   [--ablate=slip,hit,grass] [--every=5]
// The user's report (10-02): RB19 at Spa, wear x1, "a puncture halfway through lap 2 without hitting anything".
// Drives the stint with the REAL modules and prints, every `every` s, per tyre: wear, wear gained, temperature,
// flat spot, plus the max slip / grass time / impact of that second, the tyre load (g) and the puncture.
'use strict';
const D = require('./drivers');
const args = process.argv.slice(2);
const pos = args.filter(a => !a.startsWith('--'));
const opt = k => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : undefined; };
const driver = pos[0] || 'line', compound = pos[1] || 'S', wear = +(pos[2] || 1);
const every = +(opt('every') || 5);
const ablate = {}; (opt('ablate') || '').split(',').filter(Boolean).forEach(k => { ablate[k] = true; });
const f = (a, n) => a.map(x => x.toFixed(n).padStart(n + 4)).join('');
let k = 0;
const r = D.stint({ track: opt('track') || 'be-1925', car: opt('car') || '2023-red-bull', driver, compound, wear, laps: +(opt('laps') || 12),
  seed: +(opt('seed') || 1), ablate, stopAtPuncture: true,
  perSecond: row => {
    if (k++ % every) return;
    console.log(String(row.t).padStart(5) + 's lap ' + row.lap.toFixed(2) + ' ' + String(row.kmh).padStart(3) + ' km/h  wear%' + f(row.wear.map(x => x * 100), 1) +
      '  T' + f(row.temp, 0) + '  flat' + f(row.flat, 2) + '  slip ' + row.slip.toFixed(2) + ' grass ' + row.grass.toFixed(2) + ' hit ' + row.hit.toFixed(2) +
      ' load ' + row.load.toFixed(2) + 'g grip ' + row.grip.lat.toFixed(3));
  } });
console.log('\n' + r.car + ' ' + r.track + ' ' + driver + ' ' + compound + ' x' + wear + ': ' + r.km.toFixed(1) + ' km (' + (r.km / r.lapKm).toFixed(2) + ' laps), laps ' +
  r.laps.map(x => x.toFixed(1)).join(' '));
console.log('km to 50/75/90/100 %:', [0.5, 0.75, 0.9, 1].map(x => r.kmTo[x] === undefined ? '--' : r.kmTo[x].toFixed(1)).join(' / '),
  ' laps:', [0.5, 0.75, 0.9, 1].map(x => r.lapsTo[x] === undefined ? '--' : r.lapsTo[x].toFixed(1)).join(' / '));
console.log('max temp', r.maxTemp.map(x => x.toFixed(0)).join(' '), ' slip s', r.slipS.toFixed(1), ' grass s', r.grassS.toFixed(1), ' flat', r.flat.map(x => x.toFixed(2)).join(' '));
console.log('puncture:', JSON.stringify(r.punct));
console.log('impacts (' + r.hits.length + '):'); r.hits.slice(0, 40).forEach(h => console.log('  ' + JSON.stringify(h)));
