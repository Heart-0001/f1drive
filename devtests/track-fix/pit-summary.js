// node devtests/track-fix/pit-summary.js [tracks-data.js] > out.txt — one line per track: the pit lane js/track.js lays out
// (side, limit, cross-section, from / entry / exit / to in m from the line). For before / after diffs of js/track.js.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
new Function('window', fs.readFileSync(path.resolve(process.argv[2] || path.join(ROOT, 'tracks-data.js')), 'utf8'))(global);
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
for (const td of global.F1_TRACKS) {
  const t = F1.buildTrack(td), p = t.pit, N = t.samples.length, ds = t.length / N, rel = (i) => Math.round((i > N / 2 ? i - N : i) * ds);
  console.log(td.id.padEnd(8) + (p ? ` side ${p.side} ${p.limitKmh}/${p.layoutLimitKmh || '-'} km/h lane ${2 * p.laneHalfW} from ${rel(p.from)} entry ${rel(p.entry)} exit ${rel(p.exit)} to ${rel(p.to)} boxes ${p.boxes.map((b) => b.index).join(',')}` : ' none'));
  t.dispose();
}
