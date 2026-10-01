// W1: grade under the start line and the 16 grid boxes at Monaco (built track), and lane surroundings.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global; global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js')); require(path.join(ROOT, 'scenery-data.js'));
const win = { THREE: global.THREE, F1_SCENERY: window.F1_SCENERY };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/track.js'), 'utf8'), vm.createContext({ window: win, console }));
const id = process.argv[2] || 'mc-1929';
const td = window.F1_TRACKS.find(t => t.id === id), g = td.geo;
const tr = win.F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N;
console.log('sample keys', Object.keys(S[0]).join(','));
const ll = (x, z) => [(z / g.kz + g.lat0).toFixed(5), (x / g.kx + g.lon0).toFixed(5)].join(',');
const gr = (i) => { const a = S[(i - 2 + N) % N], b = S[(i + 2) % N]; return (b.y - a.y) / (4 * ds) * 100; };
console.log('line: y', S[0].y.toFixed(1), 'grade %', gr(0).toFixed(1), 'at', ll(S[0].x, S[0].z));
let mx = 0;
tr.grid.forEach((gp, k) => { const i = ((Math.round(gp.index !== undefined ? gp.index : 0)) + N) % N; });
for (let k = 1; k <= 16; k++) { const i = (N - Math.round(k * 8 / ds)) % N; mx = Math.max(mx, Math.abs(gr(i))); if (k % 4 === 1 || k === 16) console.log(' box', k, 's', (-(k*8)), 'y', S[i].y.toFixed(1), 'grade %', gr(i).toFixed(1), ll(S[i].x, S[i].z)); }
console.log('max |grade| on the grid %', mx.toFixed(1));
const p = tr.pit;
for (const [nm, i] of [['from', p.from], ['entry', p.entry], ['exit', p.exit], ['to', p.to]]) console.log(' pit', nm, ll(S[i].x, S[i].z), 'y', S[i].y.toFixed(1), 'grade %', gr(i).toFixed(1));
for (const b of [p.boxes[0], p.boxes[15]]) console.log(' box slot', b.slot, ll(b.x, b.z), 'y', b.y.toFixed(1));
let gmax = 0; for (let k = 0; k <= ((p.to - p.from + N) % N); k++) gmax = Math.max(gmax, Math.abs(gr((p.from + k) % N)));
console.log(' max |grade| along the pit lane %', gmax.toFixed(1));
