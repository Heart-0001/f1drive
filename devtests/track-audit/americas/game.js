// node devtests/track-audit/americas/game.js [ids...]
// Builds each circuit with the game's own code (lib/three.min.js + tracks-data.js + scenery-data.js + js/track.js, all
// read-only) and writes devtests/track-audit/americas/out/game-<id>.json: the tracks-data points (lat/lon via geo) and
// elev, the built ~2 m samples (s, lat, lon, y, bank deg, grade, signed curvature), track.pit and the lap direction.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const D = 180 / Math.PI;
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['us-2012', 'us-2023', 'us-2022', 'us-1909', 'us-1956', 'ca-1978'];
for (const id of IDS) {
  const td = window.F1_TRACKS.find((t) => t.id === id);
  if (!td) { console.log('no track ' + id); continue; }
  const g = td.geo;
  const ll = (x, z) => [g.lat0 + z / g.kz, g.lon0 + x / g.kx];
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N;
  // signed curvature, + = turning left (driver's left = +n)
  const samples = S.map((s, i) => {
    const a = S[(i - 3 + N) % N], b = S[(i + 3) % N];
    // turn angle from a to b, positive towards +n (= left)
    const dot = a.tx * b.tx + a.tz * b.tz, crs = (b.tx - a.tx) * s.nx + (b.tz - a.tz) * s.nz;
    const ang = Math.atan2(crs, dot);
    const [lat, lon] = ll(s.x, s.z);
    return { s: +s.s.toFixed(2), lat: +lat.toFixed(7), lon: +lon.toFixed(7), y: +s.y.toFixed(3), bank: +(s.bank * D).toFixed(3),
      grade: +s.grade.toFixed(5), k: +(ang / (6 * ds)).toFixed(6), halfW: +s.halfW.toFixed(2) };
  });
  // lap direction from the signed area in lat/lon (east = +lon, north = +lat): > 0 = anticlockwise seen from above
  let area = 0;
  for (let i = 0; i < N; i++) { const a = samples[i], b = samples[(i + 1) % N]; area += a.lon * b.lat - b.lon * a.lat; }
  const pit = tr.pit ? { side: tr.pit.side, sideText: tr.pit.side > 0 ? 'left' : 'right', limitKmh: tr.pit.limitKmh,
    from: tr.pit.from, to: tr.pit.to, entry: tr.pit.entry, exit: tr.pit.exit, length: tr.pit.length } : null;
  if (pit) for (const kname of ['from', 'to', 'entry', 'exit']) {
    const i = pit[kname];
    if (typeof i === 'number' && S[i]) { pit[kname + 'LL'] = ll(S[i].x, S[i].z).map((v) => +v.toFixed(7)); pit[kname + 'S'] = +S[i].s.toFixed(1); }
  }
  const pts = td.points.map((p, i) => { const [lat, lon] = ll(p[0], p[1]); return [+lat.toFixed(7), +lon.toFixed(7), td.elev[i]]; });
  const out = { id, name: td.name, lengthKm: td.lengthKm, geo: g, builtLength: tr.length, N, ds,
    direction: area > 0 ? 'anticlockwise' : 'clockwise', crossings: tr.crossings,
    bankOverrides: td.bankOverrides || null, pitSide: td.pitSide === undefined ? null : td.pitSide,
    pitLimitKmh: td.pitLimitKmh === undefined ? null : td.pitLimitKmh, pit, points: pts, samples };
  fs.writeFileSync(path.join(OUT, 'game-' + id + '.json'), JSON.stringify(out));
  const ys = S.map((s) => s.y), bk = S.map((s) => Math.abs(s.bank * D));
  console.log(id, td.name, 'N', N, 'len', tr.length.toFixed(1), 'dir', out.direction, 'y range', (Math.max(...ys) - Math.min(...ys)).toFixed(2),
    'max |bank|', Math.max(...bk).toFixed(2), 'start', JSON.stringify(ll(S[0].x, S[0].z).map((v) => +v.toFixed(6))), 'pit', JSON.stringify(pit));
  tr.dispose();
}
