// Road/edge-line pinch: min lateral offset of the road mesh's outer edge vertices around given samples.
const { F1, TRACKS } = require('./load');
for (const [name, around] of [['Albert Park', 2050], ['Madring', 660], ['Magny-Cours', 2080], ['Monaco', 180]]) {
  const td = TRACKS.find(t => t.name.includes(name));
  const track = F1.buildTrack(td); const S = track.samples, N = S.length;
  const road = track.group.children.find(m => m.name === 'road').geometry.attributes.position.array;
  let minPos = 99, minNeg = 99, at = -1;
  for (let i = 0; i < road.length; i += 3) {
    const x = road[i], z = road[i + 2];
    let best = Infinity, bi = 0;
    for (let k = around - 60; k <= around + 60; k++) { const kk = (k + N) % N; const dx = S[kk].x - x, dz = S[kk].z - z; const d = dx * dx + dz * dz; if (d < best) { best = d; bi = kk; } }
    if (best > 15 * 15) continue;
    const lat = (x - S[bi].x) * S[bi].nx + (z - S[bi].z) * S[bi].nz;
    if (lat > 1 && lat < minPos) { minPos = lat; at = bi; }
    if (lat < -1 && -lat < minNeg) minNeg = -lat;
  }
  // local corner radius around 'around'
  let maxC = 0; const ds = track.length / N;
  for (let i = around - 40; i <= around + 40; i++) { const a = S[(i - 2 + N) % N], b = S[(i + 2 + N) % N], s = S[(i + N) % N]; const c = Math.abs((b.tx - a.tx) * s.nx + (b.tz - a.tz) * s.nz) / (4 * ds); if (c > maxC) maxC = c; }
  console.log(td.name, 'around sample', around, ': road edge min offset +side', minPos.toFixed(2), '-side', minNeg.toFixed(2), '(nominal 7.00); local min corner radius', (1 / maxC).toFixed(1), 'm; wall flags at', around, S[around].wallPos, S[around].wallNeg);
  track.dispose();
}
