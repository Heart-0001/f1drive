// 1) Monaco: detailed trace of ramRight from start 0 where |d| > 11.3 (possible push-through)
// 2) Baku: drive through the wall gap onto the parallel section and keep driving along it; see what locate/d/onGrass do,
//    and whether R (reset to sampleIndex) recovers.
const { F1, TRACKS } = require('./load');
const DT = 1 / 60;
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
{
  const td = TRACKS.find(t => t.name.includes('Monaco'));
  const track = F1.buildTrack(td); const S = track.samples, N = S.length;
  const car = F1.createCar(); const st = car.state; car.reset(track, 0);
  let t = 0, launched = false; const inp = { up: true, down: false, left: false, right: false };
  let prev = null, printed = 0;
  while (t < 20) {
    if (!launched) { const s = S[st.sampleIndex]; const err = wrapPi(Math.atan2(s.tx, s.tz) - st.heading); inp.left = err > 0.02; inp.right = err < -0.02; if (st.speed > 75 || t > 12) launched = true; }
    else { inp.left = false; inp.right = true; }
    const before = { x: st.x, z: st.z, idx: st.sampleIndex, d: st.d, h: st.heading };
    car.update(DT, inp, track); t += DT;
    if (Math.abs(st.d) > 11.3 && printed < 30) { printed++; console.log('MONACO t=' + t.toFixed(2), 'idx', before.idx, '->', st.sampleIndex, 'd', before.d.toFixed(2), '->', st.d.toFixed(2), 'wn', S[st.sampleIndex].wallNeg ? 1 : 0, 'wp', S[st.sampleIndex].wallPos ? 1 : 0, 'v', (st.speed * 3.6).toFixed(0), 'pos', st.x.toFixed(1), st.z.toFixed(1)); }
  }
  // geometry around 195-215: the two legs of the hairpin
  for (const i of [150, 160, 170, 180, 190, 200, 205, 210, 215, 220, 230]) {
    let best = Infinity, bj = -1; for (let j = 0; j < N; j++) { let dd = Math.abs(j - i); dd = Math.min(dd, N - dd); if (dd < 40) continue; const d = Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z); if (d < best) { best = d; bj = j; } }
    console.log('  Monaco sample', i, 'wallPos', S[i].wallPos, 'wallNeg', S[i].wallNeg, 'nearest other', bj, best.toFixed(1), 'tangent dot', (S[i].tx * S[bj].tx + S[i].tz * S[bj].tz).toFixed(2));
  }
  track.dispose();
}
{
  const td = TRACKS.find(t => t.name.includes('Baku'));
  const track = F1.buildTrack(td); const S = track.samples, N = S.length;
  console.log('BAKU 1115 vs 2373 tangent dot:', (S[1115].tx * S[2373].tx + S[1115].tz * S[2373].tz).toFixed(2), 'dist', Math.hypot(S[1115].x - S[2373].x, S[1115].z - S[2373].z).toFixed(1));
  const car = F1.createCar(); const st = car.state; car.reset(track, 1060);
  const inp = { up: true, down: false, left: true, right: false };
  let t = 0;
  // phase 1: turn left until |d| > 15 (crossed onto other section), then phase 2: follow the OTHER section's tangent (global nearest)
  let phase = 1;
  function globalNearest(x, z) { let b = 0, bd = Infinity; for (let j = 0; j < N; j++) { const d = (S[j].x - x) ** 2 + (S[j].z - z) ** 2; if (d < bd) { bd = d; b = j; } } return { j: b, d: Math.sqrt(bd) }; }
  while (t < 40) {
    if (phase === 1) { inp.left = true; inp.right = false; inp.up = st.speed < 15; if (st.d > 15) phase = 2; }
    else {
      const g = globalNearest(st.x, st.z); const s = S[g.j];
      const des = Math.atan2(s.tx, s.tz); const err = wrapPi(des - st.heading); inp.left = err > 0.02; inp.right = err < -0.02; inp.up = st.speed < 30; inp.down = false;
    }
    car.update(DT, inp, track); t += DT;
    if (Math.round(t * 60) % 60 === 0) { const g = globalNearest(st.x, st.z); console.log('BAKU t=' + t.toFixed(0), 'phase', phase, 'sampleIndex', st.sampleIndex, 'd', st.d.toFixed(1), 'onGrass', st.onGrass, 'v', (st.speed * 3.6).toFixed(0), '| true nearest', g.j, 'dist', g.d.toFixed(1)); }
  }
  // R reset now:
  car.reset(track, st.sampleIndex);
  console.log('after R: idx', st.sampleIndex, 'x,z', st.x.toFixed(1), st.z.toFixed(1));
  track.dispose();
}
