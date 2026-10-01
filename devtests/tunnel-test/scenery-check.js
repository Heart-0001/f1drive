// node devtests/tunnel-test/scenery-check.js [trackId]
// What js/scenery.js puts next to / over the covered stretches (debug footprints, SCENERY_DEBUG): every footprint with a
// point within 20 m of the corridor edge of a covered sample, with its kind. Also the data buildings covering the road.
const path = require('path'), ROOT = path.resolve(__dirname, '..', '..');
global.window = global; global.THREE = require(ROOT + '/lib/three.min.js');
require(ROOT + '/tracks-data.js'); require(ROOT + '/scenery-data.js'); require(ROOT + '/js/track.js'); require(ROOT + '/js/scenery.js');
require(ROOT + '/js/tunnels.js');
F1.SCENERY_DEBUG = true;
const id = process.argv[2] || 'mc-1929';
const td = F1_TRACKS.find(t => t.id === id), tr = F1.buildTrack(td), S = tr.samples, N = S.length;
const sc = F1.buildScenery(tr, td, F1_SCENERY[id]);
const tn = F1.buildTunnels(tr, td);
const cov = new Uint8Array(N);
for (let i = 0; i < N; i++) cov[i] = tn.inTunnel(i) > 0 || tn.covered(i) ? 1 : 0;
const kinds = {};
for (const f of sc.debug.footprints) {
  const pts = f.p || [];
  let hit = null;
  for (const q of pts) {
    const n = tr.nearest(q[0], q[1]);
    if (!tn.covered(n.index)) continue;
    const s = S[n.index], lim = Math.max(n.d > 0 ? s.wallPosDist : s.wallNegDist, s.halfW + 1);
    if (Math.abs(n.d) - lim < 20) { hit = { i: n.index, d: +n.d.toFixed(1), over: +(Math.abs(n.d) - lim).toFixed(1) }; break; }
  }
  if (hit) { (kinds[f.k] = kinds[f.k] || []).push(hit); }
}
for (const k in kinds) console.log(k.padEnd(16), kinds[k].length, JSON.stringify(kinds[k].slice(0, 6)));
console.log('tunnel stats', JSON.stringify(tn.stats));
