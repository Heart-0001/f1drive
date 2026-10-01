// node devtests/review-1/verify-world/bank.js
// Max |bank| per track, and for the tracks with famous banked corners the bank through their banked corners
// (located from lat/lon through td.geo: x = (lon - lon0) * kx, z = (lat - lat0) * kz).
const L = require('./load.js');
const F1 = L.F1;
const deg = r => (r * 180 / Math.PI);
// approximate apex coordinates (lat, lon) of the real banked corners
const CORNERS = {
  'nl-1948': [['T3 Hugenholtz (19 deg real)', 52.3888, 4.5453], ['T14 Luyendyk (18 deg real)', 52.3868, 4.5392]],
  'us-1909': [['oval T1 = F1 T13 (9 deg real)', 39.7930, -86.2345]],
  'sa-2021': [['T13 (12 deg real)', 21.6280, 39.1060]]
};
let all = [];
for (const td of L.TRACKS) {
  const keys = Object.keys(td).filter(k => /bank|camber/i.test(k));
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length;
  let bmax = 0, imax = 0;
  for (let i = 0; i < N; i++) if (Math.abs(S[i].bank) > bmax) { bmax = Math.abs(S[i].bank); imax = i; }
  all.push([td.id, deg(bmax)]);
  if (CORNERS[td.id]) {
    const g = td.geo;
    for (const [name, lat, lon] of CORNERS[td.id]) {
      const x = (lon - g.lon0) * g.kx, z = (lat - g.lat0) * g.kz, n = tr.nearest(x, z);
      // max |bank| within +-60 m of the nearest sample to that coordinate
      let b = 0, ds = tr.length / N, w = Math.round(60 / ds);
      for (let q = -w; q <= w; q++) b = Math.max(b, Math.abs(S[((n.index + q) % N + N) % N].bank));
      console.log(`${td.id} ${name}: nearest sample ${n.index} at ${n.dist.toFixed(0)} m from the given coordinate; max |bank| within 60 m = ${deg(b).toFixed(2)} deg`);
    }
    console.log(`${td.id} whole lap: max |bank| ${deg(bmax).toFixed(2)} deg at sample ${imax}; banking fields in tracks-data: ${keys.length ? keys.join(',') : 'none'}`);
  }
  tr.dispose();
}
all.sort((a, b) => b[1] - a[1]);
console.log('max |bank| over all 40 tracks: ' + all[0][1].toFixed(2) + ' deg (' + all[0][0] + '); min of the per-track maxima: ' + all[all.length - 1][1].toFixed(2) + ' deg (' + all[all.length - 1][0] + ')');
