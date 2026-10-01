// W2: on the high (outer) side of banked corners, how far below the outer wall foot is the terrain height field?
// gap1 = wall foot - terrainY 1 m outside the wall; gap8 = wall foot - groundY 8 m outside the wall (on the skirt).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global; global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js')); require(path.join(ROOT, 'scenery-data.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'js/track.js'), 'utf8');
const ids = process.argv[2] ? process.argv[2].split(',') : window.F1_TRACKS.map(t => t.id);
const rows = [];
for (const id of ids) {
  const win = { THREE: global.THREE, F1_SCENERY: window.F1_SCENERY };
  vm.runInContext(SRC, vm.createContext({ window: win, console }));
  const td = window.F1_TRACKS.find(t => t.id === id);
  const tr = win.F1.buildTrack(td), S = tr.samples, N = S.length;
  let worst = { gap1: -1e9 }, worstLow = { gap1: -1e9 }, cnt3 = 0;
  for (let i = 0; i < N; i++) {
    const s = S[i];
    for (const sg of [1, -1]) {
      const hasWall = sg > 0 ? s.wallPos : s.wallNeg; if (!hasWall) continue;
      const wo = (sg > 0 ? s.wallPosDist : s.wallNegDist) + 0.5;
      const foot = tr.surfaceY(i, sg * wo);
      const high = sg * Math.tan(s.bank) * 1 > 0;   // is this side the raised side? (surfaceY grows with d*tanB)
      const p1 = { x: s.x + s.nx * sg * (wo + 1), z: s.z + s.nz * sg * (wo + 1) };
      const p8 = { x: s.x + s.nx * sg * (wo + 8), z: s.z + s.nz * sg * (wo + 8) };
      const n1 = tr.nearest(p1.x, p1.z); if (Math.abs(n1.index - i) > 3 && Math.abs(n1.index - i) < N - 3) continue; // another road nearer
      const gap1 = foot - tr.terrainY(p1.x, p1.z), gap8 = foot - tr.groundY(p8.x, p8.z);
      const r = { i, sg, bankDeg: +(s.bank * 180 / Math.PI).toFixed(1), gap1: +gap1.toFixed(2), gap8: +gap8.toFixed(2) };
      if (Math.abs(s.bank) > 8 * Math.PI / 180 && high) { if (gap1 > worst.gap1) worst = r; if (gap1 > 3) cnt3++; }
      else if (gap1 > worstLow.gap1) worstLow = r;
    }
  }
  rows.push([id, td.bankOverrides ? td.bankOverrides.length : 0, worst, worstLow, cnt3]);
  console.log(id.padEnd(8), 'overrides', td.bankOverrides ? td.bankOverrides.length : 0,
    '| banked>8deg high side worst', worst.gap1 > -1e9 ? JSON.stringify(worst) : '-', 'samples gap1>3m', cnt3,
    '| elsewhere worst', JSON.stringify(worstLow));
}
