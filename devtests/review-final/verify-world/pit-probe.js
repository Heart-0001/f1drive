// W1/W3 probe: build tracks with the real js/track.js and print the pit layout and its debug trail.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'js/track.js'), 'utf8');
function loadBuild() {
  const win = { THREE: global.THREE, F1_SCENERY: window.F1_SCENERY };
  vm.runInContext(SRC, vm.createContext({ window: win, console }), { filename: 'js/track.js' });
  return win;
}
const ids = (process.argv[2] || 'mc-1929,nl-1948').split(',');
const all = ids[0] === 'all' ? window.F1_TRACKS.map(t => t.id) : ids;
for (const id of all) {
  const win = loadBuild();
  win.F1.PIT_DEBUG = [];
  const td = window.F1_TRACKS.find(t => t.id === id);
  const tr = win.F1.buildTrack(td);
  const N = tr.samples.length, p = tr.pit;
  const ds = tr.length / N;
  const sig = (i) => (i > N / 2 ? i - N : i);
  if (!p) { console.log(id, 'NO PIT'); continue; }
  const b1 = p.boxes[0];
  console.log(`${id} N=${N} len=${tr.length.toFixed(0)} side=${p.side} limit=${p.limitKmh} from=${(sig(p.from)*ds).toFixed(0)}m entry=${(sig(p.entry)*ds).toFixed(0)}m exit=${(sig(p.exit)*ds).toFixed(0)}m to=${(sig(p.to)*ds).toFixed(0)}m laneHalfW=${p.laneHalfW} box1 d=${b1.d.toFixed(1)} box16 d=${p.boxes[15].d.toFixed(1)} y0=${tr.samples[0].y !== undefined ? tr.samples[0].y.toFixed(1) : '?'}`);
  if (process.env.DBG) for (const m of win.F1.PIT_DEBUG) console.log('   ', m);
  else console.log('    debug lines:', win.F1.PIT_DEBUG.length, win.F1.PIT_DEBUG.slice(0, 3).join(' | '));
}
