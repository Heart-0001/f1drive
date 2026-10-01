// Adversarial: ram / hold-steer into the sides from many starts. Checks per step:
//  - never beyond a flagged wall (|d| > wallDist-1 + 0.02)
//  - sampleIndex never stale: located sample is (nearly) the globally nearest one
//  - never "outside": beyond wall distance at a sample with no wall flag, unless on a crossing track near the crossing
const { F1, TRACKS } = require('./load');
const DT = 1 / 120;
const only = process.argv[2];
const starts = +(process.argv[3] || 24);
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
let tot = { through: 0, stale: 0, outside: 0 };
for (const td of TRACKS) {
  if (only && !td.name.toLowerCase().includes(only.toLowerCase())) continue;
  const track = F1.buildTrack(td);
  const S = track.samples, N = S.length;
  const car = F1.createCar(); const st = car.state;
  let through = 0, stale = 0, outside = 0, maxStaleRun = 0, hits = 0, resyncJumps = 0, ex = [];
  // (v6.2: at a bridge - Suzuka, track.bridges - the other road passes 6 m above / below: within 40 samples of the
  //  crossing a sample of a road the car is not at the height of (more than half the separation away) is not "nearer")
  const bridges = track.bridges || [];
  function otherLevel(j, y) {
    for (const B of bridges) {
      const near = q => { const k = Math.abs(j - q); return Math.min(k, N - k) <= 40; };
      if ((near(B.up) || near(B.lo)) && Math.abs(S[j].y - y) > B.separation / 2) return true;
    }
    return false;
  }
  function nearest(x, z, y) { let b = 0, bd = Infinity; for (let j = 0; j < N; j++) { if (bridges.length && y !== undefined && otherLevel(j, y)) continue; const d = (S[j].x - x) ** 2 + (S[j].z - z) ** 2; if (d < bd) { bd = d; b = j; } } return { j: b, d: Math.sqrt(bd) }; }
  for (let sIdx = 0; sIdx < starts; sIdx++) {
    const start = Math.floor(sIdx * N / starts);
    for (const mode of ['ramLeft', 'ramRight', 'holdLeft', 'holdRight', 'ramLeft45', 'ramRight45', 'reverseLeft', 'zigzag']) {
      car.reset(track, start);
      let t = 0, launched = false, staleRun = 0, step = 0, prevIdx = st.sampleIndex;
      const inp = { up: true, down: false, left: false, right: false };
      while (t < 25) {
        const v = st.speed;
        if (mode.startsWith('hold')) { inp.left = mode === 'holdLeft'; inp.right = !inp.left; }
        else if (mode === 'reverseLeft') { inp.up = false; inp.down = true; inp.left = t > 3; }
        else if (mode === 'zigzag') { inp.left = Math.floor(t / 2.5) % 2 === 0; inp.right = !inp.left; }
        else {
          const sgn = mode.includes('Left') ? 1 : -1;
          if (!launched) {
            const s = S[st.sampleIndex];
            const err = wrapPi(Math.atan2(s.tx, s.tz) - st.heading);
            inp.left = err > 0.02; inp.right = err < -0.02;
            if (v > (mode.endsWith('45') ? 40 : 75) || t > 12) launched = true;
          } else { inp.left = sgn > 0; inp.right = sgn < 0; }
        }
        car.update(DT, inp, track); t += DT; step++;
        if (st.hit > 0) hits++;
        const s = S[st.sampleIndex];
        const flag = st.d > 0 ? s.wallPos : s.wallNeg, wd = st.d > 0 ? s.wallPosDist : s.wallNegDist;
        if (!Number.isFinite(st.x + st.z + st.y + st.pitch + st.roll + st.speed)) { through++; ex.push('NaN'); break; }
        if (flag && Math.abs(st.d) > wd - 1 + 0.02) { through++; if (ex.length < 5) ex.push({ what: 'through', mode, start, idx: st.sampleIndex, d: +st.d.toFixed(2), wd: +wd.toFixed(2) }); }
        if (!flag && Math.abs(st.d) > wd + 0.5) { outside++; if (ex.length < 5) ex.push({ what: 'outside', mode, start, idx: st.sampleIndex, d: +st.d.toFixed(2) }); }
        let di = Math.abs(st.sampleIndex - prevIdx); di = Math.min(di, N - di); if (di > 45) resyncJumps++;
        prevIdx = st.sampleIndex;
        if (step % 4 === 0) {
          const g = nearest(st.x, st.z, st.y), dl = Math.hypot(st.x - s.x, st.z - s.z);
          if (dl - g.d > 3) { staleRun += 4; if (staleRun > maxStaleRun) maxStaleRun = staleRun; } else staleRun = 0;
          if (staleRun * DT > 1.0) { stale++; if (ex.length < 5) ex.push({ what: 'stale', mode, start, idx: st.sampleIndex, near: g.j, dl: +dl.toFixed(1), gd: +g.d.toFixed(1) }); staleRun = 0; }
        }
      }
      // final state must be on/inside the track (v6: beside the pit lane, track.pit, the walls on its side stand further
      // out: the lane, the boxes and the garage face)
      const g = nearest(st.x, st.z, st.y), pit = track.pit;
      const inPit = !!pit && Number.isFinite(pit.laneD(g.j)) && Math.sign(st.d) === pit.side &&
        g.d <= (pit.side > 0 ? S[g.j].wallPosDist : S[g.j].wallNegDist);
      if (g.d > 13 && !inPit) { outside++; if (ex.length < 5) ex.push({ what: 'endsOutside', mode, start, idx: st.sampleIndex, gd: +g.d.toFixed(1) }); }
    }
  }
  tot.through += through; tot.stale += stale; tot.outside += outside;
  console.log(td.name.slice(0, 40).padEnd(41), 'through', through, 'stale', stale, 'outside', outside, 'maxStale(s)', (maxStaleRun * DT).toFixed(2), 'wallHitSteps', hits, 'indexJumps', resyncJumps);
  for (const e of ex) console.log('     ', JSON.stringify(e));
  track.dispose();
}
console.log('TOTAL', JSON.stringify(tot));
