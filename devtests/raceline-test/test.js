// node test.js [build|drive] [delay]
const path = require('path');
const ROOT = 'C:/Users/user/Desktop/f1drive';
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
const F1 = global.F1, TR = global.F1_TRACKS;
const mode = process.argv[2] || 'build';
const fmt = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0');

function buildAll() {
  let worst = 0, bad = 0;
  for (const td of TR) {
    const track = F1.buildTrack(td);
    const t0 = process.hrtime.bigint();
    const line = F1.buildRaceLine(track);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    worst = Math.max(worst, ms);
    const N = track.samples.length;
    let nan = 0, out = 0, maxd = 0, vmin = 1e9, vmax = 0, kink = 0, maxStep = 0;
    if (line.points.length !== N) { console.log('LEN MISMATCH'); bad++; }
    for (let i = 0; i < N; i++) {
      const p = line.points[i], s = track.samples[i];
      for (const k of ['x', 'z', 'd', 'speed']) if (!isFinite(p[k])) nan++;
      const lim = (s.halfW || track.halfWidth) - 1.6;
      if (Math.abs(p.d) > lim + 1e-6) out++;
      maxd = Math.max(maxd, Math.abs(p.d));
      vmin = Math.min(vmin, p.speed); vmax = Math.max(vmax, p.speed);
      const q = line.points[(i + 1) % N], r = line.points[(i + 2) % N];
      maxStep = Math.max(maxStep, Math.abs(q.d - p.d));
      kink = Math.max(kink, Math.abs(p.d - 2 * q.d + r.d));
    }
    const pa = line.group.children[0].geometry.attributes.position.array;
    for (let i = 0; i < pa.length; i++) if (!isFinite(pa[i])) nan++;
    // exercise update at several positions incl. wrap
    const st = { sampleIndex: 0, speed: 50 };
    for (const k of [0, 5, N - 3, N - 1, N >> 1]) { st.sampleIndex = k; line.update(st); }
    const ca = line.group.children[0].geometry.attributes.color.array;
    for (let i = 0; i < ca.length; i++) if (!isFinite(ca[i])) nan++;
    if (nan || out) bad++;
    console.log(td.name.padEnd(42), 'N', String(N).padStart(4), 'build', ms.toFixed(1).padStart(6), 'ms  lap', fmt(line.lapTime),
      ' v', (vmin * 3.6).toFixed(0).padStart(3), '-', (vmax * 3.6).toFixed(0), 'km/h  max|d|', maxd.toFixed(2),
      'dStep', maxStep.toFixed(3), 'd2', kink.toFixed(4), nan ? 'NaN:' + nan : '', out ? 'OUT:' + out : '');
    line.dispose(); track.dispose();
  }
  console.log('worst build ms', worst.toFixed(1), 'bad tracks', bad);
  // per-frame cost
  const track = F1.buildTrack(TR.find(t => /Spa/.test(t.name))), line = F1.buildRaceLine(track);
  const st = { sampleIndex: 0, speed: 60 };
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 20000; k++) { st.sampleIndex = (k * 7) % track.samples.length; st.speed = 20 + (k % 70); line.update(st); }
  console.log('update() avg us', (Number(process.hrtime.bigint() - t0) / 1e3 / 20000).toFixed(2), 'window points', line.windowPoints);
}

function drive(td, opts) {
  const track = F1.buildTrack(td), line = F1.buildRaceLine(track), car = F1.createCar();
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points;
  car.reset(track, 0);
  // start on the line
  const st = car.state;
  const dt = 1 / (opts.hz || 60), input = { up: false, down: false, left: false, right: false };
  let t = 0, lapStart = 0, laps = [], prevIdx = 0, grass = 0, hits = 0, maxOut = -9, maxOutIdx = 0, maxDev = 0, stuck = false;
  const delayN = Math.round((opts.delay || 0) / dt), hist = [];
  let lapFrames = 0, prog = 0, maxOver = 0, maxOverIdx = 0, devFly = 0;
  while (laps.length < opts.laps && t < 1200) {
    line.update(st);
    const v = Math.max(0, st.speed);
    let lv = line.levels[+(process.env.LVI || 2)];
    hist.push(lv); if (hist.length > delayN + 1) hist.shift();
    lv = hist[0];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    // pure pursuit
    const L = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(st.sampleIndex + Math.round(L / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const lat = dx * ch - dz * sh, d2 = dx * dx + dz * dz;
    const kap = 2 * lat / d2;
    const lock = 0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    car.update(dt, input, track);
    t += dt; lapFrames++;
    const s = S[st.sampleIndex], hw = s.halfW || track.halfWidth;
    const outBy = Math.abs(st.d) + 1.0 - hw;   // car edge beyond the white line (m)
    if (laps.length >= 0 && outBy > maxOut) { maxOut = outBy; maxOutIdx = st.sampleIndex; }
    maxDev = Math.max(maxDev, Math.abs(st.d - P[st.sampleIndex].d));
    { const r = st.speed / P[st.sampleIndex].limit; if (r > maxOver) { maxOver = r; maxOverIdx = st.sampleIndex; } if (laps.length >= 1) devFly = Math.max(devFly, Math.abs(st.d - P[st.sampleIndex].d)); }
    if (st.onGrass) grass++;
    if (st.hit > 0) hits++;
    let di = st.sampleIndex - prevIdx; if (di < -N / 2) di += N; else if (di > N / 2) di -= N;
    prog += di;
    if (prevIdx > N * 0.75 && st.sampleIndex < N * 0.25) { laps.push(t - lapStart); lapStart = t; }
    prevIdx = st.sampleIndex;
  }
  if (laps.length < opts.laps) stuck = true;
  const ok = !stuck && grass === 0 && hits === 0;
  console.log((ok ? 'OK   ' : 'FAIL ') + td.name.padEnd(40), 'pred', fmt(line.lapTime), 'laps', laps.map(fmt).join(' '),
    ' grassFrames', grass, 'hitFrames', hits, 'maxEdgeOver', maxOut.toFixed(2), '@' + maxOutIdx, 'devFlying', devFly.toFixed(2), 'maxSpeed/limit', maxOver.toFixed(3), '@' + maxOverIdx, stuck ? 'STUCK' : '');
  return ok;
}

if (mode === 'build') buildAll();
else {
  const delay = parseFloat(process.argv[3] || '0');
  const filt = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
  let ok = 0, n = 0;
  for (const td of TR) { if (filt && !filt.test(td.name)) continue; n++; if (drive(td, { laps: 3, delay, hz: +(process.argv[5] || 60) })) ok++; }
  console.log('passed', ok, '/', n, 'delay', delay);
}
