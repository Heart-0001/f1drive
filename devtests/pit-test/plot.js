// node devtests/pit-test/plot.js [id,id,...|all] [whole|entry|exit|all]
//
// Top view of the pit complex of js/track.js as SVG (devtests/pit-test/out/plot-<id>[-entry|-exit].svg), drawn from
// the exported data only: road (+-halfW), the track walls (wallPosDist / wallNegDist where flagged), every other
// part of the circuit in the picture, the pit asphalt (pit.paved scanned across), the lane centre (pit.laneD), the
// pit wall (pit.wallD +- wallHalfT), the 16 boxes (a 2 x 5.5 m car at each stopping position, numbered 1..16), the
// entry (amber) and exit (green) lines. The line of the lap is the dashed black line. The lane's overall direction
// points to the right (not mirrored: +n, the driver's left, is up). Prints the names written; render them to PNG with
// npx electron devtests/pit-test/svg2png.js <names> (or open the SVG in any viewer).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const want = (process.argv[2] || 'it-1922,mc-1929,jp-1962,be-1925,us-2023').split(',');
const views = (process.argv[3] || 'all') === 'all' ? ['whole', 'entry', 'exit'] : [process.argv[3]];
const tracks = want[0] === 'all' ? window.F1_TRACKS : window.F1_TRACKS.filter(t => want.some(w => t.id === w || t.name.toLowerCase().includes(w)));

