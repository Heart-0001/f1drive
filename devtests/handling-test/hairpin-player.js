// node devtests/handling-test/hairpin-player.js [variant[:hookJSON] ...]   (default: today proposed)
// How forgiving is Monaco's hairpin for a player? Simple "human" attempts on the real car physics: the car arrives
// straight along the track at sample 610 at lateral offset d0 (-5 = far right, the outside of this left-hander, 0 = the
// middle, +4 = the inside) at a held speed (W / S keep it), turns in at sample `ti` with FULL lock (key A held) until it
// has turned 170 deg, then straightens (keys towards the track direction). Success = no wall touched and the exit
// reached (sample 660). Per speed and approach offset: the turn-in window (the turn-in samples that work, in metres of
// track: a longer window = more forgiving) and the best time from 610 to 660. The user's report: "even at 20 km/h I
// cannot get round" (2026-10-01).
const L = require('./lib.js');
const args = process.argv.slice(2).length ? process.argv.slice(2) : ['today', 'proposed'];
const SP = [20, 30, 40, 47, 55], D0 = [-5, -3, -1, 0, 1, 3];
for (const a of args) {
  const [name, hj] = a.split(/:(.*)/s);
  const F1 = L.load(L.variant(name, hj ? JSON.parse(hj) : undefined));
  const tr = L.track(F1, 'mc-1929'), S = tr.samples, ds = tr.length / S.length;
  const out = [];
  for (const kmh of SP) {
    const cells = [];
    let best = Infinity, bestAt = '';
    for (const d0 of D0) {
      const okTi = [];
      for (let ti = 612; ti <= 640; ti++) {
        const car = F1.createCar(null, { tyres: false }), st = car.state;
        car.reset(tr, 610);
        const s = S[610]; st.x = s.x + s.nx * d0; st.z = s.z + s.nz * d0; car.update(1e-4, null, tr);
        st.speed = kmh / 3.6;
        let turned = 0, h0 = st.heading, phase = 0, hit = false, t = 0, done = false;
        for (let k = 0; k < 120 * 40; k++) {
          const v = st.speed, tgt = kmh / 3.6;
          const inp = { up: v < tgt - 0.05, down: v > tgt + 0.3, left: false, right: false };
          if (phase === 0 && st.sampleIndex >= ti && st.sampleIndex < 700) phase = 1;
          if (phase === 1) { inp.left = true; if (turned > 170 / 57.3) phase = 2; }
          if (phase === 2) {
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
        if (done && !hit) { okTi.push(ti); if (t < best) { best = t; bestAt = `d0 ${d0}, turn-in ${ti}`; } }
      }
      cells.push(`d0 ${String(d0).padStart(2)}: ${okTi.length ? (okTi.length * ds).toFixed(0).padStart(2) + ' m (' + okTi[0] + '..' + okTi[okTi.length - 1] + ')' : ' -          '}`);
    }
    out.push(`${String(kmh).padStart(3)} km/h  turn-in window  ` + cells.join(' | ') + (isFinite(best) ? `   best ${best.toFixed(2)} s (${bestAt})` : ''));
  }
  console.log(`=== ${a}\n  ` + out.join('\n  '));
}
