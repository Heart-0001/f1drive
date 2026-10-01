// scratch: every cached way with a node within R m of samples A..B
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global; global.THREE = require(ROOT + '/lib/three.min.js');
require(ROOT + '/tracks-data.js'); require(ROOT + '/scenery-data.js'); require(ROOT + '/js/track.js');
const id = process.env.TRACK || 'mc-1929', A = +process.argv[2], B = +process.argv[3], R = +(process.argv[4] || 30);
const t = F1_TRACKS.find(x => x.id === id), g = t.geo, tr = F1.buildTrack(t), S = tr.samples;
const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', id + '.json'), 'utf8'));
for (const e of j.elements) {
  let best = 1e9, bi = -1;
  for (const n of e.geometry || []) {
    const x = (n.lon - g.lon0) * g.kx, z = (n.lat - g.lat0) * g.kz, q = tr.nearest(x, z);
    if (q.index >= A && q.index <= B && q.dist < best) { best = q.dist; bi = q.index; }
  }
  if (best <= R) console.log(e.id, 'near sample', bi, best.toFixed(1) + ' m', JSON.stringify(e.tags).slice(0, 220));
}
