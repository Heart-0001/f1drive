// node devtests/track-audit/latam-za/game-dump.js [id ...]
// Builds each circuit with lib/three.min.js + js/track.js (scenery-data.js loaded, as in the game) and writes
// devtests/track-audit/latam-za/out/game-<id>.json: every ~2 m sample with lat/lon (through td.geo), s, y, grade,
// bank (deg), curvature radius, plus track.pit (side, limit, from / to / entry / exit as s and lat/lon).
// Read-only on the game files.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['mx-1962', 'br-1940', 'br-1977', 'ar-1952', 'za-1961'];
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
for (const id of ids) {
  const td = window.F1_TRACKS.find((t) => t.id === id);
  const g = td.geo;
  const tr = F1.buildTrack(td);
  const S = tr.samples, N = S.length, ds = tr.length / N;
  const ll = (x, z) => [+(g.lat0 + z / g.kz).toFixed(7), +(g.lon0 + x / g.kx).toFixed(7)];
  // signed curvature from tangent change over +-3 samples
  const curv = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = S[(i - 3 + N) % N], b = S[(i + 3) % N];
    curv[i] = -Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz) / (6 * ds);
  }
  const samples = S.map((s, i) => ({
    i, s: +s.s.toFixed(2), x: +s.x.toFixed(2), z: +s.z.toFixed(2), ll: ll(s.x, s.z),
    y: +(s.y || 0).toFixed(3), grade: +((s.grade || 0) * 100).toFixed(2), bankDeg: +((s.bank || 0) * 180 / Math.PI).toFixed(2),
    curv: +curv[i].toFixed(5), halfW: s.halfW !== undefined ? +s.halfW.toFixed(2) : null,
  }));
  let pit = null;
  if (tr.pit) {
    const p = tr.pit, at = (k) => ({ index: k, s: +S[k].s.toFixed(1), ll: ll(S[k].x, S[k].z) });
    pit = { side: p.side, sideWords: p.side > 0 ? 'left of the driver (+n)' : 'right of the driver (-n)', limitKmh: p.limitKmh,
      from: at(p.from), to: at(p.to), entry: at(p.entry), exit: at(p.exit), length: +p.length.toFixed(1) };
  }
  // signed area -> rotation sense (x east, z = -north)
  let area = 0;
  for (let i = 0; i < N; i++) { const a = S[i], b = S[(i + 1) % N]; area += a.x * b.z - b.x * a.z; }
  const out = {
    id, name: td.name, location: td.location, lengthKm: td.lengthKm, trackLength: +tr.length.toFixed(1), N, ds: +ds.toFixed(4),
    // In x = east, z = SOUTH (z = -north * k) coordinates the shoelace sign flips: area > 0 = clockwise seen from above.
    rotation: area > 0 ? 'clockwise' : 'anticlockwise', geo: g, bankOverrides: td.bankOverrides || null,
    pitSideData: td.pitSide || null, pitLimitKmhData: td.pitLimitKmh || null,
    points0: ll(td.points[0][0], td.points[0][1]),
    elevRange: +(Math.max(...td.elev) - Math.min(...td.elev)).toFixed(2),
    yRange: +(Math.max(...samples.map((q) => q.y)) - Math.min(...samples.map((q) => q.y))).toFixed(2),
    maxBankDeg: +Math.max(...samples.map((q) => Math.abs(q.bankDeg))).toFixed(2),
    pit, samples,
  };
  fs.writeFileSync(path.join(OUT, `game-${id}.json`), JSON.stringify(out));
  console.log(`${id} ${td.name}: N ${N}, ds ${ds.toFixed(3)}, len ${tr.length.toFixed(0)} m, ${out.rotation}, y range ${out.yRange} m ` +
    `(elev ${out.elevRange}), max |bank| ${out.maxBankDeg} deg, pit ${pit ? JSON.stringify({ side: pit.side, lim: pit.limitKmh, from: pit.from.s, entry: pit.entry.s, exit: pit.exit.s, to: pit.to.s }) : 'none'}`);
}
