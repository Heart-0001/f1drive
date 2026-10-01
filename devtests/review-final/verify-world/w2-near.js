// W2: which drivable places (other parts of the lap, pit lane) are near the outside face of Zandvoort T3 / T14?
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global; global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js')); require(path.join(ROOT, 'scenery-data.js'));
const win = { THREE: global.THREE, F1_SCENERY: window.F1_SCENERY };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/track.js'), 'utf8'), vm.createContext({ window: win, console }));
const tr = win.F1.buildTrack(window.F1_TRACKS.find(t => t.id === 'nl-1948')), S = tr.samples, N = S.length, ds = tr.length / N;
for (const [i, sg] of [[438, -1], [Number(process.argv[2] || 1820), Number(process.argv[3] || 1)]]) {
  const s = S[i], wo = (sg > 0 ? s.wallPosDist : s.wallNegDist) + 0.5;
  const fx = s.x + s.nx * sg * (wo + 2), fz = s.z + s.nz * sg * (wo + 2);
  console.log(`sample ${i} s=${Math.round(s.s)} bank ${(s.bank * 180 / Math.PI).toFixed(1)} foot y ${tr.surfaceY(i, sg * wo).toFixed(1)} terrain 2 m out ${tr.terrainY(fx, fz).toFixed(1)}`);
  let best = [];
  for (let j = 0; j < N; j++) { const dj = Math.min(Math.abs(j - i), N - Math.abs(j - i)); if (dj < 60) continue; const d = Math.hypot(S[j].x - fx, S[j].z - fz); best.push([d, j]); }
  best.sort((a, b) => a[0] - b[0]);
  const seen = new Set();
  for (const [d, j] of best) { const key = Math.round(j / 50); if (seen.has(key)) continue; seen.add(key); if (seen.size > 4) break; console.log(`   other road: sample ${j} s=${Math.round(S[j].s)} at ${d.toFixed(0)} m, y ${S[j].y.toFixed(1)}`); }
  if (tr.pit) console.log('   pit from/to samples', tr.pit.from, tr.pit.to, 'box1 at', tr.pit.boxes[0].index, 'dist to face', Math.hypot(tr.pit.boxes[0].x - fx, tr.pit.boxes[0].z - fz).toFixed(0), 'box16 dist', Math.hypot(tr.pit.boxes[15].x - fx, tr.pit.boxes[15].z - fz).toFixed(0));
}
// T14 worst sample
let w = null;
for (let i = 0; i < N; i++) for (const sg of [1, -1]) { const s = S[i]; if (!(sg > 0 ? s.wallPos : s.wallNeg)) continue; if (i > 300 && i < 600) continue; const wo = (sg > 0 ? s.wallPosDist : s.wallNegDist) + 0.5; const g = tr.surfaceY(i, sg * wo) - tr.terrainY(s.x + s.nx * sg * (wo + 1), s.z + s.nz * sg * (wo + 1)); if (Math.abs(s.bank) > 0.14 && (!w || g > w[0])) w = [g, i, sg]; }
console.log('T14 worst gap1', w && w[0].toFixed(2), 'sample', w && w[1], 'side', w && w[2]);
