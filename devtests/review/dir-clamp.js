const { F1, TRACKS } = require('./load');
// 1) racing direction: signed area in (east, north) = (x, -z). positive => anticlockwise.
const KNOWN = { // true = clockwise
  'au-1953': true, 'pt-1972': true, 'it-1953': false, 'mx-1962': true, 'pt-2008': true, 'br-1977': false, 'it-1914': true,
  'br-1940': false, 'it-1922': true, 'ar-1952': true, 'bh-2002': true, 'az-2016': false, 'es-1991': true, 'mc-1929': true,
  'fr-1960': true, 'be-1925': true, 'ca-1978': true, 'us-2012': false, 'fr-1969': true, 'nl-1948': true, 'de-1932': true,
  'hu-1986': true, 'us-1909': true, 'tr-2005': false, 'sa-2021': false, 'za-1961': true, 'us-2023': false, 'qa-2004': true,
  'sg-2008': false, 'us-2022': true, 'de-1927': true, 'at-1969': true, 'my-1999': true, 'cn-2004': true, 'gb-1948': true,
  'ru-2014': true, 'us-1956': true, 'ae-2009': false
};
for (const td of TRACKS) {
  const p = td.points; let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * (-r[1]) - r[0] * (-q[1]); }
  const cw = a < 0;
  const known = KNOWN[td.id];
  console.log(td.id.padEnd(8), td.name.padEnd(42), 'data:', cw ? 'CW ' : 'ACW', known === undefined ? '(unknown)' : (known === cw ? 'ok' : '*** MISMATCH (real: ' + (known ? 'CW' : 'ACW') + ')'));
}
// 2) drawn wall inner face lateral offset vs collision limit (11 m) where wall flag is set
console.log('\nWalls drawn inside the collision limit (car can drive through the visible wall):');
for (const td of TRACKS) {
  const track = F1.buildTrack(td); const S = track.samples, N = S.length;
  const mesh = track.group.children.find(m => m.name === 'walls');
  const pos = mesh.geometry.attributes.position.array;
  let cnt = 0, minOff = 99; const spots = new Set();
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1] !== 0) continue;
    const x = pos[i], z = pos[i + 2];
    let best = Infinity, bi = 0;
    for (let k = 0; k < N; k++) { const dx = S[k].x - x, dz = S[k].z - z; const d = dx * dx + dz * dz; if (d < best) { best = d; bi = k; } }
    const lat = (x - S[bi].x) * S[bi].nx + (z - S[bi].z) * S[bi].nz;
    const flag = lat > 0 ? S[bi].wallPos : S[bi].wallNeg;
    if (flag && Math.abs(lat) < 11.0) { cnt++; spots.add(Math.round(bi / 25) * 25); if (Math.abs(lat) < minOff) minOff = Math.abs(lat); }
  }
  if (cnt) console.log('  ' + td.name.padEnd(42), 'verts:', cnt, 'min offset', minOff.toFixed(1), 'm; near samples', [...spots].sort((a, b) => a - b).join(','));
  track.dispose();
}
