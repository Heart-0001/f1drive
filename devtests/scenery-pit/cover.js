// node devtests/scenery-pit/cover.js <trackId> : which OSM buildings stand right behind the garage face (debug footprints)
const ROOT = require('path').resolve(__dirname, '..', '..') + '/';
global.window = global; global.THREE = require(ROOT + 'lib/three.min.js');
require(ROOT + 'tracks-data.js'); require(ROOT + 'scenery-data.js'); require(ROOT + 'js/track.js'); require(ROOT + 'js/scenery.js');
F1.SCENERY_DEBUG = true;
const id = process.argv[2], td = F1_TRACKS.find(t => t.id === id), tr = F1.buildTrack(td), S = tr.samples, N = S.length, pit = tr.pit;
const sc = F1.buildScenery(tr, td, process.argv[3] === 'proc' ? undefined : F1_SCENERY[id]);
const side = pit.side, wall = i => side > 0 ? S[i].wallPosDist : S[i].wallNegDist, ds = tr.length / N;
const pip = (x, z, p) => { let c = false; for (let i = 0, n = p.length, j = n - 1; i < n; j = i++) { const a = p[i], b = p[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const seen = new Map();
for (let k = 0; k <= (pit.to - pit.from + N) % N; k += 3) {
  const i = (pit.from + k) % N, s = S[i];
  for (const off of [2, 5, 9, 14, 20]) {
    const d = side * (wall(i) + off), x = s.x + s.nx * d, z = s.z + s.nz * d;
    for (const f of sc.debug.footprints) {
      if (!f.p || f.p.length < 3) continue;
      if (pip(x, z, f.p)) { const e = seen.get(f) || { k: f.k, n: f.p.length, first: k, last: k, offs: new Set() }; e.last = k; e.offs.add(off); seen.set(f, e); }
    }
  }
}
console.log(id, 'pit side', side, 'K', (pit.to - pit.from + N) % N, 'entry k', (pit.entry - pit.from + N) % N, 'exit k', (pit.exit - pit.from + N) % N, 'counts', JSON.stringify(sc.stats.counts));
for (const [f, e] of seen) console.log('  ', e.k, 'n', e.n, 'k', e.first, '..', e.last, 'behind face at', [...e.offs].join(','), 'm');
