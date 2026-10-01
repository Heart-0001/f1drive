// node devtests/scenery-test/pitside.js <old scenery-data file> [trackId ...]
// js/track.js puts the pit lane on the side of the scenery data's 'pit' buildings next to the line (unless the track
// data gives pitSide): after a scenery rebuild, does any track's pit lane (side, samples, lane geometry) or anything else
// js/track.js builds change? Builds every track (or the listed ones) with the old and with the current scenery-data.js
// and compares track.pit and a hash of the samples. Exit code 1 when a track differs.
'use strict';
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const oldFile = process.argv[2];
if (!oldFile) { console.log('usage: node devtests/scenery-test/pitside.js <old scenery-data file> [trackId ...]'); process.exit(2); }
const only = process.argv.slice(3);
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
const load = (f) => { const w = {}; new Function('window', fs.readFileSync(f, 'utf8'))(w); return w.F1_SCENERY; };
const OLD = load(path.resolve(oldFile)), NEW = load(path.join(ROOT, 'scenery-data.js'));
function sig(td, sc) {
  global.F1_SCENERY = sc;
  const tr = F1.buildTrack(td), S = tr.samples, p = tr.pit;
  let h = 0;
  const mix = (v) => { const s = String(Math.round(v * 1000)); for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; };
  for (const s of S) { mix(s.x); mix(s.z); mix(s.y); mix(s.wallPosDist || 0); mix(s.wallNegDist || 0); }
  const out = { side: p ? p.side : null, from: p ? p.from : null, to: p ? p.to : null, entry: p ? p.entry : null, exit: p ? p.exit : null,
    limit: p ? p.limitKmh : null, boxes: p && p.boxes ? p.boxes.length : 0, hash: h };
  tr.dispose();
  return out;
}
let diff = 0, n = 0;
for (const td of F1_TRACKS) {
  if (only.length && !only.includes(td.id)) continue;
  if (JSON.stringify(OLD[td.id]) === JSON.stringify(NEW[td.id])) continue;
  n++;
  const a = sig(td, OLD), b = sig(td, NEW), same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) diff++;
  console.log(`${td.id.padEnd(8)} ${same ? 'same track' : 'DIFFERS'}  old ${JSON.stringify(a)}${same ? '' : '\n         new ' + JSON.stringify(b)}`);
}
console.log(`\n${n} track(s) with changed scenery data; ${diff} build a different track`);
process.exit(diff ? 1 : 0);
