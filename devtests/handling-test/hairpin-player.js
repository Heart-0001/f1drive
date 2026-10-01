// node devtests/handling-test/hairpin-player.js [variant[:hookJSON] ...]
// How forgiving is Monaco's hairpin for a player? A grid of simple "human" attempts on the real car physics: the car
// arrives straight along the track at sample 616 at lateral offset d0 (-6 = far right, the outside of this left-hander,
// .. +5) at a held speed (20 / 30 / 40 / 47 km/h: keys W / S keep it), turns in at sample `ti` with FULL lock (key A
// held) until it has turned 170 deg, then straightens. Success = no wall touched and the exit reached (sample 660).
// Prints, per speed, how many of the (d0, turn-in) attempts succeed, and the best line's time from 616 to 660.
const L = require('./lib.js');
const args = process.argv.slice(2).length ? process.argv.slice(2) : ['today', 'proposed'];
const SP = [20, 30, 40, 47, 55], D0 = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
for (const a of args) {
  const [name, hj] = a.split(/:(.*)/s);
  const F1 = L.load(L.variant(name, hj ? JSON.parse(hj) : undefined));
  const tr = L.track(F1, 'mc-1929'), S = tr.samples;
  const out = [];
  for (const kmh of SP) {
    let ok = 0, n = 0, best = Infinity, bestAt = '';
    const fails = { wall: 0, stuck: 0 };
    for (const d0 of D0) for (let ti = 618; ti <= 634; ti += 2) {
      n++;
      const car = F1.createCar(null, { tyres: false }), st = car.state;
      car.reset(tr, 616);
      const s = S[616]; st.x = s.x + s.nx * d0; st.z = s.z + s.nz * d0; car.update(1e-4, null, tr);
      st.speed = kmh / 3.6;
      let turned = 0, h0 = st.heading, phase = 0, hit = false, t = 0, done = false;
      for (let k = 0; k < 120 * 12; k++) {
        const v = st.speed, tgt = kmh / 3.6;
        const inp = { up: v < tgt - 0.05, down: v > tgt + 0.3, left: false, right: false };
        if (phase === 0 && st.sampleIndex >= ti && st.sampleIndex < 700) phase = 1;
        if (phase === 1) { inp.left = true; if (turned > 170 / 57.3) phase = 2; }
        if (phase === 2) {   // straighten: steer towards the track direction
          const sm = S[st.sampleIndex], th = Math.atan2(sm.tx, sm.tz);
          let e = th - st.heading; e = Math.atan2(Math.sin(e), Math.cos(e));
          const want = Math.max(-1, Math.min(1, e * 4 - st.d * 0.05));
          inp.left = want > st.steer + 0.05; inp.right = want < st.steer - 0.05;
        }
        car.update(1 / 120, inp, tr);
        t += 1 / 120;
        let dh = st.heading - h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); turned += dh; h0 = st.heading;
        if (st.hit > 0) { hit = true; break; }
        if (st.sampleIndex >= 660 && st.sampleIndex < 700) { done = true; break; }
      }
      if (done && !hit) { ok++; if (t < best) { best = t; bestAt = `d0 ${d0} turn-in ${ti}`; } }
      else if (hit) fails.wall++; else fails.stuck++;
    }
    out.push(`${String(kmh).padStart(3)} km/h: ${String(ok).padStart(3)} / ${n} attempts get round (walls ${fails.wall}, not out ${fails.stuck})${ok ? `, best ${best.toFixed(2)} s (${bestAt})` : ''}`);
  }
  console.log(`=== ${a}\n  ` + out.join('\n  '));
}
