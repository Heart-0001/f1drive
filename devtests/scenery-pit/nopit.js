// node devtests/scenery-pit/nopit.js <old scenery.js>
// Where track.pit is null js/scenery.js must build exactly what it built before the pit lane existed: the current
// F1.buildScenery on each track with track.pit set to null against an older copy (which never read track.pit), every
// geometry attribute and instance matrix compared value for value. Ends with "IDENTICAL n / n" or the differences.
const path = require('path'), ROOT = path.resolve(__dirname, '..', '..') + '/';
global.window = global; global.THREE = require(ROOT + 'lib/three.min.js');
require(ROOT + 'tracks-data.js'); require(ROOT + 'scenery-data.js'); require(ROOT + 'js/track.js');
require(path.resolve(process.argv[2])); const oldB = F1.buildScenery;
require(ROOT + 'js/scenery.js'); const newB = F1.buildScenery;
function dump(sc) {
  const out = [];
  sc.group.children.forEach(o => {
    const g = o.geometry, arrs = [o.name];
    for (const k of Object.keys(g.attributes).sort()) arrs.push(k, g.attributes[k].array);
    if (o.isInstancedMesh) arrs.push('inst', o.instanceMatrix.array, o.instanceColor ? o.instanceColor.array : null);
    out.push(arrs);
  });
  return out;
}
function same(a, b) {
  if (a.length !== b.length) return 'mesh count ' + a.length + ' vs ' + b.length;
  for (let m = 0; m < a.length; m++) {
    if (a[m].length !== b[m].length) return a[m][0] + ': attributes differ';
    for (let k = 0; k < a[m].length; k++) {
      const x = a[m][k], y = b[m][k];
      if (x === null || typeof x === 'string') { if (x !== y) return a[m][0] + ': ' + x + ' vs ' + y; continue; }
      if (x.length !== y.length) return a[m][0] + ' ' + a[m][k - 1] + ': length ' + x.length + ' vs ' + y.length;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return a[m][0] + ' ' + a[m][k - 1] + '[' + i + ']: ' + x[i] + ' vs ' + y[i];
    }
  }
  return '';
}
let ok = 0, n = 0;
for (const td of F1_TRACKS) {
  const tr = F1.buildTrack(td), d = F1_SCENERY[td.id];
  for (const data of [d, undefined]) {
    const a = oldB(tr, td, data), pit = tr.pit;
    tr.pit = null; const b = newB(tr, td, data); tr.pit = pit;
    const r = same(dump(a), dump(b)); n++;
    if (r) console.log(td.id, data ? 'data' : 'proc', 'DIFFERS', r); else ok++;
    a.dispose(); b.dispose();
  }
  tr.dispose();
}
console.log((ok === n ? 'IDENTICAL ' : 'DIFFERENT: identical ') + ok + ' / ' + n);
