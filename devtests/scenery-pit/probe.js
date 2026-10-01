// node devtests/scenery-pit/probe.js : per track, OSM pit buildings (count, area, which side of the start line) vs track.pit
const path = require('path').resolve(__dirname, '..', '..') + '/';
global.window = global; global.THREE = require(path + 'lib/three.min.js');
require(path + 'tracks-data.js'); require(path + 'scenery-data.js'); require(path + 'js/track.js');
for (const td of F1_TRACKS) {
  const tr = F1.buildTrack(td), pit = tr.pit, d = F1_SCENERY[td.id], N = tr.samples.length, ds = tr.length / N;
  let pits = 0, area = 0, sides = { '1': 0, '-1': 0 }, inC = 0, near = 0;
  if (d) for (const b of d.buildings) {
    if (b.k !== 'pit') continue;
    pits++;
    let cx = 0, cz = 0, a = 0; const p = b.p;
    for (let e = 0; e < p.length; e++) { const q = p[(e + 1) % p.length]; a += p[e][0] * q[1] - q[0] * p[e][1]; cx += p[e][0]; cz += p[e][1]; }
    cx /= p.length; cz /= p.length; a = Math.abs(a / 2); area += a;
    const n = tr.nearest(cx, cz); const off = n.index > N / 2 ? n.index - N : n.index;
    if (Math.abs(off * ds) < 460 && n.dist < 200) { near++; sides[n.d > 0 ? 1 : -1] += a; }
    let c = 0; for (const q of p) if (tr.inCorridor(q[0], q[1], 1.5)) c++;
    if (c) inC++;
  }
  const rel = i => Math.round((i > N / 2 ? i - N : i) * ds);
  console.log(td.id.padEnd(8), (td.name || '').slice(0, 22).padEnd(22), 'osmPit', String(pits).padStart(2), 'near', String(near).padStart(2),
    'areaSide+', Math.round(sides[1]), 'areaSide-', Math.round(sides[-1]), 'withVertsInCorr', inC,
    pit ? ('| pit side ' + pit.side + ' from ' + rel(pit.from) + ' to ' + rel(pit.to) + ' en ' + rel(pit.entry) + ' ex ' + rel(pit.exit) + ' WP0 ' + (pit.side > 0 ? tr.samples[0].wallPosDist : tr.samples[0].wallNegDist).toFixed(1)) : '| NO PIT');
  tr.dispose();
}
