// node devtests/track-audit/be-nl-de-gb/dump-game.js <id> [...ids]
// Builds each circuit with the game's own code (lib/three.min.js + tracks-data.js + scenery-data.js + js/track.js, all
// read-only) and writes devtests/track-audit/be-nl-de-gb/out/game-<id>.json: tracks-data points (lat/lon through geo) +
// elev, and the built ~2 m samples (s, lat, lon, y, bank deg, grade, curvature k (1/m, + = left), halfW), crossings and
// track.pit (side, limit, from / to / entry / exit as sample index, arc length and lat/lon).
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
for (const id of process.argv.slice(2)) {
  const td = window.F1_TRACKS.find((t) => t.id === id);
  if (!td) { console.log('no track ' + id); continue; }
  const g = td.geo;
  const ll = (x, z) => [g.lat0 + z / g.kz, g.lon0 + x / g.kx];
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N;
  const samples = S.map((s, i) => {
    const a = S[(i - 3 + N) % N], b = S[(i + 3) % N];
    const cr = a.tx * b.tz - a.tz * b.tx, dt = a.tx * b.tx + a.tz * b.tz;
    const k = -Math.atan2(cr, dt) / (6 * ds);
    const [lat, lon] = ll(s.x, s.z);
    return { s: +s.s.toFixed(2), lat: +lat.toFixed(7), lon: +lon.toFixed(7), y: +s.y.toFixed(3), bank: +(s.bank * D).toFixed(3),
      grade: +s.grade.toFixed(5), k: +k.toFixed(6), halfW: +s.halfW.toFixed(2) };
  });
  const pit = tr.pit ? { side: tr.pit.side, limitKmh: tr.pit.limitKmh, from: tr.pit.from, to: tr.pit.to, entry: tr.pit.entry,
    exit: tr.pit.exit, boxes: tr.pit.boxes ? tr.pit.boxes.length : 0 } : null;
  if (pit) for (const kname of ['from', 'to', 'entry', 'exit']) {
    const i = pit[kname];
    if (typeof i === 'number' && S[i]) { pit[kname + 'LL'] = ll(S[i].x, S[i].z).map((v) => +v.toFixed(7)); pit[kname + 'S'] = +S[i].s.toFixed(1); }
  }
  const pts = td.points.map((p, i) => { const [lat, lon] = ll(p[0], p[1]); return [+lat.toFixed(7), +lon.toFixed(7), td.elev[i]]; });
  const out = { id, name: td.name, lengthKm: td.lengthKm, geo: g, builtLength: tr.length, N, ds, crossings: tr.crossings,
    bankOverrides: td.bankOverrides || null, pitSide: td.pitSide, pitLimitKmh: td.pitLimitKmh, pit, points: pts, samples };
  fs.writeFileSync(path.join(OUT, 'game-' + id + '.json'), JSON.stringify(out));
  const ys = S.map((s) => s.y);
  console.log(id, 'N', N, 'len', tr.length.toFixed(1), 'y range', (Math.max(...ys) - Math.min(...ys)).toFixed(2), 'pit', JSON.stringify(pit));
  tr.dispose();
}
