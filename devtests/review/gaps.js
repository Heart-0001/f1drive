// Print wall gap ranges and nearest other-section samples for tracks with gaps; trace specific escapes.
const { F1, TRACKS } = require('./load');
const DT = 1 / 60;
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function gapRuns(S, key) {
  const N = S.length, out = []; let start = -1;
  for (let k = 0; k < 2 * N; k++) { const i = k % N; const v = S[i][key]; if (!v && start < 0) start = k; if (v && start >= 0) { if (start < N) out.push([start % N, k - start]); start = -1; } }
  return out;
}
function nearestOther(S, i) {
  const N = S.length; let best = Infinity, bj = -1;
  for (let j = 0; j < N; j++) { let dd = Math.abs(j - i); dd = Math.min(dd, N - dd); if (dd < 60) continue; const d = Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z); if (d < best) { best = d; bj = j; } }
  return { d: best, j: bj };
}
for (const name of ['Baku', 'Monaco', 'Suzuka']) {
  const td = TRACKS.find(t => t.name.includes(name));
  const track = F1.buildTrack(td); const S = track.samples, N = track.samples.length;
  console.log('==', td.name, 'N=' + N);
  for (const key of ['wallPos', 'wallNeg']) for (const g of gapRuns(S, key)) {
    const mid = (g[0] + (g[1] >> 1)) % N; const no = nearestOther(S, mid);
    console.log('  ', key, 'gap samples', g[0], '..', (g[0] + g[1]) % N, '(' + g[1] * 2 + ' m)', 'nearest other section at mid:', no.d.toFixed(1), 'm, sample', no.j);
  }
  track.dispose();
}

// Trace: Monaco start 0, ramRight
{
  const td = TRACKS.find(t => t.name.includes('Monaco'));
  const track = F1.buildTrack(td); const S = track.samples, N = S.length;
  const car = F1.createCar(); const st = car.state; car.reset(track, 0);
  let t = 0, launched = false; const inp = { up: true, down: false, left: false, right: false };
  let log = [];
  while (t < 20) {
    if (!launched) { const s = S[st.sampleIndex]; const err = wrapPi(Math.atan2(s.tx, s.tz) - st.heading); inp.left = err > 0.02; inp.right = err < -0.02; if (st.speed > 75 || t > 12) launched = true; }
    else { inp.left = false; inp.right = true; }
    car.update(DT, inp, track); t += DT;
    if (Math.abs(st.d) > 10.5) log.push(t.toFixed(2) + ' idx=' + st.sampleIndex + ' d=' + st.d.toFixed(2) + ' wp=' + (S[st.sampleIndex].wallPos ? 1 : 0) + ' wn=' + (S[st.sampleIndex].wallNeg ? 1 : 0) + ' v=' + (st.speed * 3.6).toFixed(0) + ' hit=' + st.hit.toFixed(2));
  }
  console.log('Monaco ramRight trace (|d|>10.5):'); console.log(log.slice(0, 40).join('\n')); console.log('...'); console.log(log.slice(-15).join('\n'));
  track.dispose();
}
