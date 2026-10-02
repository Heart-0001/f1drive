// node devtests/tyre-test/laps.js [driver] [compound] [wear] [--car=..] [--track=..] [--laps=N]
// One stint, one line per lap: wear of the most worn tyre, flat spots, the lap's hottest tyre, seconds sliding / off
// the asphalt, impacts, grip multipliers, lap time. Shows WHEN things happen in a stint (flat spots, overheating).
'use strict';
const D = require('./drivers');
const args = process.argv.slice(2), pos = args.filter(a => !a.startsWith('--'));
const opt = k => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : undefined; };
const driver = pos[0] || 'line', compound = pos[1] || 'M', wear = +(pos[2] || 1);
let lapN = -1, row = null;
const rows = [];
function flush() { if (row) rows.push(row); }
const r = D.stint({ track: opt('track') || 'be-1925', car: opt('car') || '2023-red-bull', driver, compound, wear, laps: +(opt('laps') || 40), seed: +(opt('seed') || 1),
  onLoad: (h, l, st) => { if (row) { if (l.slip > 0) row.slipS += h; if (l.slip > row.slipMax) row.slipMax = l.slip; if (l.onGrass) row.grassS += h; if (l.hit > row.hit) row.hit = l.hit; } },
  perSecond: s => {
    const n = Math.floor(s.lap);
    if (n !== lapN) { flush(); lapN = n; row = { lap: n, slipS: 0, slipMax: 0, grassS: 0, hit: 0, tMax: 0, wear: 0, flat: null, grip: 1, vib: 0 }; }
    row.tMax = Math.max(row.tMax, ...s.temp); row.wear = Math.max(...s.wear); row.flat = s.flat; row.grip = Math.min(row.grip, s.grip.lat);
  } });
flush();
console.log(r.car + ' ' + r.track + ' ' + driver + ' ' + compound + ' x' + wear);
for (const x of rows) console.log('lap ' + String(x.lap + 1).padStart(2) + '  wear ' + (x.wear * 100).toFixed(0).padStart(3) + '%  flat ' + x.flat.map(f => f.toFixed(2)).join(' ') +
  '  Tmax ' + x.tMax.toFixed(0) + '  slip ' + x.slipS.toFixed(1) + ' s (max ' + x.slipMax.toFixed(2) + ')  grass ' + x.grassS.toFixed(1) + ' s  hit ' + x.hit.toFixed(2) + '  grip.lat ' + x.grip.toFixed(3) +
  (r.laps[x.lap] ? '  ' + r.laps[x.lap].toFixed(1) + ' s' : ''));
console.log('puncture', JSON.stringify(r.punct));
