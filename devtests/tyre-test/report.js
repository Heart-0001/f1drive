// node devtests/tyre-test/report.js [out/calib-<tag>.json]
// Markdown tables of a calibration run (devtests/tyre-test/calib.js) for devtests/tyre-test/README.md and the tyre
// section of js/README-interfaces.md: summary per car / driver / compound, the 40 circuits, the wear-rate scaling, and
// every puncture that came before the tyre was worn through.
'use strict';
const path = require('path'), fs = require('fs');
global.window = global;
require('../../tracks-data.js');
const file = process.argv[2] || path.join(__dirname, 'out', 'calib-v1.json');
const R = JSON.parse(fs.readFileSync(file, 'utf8')).filter(r => r.ok);
const TD = id => global.F1_TRACKS.find(t => t.id === id);
const cars = [...new Set(R.map(r => r.car))], drivers = [...new Set(R.map(r => r.driver))], rates = [...new Set(R.map(r => r.rate))].sort();
const tracks = global.F1_TRACKS.map(t => t.id).filter(id => R.some(r => r.track === id));
const C = ['S', 'M', 'H'];
const find = (car, driver, c, track, rate) => R.find(r => r.car === car && r.driver === driver && r.compound === c && r.track === track && r.rate === (rate || 1));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const f0 = x => x === undefined || x === null || !isFinite(x) ? '–' : x.toFixed(0);
const f1 = x => x === undefined || x === null || !isFinite(x) ? '–' : x.toFixed(1);
const short = id => id.replace(/^20(\d\d)-/, "'$1 ").replace('red-bull', 'Red Bull').replace('mercedes', 'Mercedes');
const out = [];
const p = s => out.push(s);

p('### Summary, wear x1: km to the cliff (75 %, 4 % grip lost) and to 100 % — mean over the ' + tracks.length + ' circuits (min .. max)');
p('');
p('| car | driver | soft: cliff | soft: 100 % | medium: cliff | medium: 100 % | hard: cliff | hard: 100 % |');
p('|---|---|---|---|---|---|---|---|');
for (const driver of drivers) for (const car of cars) {
  const cells = [];
  for (const c of C) {
    const rs = tracks.map(t => find(car, driver, c, t)).filter(Boolean);
    for (const th of [0.75, 1]) {
      const km = rs.map(r => r.kmTo[th]).filter(x => x !== undefined);
      cells.push(km.length ? f0(mean(km)) + ' km (' + f0(Math.min(...km)) + '..' + f0(Math.max(...km)) + ')' + (km.length < rs.length ? ' *' + (rs.length - km.length) : '') : '–');
    }
  }
  p('| ' + short(car) + ' | ' + driver + ' | ' + cells.join(' | ') + ' |');
}
p('');
p('(* n: n stints ended before that - a puncture from a wall impact past the cliff, listed below - or ran out of distance.) In laps of a 5 km circuit divide by 5.');
p('');

const ref = cars.includes('2023-red-bull') ? '2023-red-bull' : cars[0];
const others = cars.filter(c => c !== ref);
p('### Per circuit, wear x1: laps to the cliff (75 %) — ' + short(ref) + ' (S / M / H, and M to 100 %), the other cars on mediums, the human-like driver');
p('');
const head = ['circuit', 'km', 'lap (s)', 'S', 'M', 'H', 'M 100 %'].concat(others.map(c => short(c) + ' M'),
  drivers.includes('human') ? ['human S', 'human M'] : [], drivers.includes('ap') ? ['analog M'] : []);
