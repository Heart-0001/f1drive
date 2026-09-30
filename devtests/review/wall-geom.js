// Where are wall vertices closer than 9 m to a centreline sample? (drawn wall inside kerb/road, clamped by fold-over)
const { F1, TRACKS } = require('./load');
for (const td of TRACKS) {
  const track = F1.buildTrack(td);
  const S = track.samples, N = S.length;
  const mesh = track.group.children.find(m => m.name === 'walls');
  const pos = mesh.geometry.attributes.position.array;
  const spots = new Map();
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], z = pos[i + 2];
    let best = Infinity, bi = 0;
    for (let k = 0; k < N; k++) { const dx = S[k].x - x, dz = S[k].z - z; const d = dx * dx + dz * dz; if (d < best) { best = d; bi = k; } }
    best = Math.sqrt(best);
    if (best < 9) { const key = Math.round(bi / 20) * 20; const cur = spots.get(key); if (!cur || best < cur) spots.set(key, best); }
  }
  if (spots.size) {
    console.log(td.name, '(N=' + N + ')');
    for (const [k, v] of [...spots].sort((a, b) => a[0] - b[0])) console.log('   sample ~' + k + ' (' + (k * 2) + ' m): wall at ' + v.toFixed(2) + ' m from centreline');
  }
  track.dispose();
}
