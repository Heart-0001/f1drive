// node devtests/review-1/verify-world/kerb-taper.js
// Kerb paint (red / white triangles of the 'paint' mesh at the kerb strip halfW..halfW+1.3 on the pit side) lying on the
// pit lane's asphalt (pit.paved) within from..to, per track; plus the width of the lane asphalt beyond the road edge
// at k = 0 and k = K (reconstructed from pit.paved by scanning outward).
const L = require('./load.js');
const F1 = L.F1;
let tot = 0;
for (const td of L.TRACKS) {
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, p = tr.pit;
  if (!p) continue;
  const sg = p.side, wq = q => ((q % N) + N) % N, K = wq(p.to - p.from);
  const paint = tr.group.children.find(m => m.name === 'paint');
  const P = paint.geometry.attributes.position.array, C = paint.geometry.attributes.color.array;
  let red = 0, white = 0; const ks = new Set();
  for (let t = 0; t < P.length; t += 9) {
    const cx = (P[t] + P[t + 3] + P[t + 6]) / 3, cz = (P[t + 2] + P[t + 5] + P[t + 8]) / 3;
    const n = tr.nearest(cx, cz), k = wq(n.index - p.from);
    if (k > K) continue;
    const a = n.d * sg, s = S[n.index];
    if (a <= s.halfW + 0.05 || a > s.halfW + 1.3) continue;       // kerb strip band only
    if (!p.paved(n.index, n.d)) continue;
    // kerb colours: red d0201c (0.816,0.125,0.11 in linear? stored as given) / white f2f2f2; lane lines are white too,
    // so count white only where a red kerb triangle shares the sample
    const r = C[t], g = C[t + 1], b = C[t + 2];
    if (r > 0.6 && g < 0.3 && b < 0.3) { red++; ks.add(k); }
  }
  // lane asphalt width beyond the road edge at the ends
  function pavedW(k) {
    const i = wq(p.from + k), s = S[i]; let w = 0;
    for (let a = s.halfW + 0.01; a < s.halfW + 30; a += 0.02) { if (p.paved(i, sg * a)) w = a - s.halfW; else if (w) break; }
    return w;
  }
  if (red) {
    const arr = [...ks].sort((x, y) => x - y);
    console.log(`${td.id.padEnd(8)} red kerb triangles on pit asphalt: ${String(red).padStart(3)} at lane samples k=${arr.join(',')} (K=${K}, kEn=${wq(p.entry - p.from)}, kEx=${wq(p.exit - p.from)}); asphalt beyond edge at k=0: ${pavedW(0).toFixed(2)} m, k=1: ${pavedW(1).toFixed(2)} m, k=K: ${pavedW(K).toFixed(2)} m`);
    tot++;
  }
  tr.dispose();
}
console.log('tracks with kerb paint on the pit asphalt:', tot);