function plot(td, view) {
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N, pit = tr.pit;
  if (!pit) return null;
  const wq = q => ((q % N) + N) % N;
  const kOf = i => wq(i - pit.from);
  const K = kOf(pit.to);
  // window along the lane (sample offsets from pit.from)
  let k0 = -20, k1 = K + 20;
  if (view === 'entry') { k0 = -15; k1 = kOf(pit.entry) + 25; }
  if (view === 'exit') { k0 = kOf(pit.exit) - 25; k1 = K + 15; }
  // frame: the lane's middle sample, t to the right, n up
  const mid = S[wq(pit.from + Math.round((k0 + k1) / 2))];
  const ang = Math.atan2(mid.tz, mid.tx);
  const rot = (x, z) => { const dx = x - mid.x, dz = z - mid.z; return [dx * Math.cos(-ang) - dz * Math.sin(-ang), dx * Math.sin(-ang) + dz * Math.cos(-ang)]; };
  // a top view that is not mirrored: world z points down the picture, so +n (the driver's left) is up
  const P = (x, z) => { const r = rot(x, z); return [r[0], -r[1]]; };
  const at = (i, d) => [S[i].x + S[i].nx * d, S[i].z + S[i].nz * d];
  // bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let k = k0; k <= k1; k++) {
    const i = wq(pit.from + k);
    for (const d of [-S[i].wallNegDist - 2, S[i].wallPosDist + 2]) {
      const p = P(...at(i, d)); minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
  }
  const pad = 6; minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const scale = Math.min(12, 2400 / (maxX - minX));
  const W = Math.round((maxX - minX) * scale), H = Math.round((maxY - minY) * scale);
  const X = p => ((p[0] - minX) * scale).toFixed(1), Y = p => ((maxY - p[1]) * scale).toFixed(1);
  const pts = arr => arr.map(p => X(p) + ',' + Y(p)).join(' ');
  const inView = (x, z) => { const p = P(x, z); return p[0] >= minX - 30 && p[0] <= maxX + 30 && p[1] >= minY - 30 && p[1] <= maxY + 30; };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#5a8a4a"/>`;
  // every piece of road in view (runs of consecutive samples)
  const runs = []; let cur = null;
  for (let i = 0; i < N; i++) { if (inView(S[i].x, S[i].z)) { if (!cur) { cur = [i]; runs.push(cur); } else cur.push(i); } else cur = null; }
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][runs[runs.length - 1].length - 1] === N - 1) runs[0] = runs.pop().concat(runs[0]);
  for (const run of runs) {
    const L = run.map(i => P(...at(i, S[i].halfW))), R = run.map(i => P(...at(i, -S[i].halfW)));
    const WP = run.map(i => P(...at(i, S[i].wallPosDist))), WN = run.map(i => P(...at(i, -S[i].wallNegDist)));
    svg += `<polygon points="${pts(WP.concat(WN.slice().reverse()))}" fill="#8b8f86"/>`;
    svg += `<polygon points="${pts(L.concat(R.slice().reverse()))}" fill="#333336"/>`;
    for (const [flag, arr] of [['wallPos', WP], ['wallNeg', WN]]) {
      let seg = [];
      run.forEach((i, j) => { if (S[i][flag]) seg.push(arr[j]); else { if (seg.length > 1) svg += `<polyline points="${pts(seg)}" fill="none" stroke="#d0201c" stroke-width="${Math.max(1, 0.5 * scale)}"/>`; seg = []; } });
      if (seg.length > 1) svg += `<polyline points="${pts(seg)}" fill="none" stroke="#d0201c" stroke-width="${Math.max(1, 0.5 * scale)}"/>`;
    }
  }
  // pit asphalt: scan paved() across each lane sample
  const sg = pit.side;
  const lo = [], hi = [];
  for (let k = Math.max(0, k0); k <= Math.min(K, k1); k++) {
    const i = wq(pit.from + k); let a = null, b = null;
    for (let d = 0; d <= 40; d += 0.1) if (pit.paved(i, sg * d)) { if (a === null) a = d; b = d; }
    if (a !== null) { lo.push(P(...at(i, sg * a))); hi.push(P(...at(i, sg * b))); }
  }
  if (lo.length > 1) svg += `<polygon points="${pts(lo.concat(hi.slice().reverse()))}" fill="#45454a"/>`;
  // pit wall
  const wl = [], wr = [];
  for (let k = Math.max(0, k0); k <= Math.min(K, k1); k++) {
    const i = wq(pit.from + k), w = pit.wallD(i);
    if (!isFinite(w)) { if (wl.length > 1) svg += `<polygon points="${pts(wl.concat(wr.slice().reverse()))}" fill="#f0f0f0" stroke="#111" stroke-width="0.6"/>`; wl.length = wr.length = 0; continue; }
    wl.push(P(...at(i, w - pit.wallHalfT))); wr.push(P(...at(i, w + pit.wallHalfT)));
  }
  if (wl.length > 1) svg += `<polygon points="${pts(wl.concat(wr.slice().reverse()))}" fill="#f0f0f0" stroke="#111" stroke-width="0.6"/>`;
  // lane centre
  const lc = [];
  for (let k = Math.max(0, k0); k <= Math.min(K, k1); k++) { const i = wq(pit.from + k); lc.push(P(...at(i, pit.laneD(i)))); }
  svg += `<polyline points="${pts(lc)}" fill="none" stroke="#ffffff" stroke-width="1" stroke-dasharray="6,6"/>`;
  // entry / exit lines, the line of the lap
  for (const [idx, col] of [[pit.entry, '#ffa01e'], [pit.exit, '#24ff6e']]) {
    const i = idx; let a = null, b = null;
    for (let d = 0; d <= 40; d += 0.1) if (pit.inLane(i, sg * d)) { if (a === null) a = d; b = d; }
    if (a !== null) svg += `<line x1="${X(P(...at(i, sg * a)))}" y1="${Y(P(...at(i, sg * a)))}" x2="${X(P(...at(i, sg * b)))}" y2="${Y(P(...at(i, sg * b)))}" stroke="${col}" stroke-width="${Math.max(2, 0.8 * scale)}"/>`;
  }
  { const a = P(...at(0, -S[0].wallNegDist)), b = P(...at(0, S[0].wallPosDist)); svg += `<line x1="${X(a)}" y1="${Y(a)}" x2="${X(b)}" y2="${Y(b)}" stroke="#000" stroke-width="2" stroke-dasharray="4,3"/>`; }
  // boxes: the car's footprint at each stopping position
  for (const b of pit.boxes) {
    const fx = Math.sin(b.heading), fz = Math.cos(b.heading), lx = Math.cos(b.heading), lz = -Math.sin(b.heading);
    const c = [[2.8, 1], [2.8, -1], [-2.7, -1], [-2.7, 1]].map(([a, l]) => P(b.x + fx * a + lx * l, b.z + fz * a + lz * l));
    const pc = P(b.x, b.z);
    if (pc[0] < minX || pc[0] > maxX) continue;
    svg += `<polygon points="${pts(c)}" fill="${b.slot === 2 || b.slot === 13 ? '#e10600' : '#1e6bff'}" stroke="#fff" stroke-width="0.5"/>`;
    svg += `<text x="${X(pc)}" y="${(+Y(pc) + 4 * Math.min(1, scale / 4)).toFixed(1)}" font-size="${Math.max(8, 2.2 * scale)}" fill="#fff" text-anchor="middle" font-family="sans-serif">${b.slot + 1}</text>`;
  }
  const m2 = x => Math.round(x * ds);
  const rel = i => { const q = i > N / 2 ? i - N : i; return m2(q); };
  svg += `<text x="8" y="18" font-size="16" fill="#fff" font-family="sans-serif">${td.id} ${td.name} — ${view}: side ${sg > 0 ? '+n (left)' : '-n (right)'}, ${pit.limitKmh} km/h, from ${rel(pit.from)} m, entry ${rel(pit.entry)} m, exit ${rel(pit.exit)} m, to ${rel(pit.to)} m, ${scale.toFixed(1)} px/m</text>`;
  svg += '</svg>';
  const name = 'plot-' + td.id + (view === 'whole' ? '' : '-' + view);
  fs.writeFileSync(path.join(OUT, name + '.svg'), svg);
  tr.dispose();
  return name;
}

const made = [];
for (const td of tracks) for (const v of views) { const n = plot(td, v); if (n) made.push(n); }
console.log(made.join(','));