p('| ' + head.join(' | ') + ' |');
p('|' + head.map(() => '---|').join(''));
for (const t of tracks) {
  const td = TD(t), m = find(ref, 'line', 'M', t);
  const row = [td.name.replace(/\|/g, '/').slice(0, 34), m ? (m.lapKm).toFixed(2) : '–', m ? f1(m.lapT) : '–'];
  for (const c of C) { const r = find(ref, 'line', c, t); row.push(r ? f1(r.lapsTo[0.75]) : '–'); }
  row.push(m ? f1(m.lapsTo[1]) : '–');
  for (const c of others) { const r = find(c, 'line', 'M', t); row.push(r ? f1(r.lapsTo[0.75]) : '–'); }
  if (drivers.includes('human')) for (const c of ['S', 'M']) { const r = find(ref, 'human', c, t); row.push(r ? f1(r.lapsTo[0.75]) : '–'); }
  if (drivers.includes('ap')) { const r = find(ref, 'ap', 'M', t); row.push(r ? f1(r.lapsTo[0.75]) : '–'); }
  p('| ' + row.join(' | ') + ' |');
}
p('');

if (rates.length > 1) {
  p('### Wear multiplier: km to the cliff at xN times N, against x1 (all stints of every car / driver / compound / circuit)');
  p('');
  p('| rate | stints | (km to 75 %) x rate / x1: mean | min | max | punctures before 100 % |');
  p('|---|---|---|---|---|---|');
  for (const rate of rates) {
    const rs = R.filter(r => r.rate === rate), q = [];
    for (const r of rs) { const b = find(r.car, r.driver, r.compound, r.track, 1); if (b && b.kmTo[0.75] && r.kmTo[0.75]) q.push(r.kmTo[0.75] * rate / b.kmTo[0.75]); }
    const bad = rs.filter(r => r.punct && (r.punct.cause !== 'worn through' || Math.max(...r.punct.wear) < 1));
    p('| x' + rate + ' | ' + rs.length + ' | ' + (q.length ? mean(q).toFixed(3) : '–') + ' | ' + (q.length ? Math.min(...q).toFixed(3) : '–') + ' | ' + (q.length ? Math.max(...q).toFixed(3) : '–') + ' | ' + bad.length + ' |');
  }
  p('');
}

const bad = R.filter(r => r.punct && (r.punct.cause !== 'worn through' || Math.max(...r.punct.wear) < 1));
p('### Punctures before the tyre was worn through: ' + bad.length + ' of ' + R.length + ' stints');
p('');
if (bad.length) {
  p('| car | circuit | driver | set | rate | at (laps) | wheel | cause | wear | the impact |');
  p('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of bad) {
    const h = r.punct.lastHit;
    p('| ' + short(r.car) + ' | ' + r.track + ' | ' + r.driver + ' | ' + r.compound + ' | x' + r.rate + ' | ' + r.punct.lap + ' | ' + r.punct.wheel + ' | ' + r.punct.cause + ' | ' +
      r.punct.wear.map(x => (x * 100).toFixed(0)).join(' / ') + ' | ' + (h ? h.src + ' ' + h.kmh + ' km/h, hit ' + h.hit + ' (d ' + h.d + ' m, wall ' + h.wall + ')' : '–') + ' |');
  }
  p('');
}
// before the cliff: impacts, flat spots, overheating
const atC = R.filter(r => r.atCliff);
const flatMax = atC.map(r => ({ r, f: Math.max(...r.atCliff.flat) })).sort((a, b) => b.f - a.f);
const hotEarly = R.filter(r => r.hotAt && r.hotAt.wear < 0.75);
p('### Up to the cliff (75 %): flat spots, overheating, impacts');
p('');
for (const driver of drivers) {
  const rs = atC.filter(r => r.driver === driver && r.rate === 1);
  if (!rs.length) continue;
  const fl = rs.map(r => Math.max(...r.atCliff.flat));
  p('- ' + driver + ': largest flat spot at the cliff mean ' + mean(fl).toFixed(2) + ', max ' + Math.max(...fl).toFixed(2) + '; stints with a tyre 15 deg C over its window before 75 %: ' +
    hotEarly.filter(r => r.driver === driver && r.rate === 1).length + ' / ' + R.filter(r => r.driver === driver && r.rate === 1).length +
    '; wall impacts before the cliff: ' + rs.reduce((s, r) => s + r.atCliff.hits, 0) + ' in ' + rs.length + ' stints');
}
p('');
console.log(out.join('\n'));
