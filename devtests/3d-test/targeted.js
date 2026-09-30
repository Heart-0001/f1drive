const { F1, TRACKS } = require('./load');
const DT = 1 / 120;
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function nearestOther(S, i) { const N = S.length; let best = Infinity, bj = -1; for (let j = 0; j < N; j++) { let dd = Math.abs(j - i); dd = Math.min(dd, N - dd); if (dd < 60) continue; const d = Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z); if (d < best) { best = d; bj = j; } } return { d: best, j: bj }; }
function nearest(S, x, z) { let b = 0, bd = Infinity; for (let j = 0; j < S.length; j++) { const d = (S[j].x - x) ** 2 + (S[j].z - z) ** 2; if (d < bd) { bd = d; b = j; } } return { j: b, d: Math.sqrt(bd) }; }
for (const name of ['Baku', 'Monaco']) {
  const td = TRACKS.find(t => t.name.includes(name));
  const track = F1.buildTrack(td); const S = track.samples, N = S.length;
  // stretches with a shared (pulled-in) wall
  const runs = []; let cur = null;
  for (let i = 0; i < N; i++) {
    const m = Math.min(S[i].wallPosDist, S[i].wallNegDist);
    if (m < 11.5) { if (!cur) runs.push(cur = { a: i, b: i, min: m, side: 0 }); cur.b = i; if (m <= cur.min) { cur.min = m; cur.side = S[i].wallPosDist < S[i].wallNegDist ? 1 : -1; cur.at = i; } } else cur = null;
  }
  console.log('==', td.name, 'N', N);
  for (const r of runs) {
    const no = nearestOther(S, r.at);
    let res = [];
    for (const v0 of [10, 30, 60]) for (const off of [-30, -10, 0]) {
      const car = F1.createCar(), st = car.state; car.reset(track, (r.at + off + N) % N);
      st.speed = v0; let t = 0, maxOver = -9, stale = 0, hit = 0;
      const inp = { up: true, left: r.side > 0, right: r.side < 0 };
      while (t < 12) {
        car.update(DT, inp, track); t += DT; if (st.hit) hit++;
        const s = S[st.sampleIndex], wd = st.d > 0 ? s.wallPosDist : s.wallNegDist, fl = st.d > 0 ? s.wallPos : s.wallNeg;
        maxOver = Math.max(maxOver, Math.abs(st.d) - (wd - 1)); if (!fl && Math.abs(st.d) > wd) maxOver = 99;
        const g = nearest(S, st.x, st.z); if (Math.hypot(st.x - s.x, st.z - s.z) - g.d > 2) stale++;
      }
      res.push(`v${v0}/o${off}: over ${maxOver.toFixed(3)} stale ${stale} hits ${hit}`);
    }
    console.log(`  samples ${r.a}-${r.b} (${(r.b - r.a) * 2} m) min wall ${r.min.toFixed(2)} on ${r.side > 0 ? '+n' : '-n'} at ${r.at}; halfW ${S[r.at].halfW.toFixed(2)}; other road sample ${no.j} at ${no.d.toFixed(1)} m; flags ${S[r.at].wallPos}/${S[r.at].wallNeg}`);
    console.log('     ' + res.join(' | '));
  }
  track.dispose();
}
{
  const td = TRACKS.find(t => t.name.includes('Suzuka'));
  const track = F1.buildTrack(td); const S = track.samples, N = S.length;
  console.log('== Suzuka crossings', JSON.stringify(track.crossings), 'N', N);
  const [ia, ib] = track.crossings[0];
  console.log('  y at crossing', S[ia].y.toFixed(3), S[ib].y.toFixed(3), 'bank', S[ia].bank.toFixed(4), S[ib].bank.toFixed(4), 'grade', S[ia].grade.toFixed(4), S[ib].grade.toFixed(4));
  let maxDy = 0;
  for (let k = -12; k <= 12; k++) for (const d of [-12, -6, 0, 6, 12]) {
    const i = (ia + k + N) % N, x = S[i].x + S[i].nx * d, z = S[i].z + S[i].nz * d;
    // same point seen from the other branch
    let best = -1, bd = 1e9; for (let q = -30; q <= 30; q++) { const j = (ib + q + N) % N; const dd = Math.hypot(S[j].x - x, S[j].z - z); if (dd < bd) { bd = dd; best = j; } }
    const dj = (x - S[best].x) * S[best].nx + (z - S[best].z) * S[best].nz;
    if (Math.abs(dj) <= 12.5) maxDy = Math.max(maxDy, Math.abs(track.surfaceY(i, d) - track.surfaceY(best, dj)));
  }
  console.log('  max height difference between the two surfaces where they overlap:', maxDy.toFixed(4));
  const wl = k => { let o = ''; for (let q = -20; q <= 20; q++) { const s = S[(k + q + N) % N]; o += (s.wallPos ? 'P' : '.') + (s.wallNeg ? 'N' : '.') + ' '; } return o; };
  console.log('  walls A:', wl(ia)); console.log('  walls B:', wl(ib));
  for (const [from, to, label] of [[ia, ib, 'A->B'], [ib, ia, 'B->A']]) for (const dir of [1, -1]) {
    const car = F1.createCar(), st = car.state; car.reset(track, (from - 50 + N) % N);
    let t = 0, phase = 0, log = [], maxOff = 0, hits = 0, staleSteps = 0;
    const inp = {};
    while (t < 30) {
      const s = S[st.sampleIndex];
      let des;
      if (phase === 0) { des = Math.atan2(s.tx, s.tz); if (Math.hypot(st.x - S[from].x, st.z - S[from].z) < 9) phase = 1; }
      if (phase >= 1) {
        // follow the target road (in direction dir) using the global nearest sample on the target branch
        let best = -1, bd = 1e9; for (let q = -200; q <= 200; q++) { const j = (to + q + N) % N; const dd = Math.hypot(S[j].x - st.x, S[j].z - st.z); if (dd < bd) { bd = dd; best = j; } }
        const tg = S[(best + dir * 8 + N) % N]; des = Math.atan2(tg.x - st.x, tg.z - st.z);
        if (bd < 4 && Math.abs(best - to) > 25) phase = 2;
        if (phase === 2) { let di = Math.abs(st.sampleIndex - best); di = Math.min(di, N - di); if (di > 3) staleSteps++; maxOff = Math.max(maxOff, Math.abs(st.d)); }
      }
      const err = wrapPi(des - st.heading); inp.left = err > 0.02; inp.right = err < -0.02; inp.up = st.speed < 14; inp.down = false;
      car.update(DT, inp, track); t += DT; if (st.hit) hits++;
    }
    let prog = st.sampleIndex - to; if (prog > N / 2) prog -= N; if (prog < -N / 2) prog += N;
    console.log(`  ${label} dir ${dir}: end sampleIndex ${st.sampleIndex} (target branch centre ${to}, progress ${prog} samples), d ${st.d.toFixed(2)}, onGrass ${st.onGrass}, stale steps on the new road ${staleSteps}, max|d| there ${maxOff.toFixed(2)}, wall-hit steps ${hits}`);
  }
  track.dispose();
}
