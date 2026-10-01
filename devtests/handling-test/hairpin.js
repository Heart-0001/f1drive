// node devtests/handling-test/hairpin.js [variant ...]   (default: today proposed)
// Monaco's Fairmont hairpin (mc-1929, samples 600..680) with today's js/car.js + js/raceline.js and with the copies:
//   - the centreline and the racing line through it: radius, offset, the line's target speed and what limits it;
//   - the car's turning radius at full lock by speed;
//   - the keyboard and the analog autopilot (3 laps, 120 Hz): minimum speed in the hairpin, where, lap times, grass / walls;
//   - a "player" test: from 60 km/h at the hairpin's entry, full lock held at a steady speed (throttle modulated) along
//     the real line of the 2025 / 2026 pole laps: the radius the car can hold and whether it stays on the road.
// Real reference (devtests/handling-test/ref, F1 live timing, qualifying): 2025 median min speed 47 km/h (max 50),
// 2026 45 km/h (max 52); formula1.com: ~20-22 deg of steer needed (Smedley 2019), normal racks ~14 deg.
const L = require('./lib.js'), { drive } = require('./driver.js');
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['today', 'proposed'];
const A = 600, B = 680, D = 180 / Math.PI;
for (const name of names) {
  const F1 = L.load(L.variant(name));
  const tr = L.track(F1, 'mc-1929'), S = tr.samples, N = S.length, ds = tr.length / N;
  const line = F1.buildRaceLine(tr), P = line.points, K = F1.CAR_PERF;
  console.log(`\n=== ${name}: Monaco racing line ${line.lapTime.toFixed(2)} s predicted`);
  let iMin = A;
  for (let i = A; i <= B; i++) if (P[i].speed < P[iMin].speed) iMin = i;
  for (let i = A + 15; i <= B - 15; i += 3) {
    const k = Math.abs(P[i].curvature), lk = typeof K.steerLockAt === 'function' ? K.steerLockAt(P[i].speed, S[i].bank, P[i].curvature < 0 ? 1 : -1) : 0.35 / (1 + (P[i].speed / 22) ** 2);
    const need = Math.atan(3.6 * k * 1.22);
    console.log(`  ${String(i).padStart(4)} line d ${P[i].d.toFixed(2).padStart(6)} R ${(1 / k).toFixed(1).padStart(6)} m  target ${(P[i].speed * 3.6).toFixed(1).padStart(6)} km/h (corner limit ${(P[i].limit * 3.6).toFixed(1)})  lock there ${(lk * D).toFixed(1)} deg, needed x1.22 ${(need * D).toFixed(1)} deg${need >= lk - 1e-6 ? '  <- lock' : ''}`);
  }
  console.log(`  slowest target ${(P[iMin].speed * 3.6).toFixed(1)} km/h at ${iMin}, line radius ${(1 / Math.abs(P[iMin].curvature)).toFixed(1)} m`);
  for (const mode of ['keys', 'analog']) {
    const r = drive(F1, tr, { mode, trace: [A, B], laps: 3 });
    const fly = r.trace.filter(q => q.lap >= 1);
    let m = fly[0];
    for (const q of fly) if (q.v < m.v) m = q;
    const off = fly.filter(q => Math.abs(q.d) + 1 > S[q.i].halfW).length;
    console.log(`  autopilot ${mode.padEnd(6)}: laps ${r.laps.map(x => x.toFixed(2)).join(' ')}  hairpin min ${(m.v * 3.6).toFixed(1)} km/h at ${m.i} (d ${m.d.toFixed(1)}, steer ${m.steer.toFixed(2)}, lock ${(m.lock * D).toFixed(1)} deg), ` +
      `peak lateral ${Math.max(...fly.map(q => Math.abs(q.latG))).toFixed(2)} g, edge over ${off} steps, grass ${r.grass}, hits ${r.hits}, key flips ${r.steerFlips}`);
  }
  // turning radius at full lock (flat) and the speed the grip allows on it
  const rows = [];
  for (const kmh of [10, 20, 30, 40, 45, 50, 55, 60]) {
    const v = kmh / 3.6, lk = typeof K.steerLockAt === 'function' ? K.steerLockAt(v, 0, 1) : 0.35 / (1 + (v / 22) ** 2);
    rows.push(`${kmh}: ${(3.6 / Math.tan(lk)).toFixed(1)} m`);
  }
  console.log('  full-lock radius (rear axle, flat): ' + rows.join(', '));
  // a player holding full lock at a steady speed from the entry of the hairpin, on the line's entry point
  for (const kmh of [30, 40, 45, 50, 55]) {
    const car = F1.createCar(null, { tyres: false }), st = car.state;
    const i0 = 624;                        // the entry, where the real pole laps were at d -2.7 (2025)
    car.reset(tr, i0);
    const s = S[i0]; st.x = s.x + s.nx * -5.0; st.z = s.z + s.nz * -5.0;     // wide on the right (the outside: a left-hander)
    car.update(1e-4, null, tr);
    st.speed = kmh / 3.6; st.steer = 1;
    let turned = 0, minEdge = 9, hit = 0, grass = 0, h0 = st.heading, out = '';
    for (let k = 0; k < 120 * 6; k++) {
      const vv = st.speed, tgt = kmh / 3.6;
      car.update(1 / 120, { left: true, up: vv < tgt - 0.05, down: vv > tgt + 0.4 }, tr);
      let dh = st.heading - h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); turned += dh; h0 = st.heading;
      if (st.hit > 0) hit++; if (st.onGrass) grass++;
      minEdge = Math.min(minEdge, S[st.sampleIndex].halfW - Math.abs(st.d) - 1);
      if (turned > Math.PI * 0.95) { out = `turned 171 deg after ${(k / 120).toFixed(2)} s, sample ${st.sampleIndex}, d ${st.d.toFixed(1)}`; break; }
    }
    console.log(`  full lock from d -5 at sample ${i0}, held ${kmh} km/h: ${out || 'did not turn round in 6 s (turned ' + (turned * D).toFixed(0) + ' deg)'}; walls ${hit}, grass ${grass}, closest to an edge ${minEdge.toFixed(2)} m`);
  }
}
