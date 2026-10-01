// W1 fix check, part 2: rotated Monaco + a synthetic 'pit' footprint on the harbour (east, -n) side of the straight,
// to see whether the lane fits on the real pit side (in memory only).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global; global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js')); require(path.join(ROOT, 'scenery-data.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'js/track.js'), 'utf8');
const td0 = window.F1_TRACKS.find(t => t.id === 'mc-1929'), g = td0.geo;
const P = td0.points, E = td0.elev, n = P.length;
const i0 = 126;
const td = Object.assign({}, td0, { points: P.slice(i0).concat(P.slice(0, i0)), elev: E.slice(i0).concat(E.slice(0, i0)) });
const c = P[i0]; // straight runs ~north (-z); harbour = east (+x)
const fp = [[c[0] + 20, c[1] - 40], [c[0] + 30, c[1] - 40], [c[0] + 30, c[1] + 40], [c[0] + 20, c[1] + 40]];
const sc = Object.assign({}, window.F1_SCENERY, { 'mc-1929': Object.assign({}, window.F1_SCENERY['mc-1929'], {
  buildings: (window.F1_SCENERY['mc-1929'].buildings || []).concat([{ k: 'pit', h: 8, p: fp }]) }) });
const win = { THREE: global.THREE, F1_SCENERY: sc };
vm.runInContext(SRC, vm.createContext({ window: win, console }));
win.F1.PIT_DEBUG = [];
const tr = win.F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N, p = tr.pit;
const sig = (i) => Math.round((i > N / 2 ? i - N : i) * ds);
console.log('n at line', S[0].nx.toFixed(2), S[0].nz.toFixed(2), '(+x = east)');
if (!p) console.log('NO PIT'); else console.log(`pit side ${p.side} limit ${p.limitKmh} from ${sig(p.from)} entry ${sig(p.entry)} exit ${sig(p.exit)} to ${sig(p.to)} m; laneHalfW ${p.laneHalfW}; box1 d ${p.boxes[0].d.toFixed(1)}`);
win.F1.PIT_DEBUG.forEach(m => console.log('   ', m));
