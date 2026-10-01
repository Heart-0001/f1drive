// W1 fix check: rotate mc-1929 so the start is on Boulevard Albert 1er and see what pit layout / grid the real
// js/track.js gives there (in memory only; tracks-data.js is not touched).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global; global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js')); require(path.join(ROOT, 'scenery-data.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'js/track.js'), 'utf8');
const td0 = window.F1_TRACKS.find(t => t.id === 'mc-1929'), g = td0.geo;
const P = td0.points, E = td0.elev, n = P.length, cum = [0];
for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; cum.push(cum[i] + Math.hypot(b[0]-a[0], b[1]-a[1])); }
const ll = (x, z) => [(z / g.kz + g.lat0).toFixed(5), (x / g.kx + g.lon0).toFixed(5)].join(',');
const targets = process.argv.slice(2).map(Number);
for (const sT of (targets.length ? targets : [2380, 2429, 2470, 2515])) {
  let i0 = 0; for (let i = 0; i < n; i++) if (Math.abs(cum[i] - sT) < Math.abs(cum[i0] - sT)) i0 = i;
  const td = Object.assign({}, td0, { points: P.slice(i0).concat(P.slice(0, i0)), elev: E.slice(i0).concat(E.slice(0, i0)) });
  const win = { THREE: global.THREE, F1_SCENERY: window.F1_SCENERY };
  vm.runInContext(SRC, vm.createContext({ window: win, console }));
  win.F1.PIT_DEBUG = [];
  const tr = win.F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N, p = tr.pit;
  const sig = (i) => Math.round((i > N / 2 ? i - N : i) * ds);
  const gr = (i) => { const a = S[(i - 2 + N) % N], b = S[(i + 2) % N]; return (b.y - a.y) / (4 * ds) * 100; };
  let gm = 0; for (let k = 1; k <= 16; k++) gm = Math.max(gm, Math.abs(gr((N - Math.round(k * 8 / ds)) % N)));
  console.log(`start vertex ${i0} (s=${cum[i0].toFixed(0)}) at ${ll(P[i0][0], P[i0][1])} y=${S[0].y.toFixed(1)}; grid max grade ${gm.toFixed(1)} %`);
  if (!p) { console.log('  NO PIT'); win.F1.PIT_DEBUG.forEach(m => console.log('   ', m)); continue; }
  const taken = win.F1.PIT_DEBUG.length;
  console.log(`  pit side ${p.side} limit ${p.limitKmh} from ${sig(p.from)} entry ${sig(p.entry)} exit ${sig(p.exit)} to ${sig(p.to)} m; laneHalfW ${p.laneHalfW}; box1 d ${p.boxes[0].d.toFixed(1)}; rejected tries ${taken}`);
  console.log('   entry at', ll(S[p.entry].x, S[p.entry].z), 'exit at', ll(S[p.exit].x, S[p.exit].z));
  if (process.env.DBG) win.F1.PIT_DEBUG.forEach(m => console.log('   ', m));
}
