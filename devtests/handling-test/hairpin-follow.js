// node devtests/handling-test/hairpin-follow.js [variant[:hookJSON] ...]
// Can the car FOLLOW a given path through Monaco's hairpin at a held speed? An analog pursuit driver (stick = the steer
// that the car's own lock law needs for the pursuit arc, 4 m.. lookahead, 120 Hz) holds 20 / 30 / 40 / 47 / 55 km/h from
// sample 600 to 680 along: the racing line, the centreline, and the real 2025 pole lap's line (ref/mc-mc-1929.json:
// offsets measured from the live-timing positions, +-2 m). Prints the worst offset from the path, whether the steering
// saturated (|steer| = 1), walls and grass. Lock-limited = the car cannot turn as tight as the path.
const fs = require('fs'), path = require('path'), L = require('./lib.js');
const args = process.argv.slice(2).length ? process.argv.slice(2) : ['today', 'proposed'];
const REF = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref', 'mc-mc-1929.json'), 'utf8'));
for (const a of args) {
  const [name, hj] = a.split(/:(.*)/s);
  const F1 = L.load(L.variant(name, hj ? JSON.parse(hj) : undefined));
  const tr = L.track(F1, 'mc-1929'), S = tr.samples, N = S.length, ds = tr.length / N;
  const line = F1.buildRaceLine(tr);
  // the pole lap's offsets per sample (nearest row; gaps interpolated)
  const real = new Float64Array(N).fill(NaN);
  for (const r of REF.poleTrace) real[r[0]] = r[1];
  for (let i = 560; i < 720; i++) if (isNaN(real[i])) { let a0 = i, b0 = i; while (isNaN(real[a0])) a0--; while (isNaN(real[b0])) b0++; real[i] = real[a0] + (real[b0] - real[a0]) * (i - a0) / (b0 - a0); }
  const paths = { line: i => line.points[i].d, centre: () => 0, real2025: i => real[i] };
  console.log(`=== ${a}`);
  for (const [pn, pd] of Object.entries(paths)) {
    const row = [];
    for (const kmh of [20, 30, 40, 47, 55]) {
      const car = F1.createCar(null, { tyres: false }), st = car.state, K = car.perf;
      car.reset(tr, 590);
      const s0 = S[590]; st.x = s0.x + s0.nx * pd(590); st.z = s0.z + s0.nz * pd(590); car.update(1e-4, null, tr);
      st.speed = kmh / 3.6;
      let worst = 0, sat = 0, hit = 0, grass = 0, steps = 0;
      for (let k = 0; k < 120 * 30 && !(st.sampleIndex >= 680 && st.sampleIndex < 800); k++) {
        const v = Math.max(0.5, st.speed), Ld = Math.max(4, 0.5 * v);
        const j = (st.sampleIndex + Math.round(Ld / ds)) % N, sj = S[j], dj = pd(j);
        const tx = sj.x + sj.nx * dj - st.x, tz = sj.z + sj.nz * dj - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
        const kap = 2 * (tx * ch - tz * sh) / (tx * tx + tz * tz);
        const lock = typeof K.steerLockAt === 'function' ? K.steerLockAt(v, S[st.sampleIndex].bank, kap >= 0 ? 1 : -1) : 0.35 / (1 + (v / 22) ** 2);
        const want = Math.atan(kap * 3.6) / lock;
        const tgt = kmh / 3.6;
        car.update(1 / 120, { steerAxis: Math.max(-1, Math.min(1, want)), up: st.speed < tgt - 0.05, down: st.speed > tgt + 0.3 }, tr);
        if (st.sampleIndex >= 615 && st.sampleIndex <= 660) {
          steps++;
          worst = Math.max(worst, Math.abs(st.d - pd(st.sampleIndex)));
          if (Math.abs(want) > 1) sat++;
        }
        if (st.hit > 0) hit++; if (st.onGrass) grass++;
      }
      row.push(`${kmh}: off ${worst.toFixed(1)} m${sat ? ' sat ' + (sat / 120).toFixed(1) + ' s' : ''}${hit ? ' WALL ' + hit : ''}${grass ? ' grass' : ''}`);
    }
    console.log(`  ${pn.padEnd(9)} ` + row.join(' | '));
  }
}
