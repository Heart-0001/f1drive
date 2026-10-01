// node devtests/scenery-pit/time.js <old scenery.js> [reps=5]
// Build time of F1.buildScenery: an older copy of js/scenery.js against the current one, interleaved in one process
// (best of `reps` per track and variant, OSM data and procedural). Prints per-track and total milliseconds.
const path = require('path'), ROOT = path.resolve(__dirname, '..', '..') + '/';
global.window = global; global.THREE = require(ROOT + 'lib/three.min.js');
require(ROOT + 'tracks-data.js'); require(ROOT + 'scenery-data.js'); require(ROOT + 'js/track.js');
require(path.resolve(process.argv[2])); const oldB = F1.buildScenery;
require(ROOT + 'js/scenery.js'); const newB = F1.buildScenery;
const reps = +(process.argv[3] || 5);
let to = 0, tn = 0;
for (const td of F1_TRACKS) {
  const tr = F1.buildTrack(td), d = F1_SCENERY[td.id], row = [];
  for (const data of [d, undefined]) {
    let bo = Infinity, bn = Infinity;
    for (let r = 0; r < reps; r++) {
      let t = process.hrtime.bigint(); oldB(tr, td, data).dispose(); bo = Math.min(bo, Number(process.hrtime.bigint() - t) / 1e6);
      t = process.hrtime.bigint(); newB(tr, td, data).dispose(); bn = Math.min(bn, Number(process.hrtime.bigint() - t) / 1e6);
    }
    to += bo; tn += bn; row.push(bo.toFixed(1) + ' -> ' + bn.toFixed(1));
  }
  console.log(td.id.padEnd(8), 'data', row[0].padEnd(16), 'proc', row[1]);
  tr.dispose();
}
console.log('total old', to.toFixed(0), 'ms, new', tn.toFixed(0), 'ms (' + ((tn / to - 1) * 100).toFixed(1) + ' %)');
