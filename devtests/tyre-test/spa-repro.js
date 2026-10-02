// node devtests/tyre-test/spa-repro.js [drivers=line,keys,kerb,ai] [--car=2023-red-bull] [--track=be-1925]
//   [--compound=M] [--wear=1] [--laps=3] [--seconds] [--json]
// The user's report (10-02): RB19 at Spa, tyre wear x1, a puncture halfway through lap 2 without hitting anything.
// Drives the real car (js/car.js + js/tyres.js) with each driver and prints per second: wear % (FL FR RL RR),
// temperature, flat spots, grip, slip, hits (and their source), the road's load / compression; then the puncture
// (when, which tyre, why) and the totals.
'use strict';
const T = require('./lib');
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const drivers = (args.find(a => !a.startsWith('--')) || 'line,keys,kerb,ai').split(',');
const car = opt('car', '2023-red-bull'), trk = opt('track', 'be-1925'), comp = opt('compound', 'M');
const wear = +opt('wear', 1), laps = +opt('laps', 3);
const SECONDS = args.includes('--seconds');
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

for (const d of drivers) {
  const r = T.drive({ track: trk, car, driver: d, compound: comp, wear, laps, seed: 1 });
  console.log('\n==== ' + d + ': ' + car + ' at ' + trk + ' (' + r.km.toFixed(3) + ' km), ' + comp + ' x' + wear + ', laps ' +
    r.laps.map(x => x.toFixed(2)).join(' ') + ' (' + r.lapsDone + ' done, ' + r.time.toFixed(0) + ' s)');
  if (SECONDS) {
    console.log('   t lap  km/h  wear% FL/FR/RL/RR           temp FL/FR/RL/RR        flat max  grip lat/brk/trac    lat  brk  drv  slip(max)  grass  hit(src)      load comp(min..max)');
    for (const w of r.rows) {
      console.log(String(w.t).padStart(4), String(w.lap).padStart(2), String(w.kmh).padStart(5), ' ',
        w.wear.map(x => x.toFixed(1).padStart(5)).join(' '), '  ', w.temp.map(x => x.toFixed(0).padStart(4)).join(''), '  ',
        Math.max(...w.flat).toFixed(3), ' ', w.grip.map(x => x.toFixed(3)).join('/'), ' ', w.lat.toFixed(2), w.brk.toFixed(2), w.drv.toFixed(2),
        w.slip.toFixed(3) + '(' + w.slipMax.toFixed(2) + ')', String(w.grass).padStart(4), ' ', w.hit ? w.hit.toFixed(2) + ' ' + w.hitSrc : '   -   ',
        ' ', w.load.toFixed(2), w.comp.toFixed(2) + ' (' + w.compMin.toFixed(2) + '..' + w.compMax.toFixed(2) + ')', w.punct >= 0 ? ' PUNCTURE ' + w.punct : '');
    }
  }
  const t = r.tot;
  console.log('   end wear %', r.wear.map(x => (x * 100).toFixed(1)).join(' '), ' temp', r.temp.map(x => x.toFixed(0)).join(' '),
    ' flat', r.flat.map(x => x.toFixed(3)).join(' '), ' slip steps', t.slipSteps, '(' + (100 * t.slipSteps / t.steps).toFixed(1) + '%)',
    ' lock-up steps', t.lockSteps, ' grass steps', t.grassSteps, ' kerb steps', r.kerbSteps, ' max hit', t.maxHit.toFixed(3), ' hits', t.hits.length);
  if (t.hits.length) console.log('   hits [t, hit, source, sample, d, km/h]:', JSON.stringify(t.hits.slice(0, 20)));
  if (t.punctAt) console.log('   PUNCTURE at', t.punctAt.t.toFixed(1), 's, lap', r.lapsDone, 'tyre', ['FL', 'FR', 'RL', 'RR'][t.punctAt.wheel], 'reason', t.punctReason,
    'wear', t.punctAt.wear.map(x => (x * 100).toFixed(1)).join(' '));
  else console.log('   no puncture');
  // wear per lap
  const per = [];
  let last = [0, 0, 0, 0], lastLap = 0;
  for (const w of r.rows) if (w.lap !== lastLap) { per.push(w.wear.map((x, i) => (x - last[i]).toFixed(1)).join('/')); last = w.wear; lastLap = w.lap; }
  console.log('   wear % per lap (FL/FR/RL/RR):', per.join('  '));
  if (args.includes('--json')) fs.writeFileSync(path.join(OUT, 'spa-' + d + '.json'), JSON.stringify(r, null, 0));
}
