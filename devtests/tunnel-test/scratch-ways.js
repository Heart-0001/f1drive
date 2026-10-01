// scratch: per-way sample coverage near the Monaco tunnel (any way given on the command line or the defaults)
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global; global.THREE = require(ROOT + '/lib/three.min.js');
require(ROOT + '/tracks-data.js'); require(ROOT + '/scenery-data.js'); require(ROOT + '/js/track.js');
const id = process.env.TRACK || 'mc-1929';
const t = F1_TRACKS.find(x => x.id === id), g = t.geo, tr = F1.buildTrack(t), S = tr.samples, N = S.length;
const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', id + '.json'), 'utf8'));
const ids = process.argv.slice(2).map(Number);
for (const e of j.elements) {
  const tg = e.tags || {};
  if (ids.length ? !ids.includes(e.id) : tg.highway !== 'raceway') continue;
  const P = e.geometry.map(n => [(n.lon - g.lon0) * g.kx, (n.lat - g.lat0) * g.kz]);
  const idx = P.map(p => { const n = tr.nearest(p[0], p[1]); return n.index + '(' + n.d.toFixed(1) + ')'; });
  console.log(e.id, tg.name || tg.highway, tg.tunnel || '', tg.layer || '', 'nodes->samples(d):', idx.join(' '));
}
