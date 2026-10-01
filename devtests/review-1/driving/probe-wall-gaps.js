// Probe: where a track has NO wall (wallPos / wallNeg false), can the car reach another piece of road whose sample
// index is at most NEAR_SAMPLES (60, laps.js) ahead? Then laps.js would credit the cut as ordinary driving.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
const F1 = global.F1;
const NEAR = 60, REACH = 40;    // m: from the gap in the wall to another road's centreline
const rows = [];
for (const td of global.F1_TRACKS) {
  const track = F1.buildTrack(td), S = track.samples, N = S.length;
  let gaps = 0, best = null;
  for (let i = 0; i < N; i++) {
    const s = S[i];
    for (const side of [1, -1]) {
      if (side > 0 ? s.wallPos : s.wallNeg) continue;
      gaps++;
      // point 15 m beyond the road edge on that side
      const px = s.x + s.nx * side * 15, pz = s.z + s.nz * side * 15;
      for (let j = 0; j < N; j++) {
        let fwd = (j - i + N) % N;                 // samples skipped forwards
        if (fwd <= 20 || fwd > NEAR) continue;       // (adjacent road or too far to be believed)
        const q = S[j], dx = q.x - px, dz = q.z - pz;
        if (dx * dx + dz * dz > REACH * REACH) continue;
        const dy = Math.abs((q.y || 0) - (s.y || 0));
        if (dy > 3) continue;
        if (!best || fwd > best.fwd) best = { i, j, fwd, side, dist: Math.round(Math.sqrt(dx * dx + dz * dz)), dy: +dy.toFixed(1) };
      }
    }
  }
  if (best) rows.push({ track: td.id, name: td.name, gapSamples: gaps, ...best, skipM: Math.round(best.fwd * track.length / N) });
  track.dispose();
}
console.table(rows);
