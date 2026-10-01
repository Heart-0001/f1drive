// node devtests/pit-logic/real-track.js [track-regex]
// js/pit.js over the REAL js/track.js on every track (drive-lane.js): the own box of slots 0 / 7 / 15 at the limiter
// speed (enter, service, done, exit), a run through at 100 km/h (one speeding, 5 s pending), flat out on the track
// beside the lane (nothing). Tracks whose track.pit is null / missing are checked to be inert.
// Exit code 1 when anything fails.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/pit.js'));
const { checkTrack, mockPit } = require('./drive-lane.js');
const F1 = global.F1, TR = global.F1_TRACKS;
// MOCK=1 [MOCK_SIDE=1]: replaces track.pit by drive-lane.js's contract-shaped lane on the real samples (checks this
// harness and pit.js on real geometry independently of the real pit lane).

const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
let failures = 0, withPit = 0, n = 0;
for (const td of TR) {
  if (filter && !filter.test(td.id + ' ' + td.name)) continue;
  n++;
  const t0 = Date.now();
  const track = F1.buildTrack(td);
  if (process.env.MOCK) track.pit = mockPit(track, +(process.env.MOCK_SIDE || -1));
  const res = checkTrack(F1, track);
  if (track.pit) withPit++;
  console.log((res.ok ? 'ok   ' : 'FAIL ') + td.id.padEnd(16) + ' ' + res.summary + '  (' + (Date.now() - t0) + ' ms)');
  res.fails.forEach(f => console.log('       ' + f));
  if (!res.ok) failures++;
  track.dispose();
}
console.log('\n' + n + ' tracks, ' + withPit + ' with track.pit; ' + (failures ? failures + ' FAILED' : 'all ok'));
process.exit(failures ? 1 : 0);
