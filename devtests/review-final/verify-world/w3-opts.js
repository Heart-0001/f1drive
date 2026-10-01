// W3: would the narrow cross-section fit Zandvoort at 80 km/h (curvature limit PIT_LAT_MAX = 8 m/s^2)? In-memory
// copy of js/track.js with [2, 80] added to the tried options; the project file is not touched.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global; global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js')); require(path.join(ROOT, 'scenery-data.js'));
let SRC = fs.readFileSync(path.join(ROOT, 'js/track.js'), 'utf8');
const A = 'var opts = [[0, 80], [1, 80], [0, 60], [1, 60], [2, 60]]';
if (!SRC.includes(A)) throw new Error('opts line not found');
SRC = SRC.replace(A, 'var opts = [[0, 80], [1, 80], [2, 80], [0, 60], [1, 60], [2, 60]]');
for (const id of (process.argv[2] || 'nl-1948,mc-1929').split(',')) {
  const win = { THREE: global.THREE, F1_SCENERY: window.F1_SCENERY };
  vm.runInContext(SRC, vm.createContext({ window: win, console }));
  win.F1.PIT_DEBUG = [];
  const tr = win.F1.buildTrack(window.F1_TRACKS.find(t => t.id === id)), N = tr.samples.length, ds = tr.length / N, p = tr.pit;
  const sig = (i) => Math.round((i > N / 2 ? i - N : i) * ds);
  console.log(`${id}: side ${p.side} limit ${p.limitKmh} from ${sig(p.from)} entry ${sig(p.entry)} exit ${sig(p.exit)} to ${sig(p.to)} laneHalfW ${p.laneHalfW} box1 d ${p.boxes[0].d.toFixed(1)}`);
  win.F1.PIT_DEBUG.forEach(m => console.log('   ', m));
}
