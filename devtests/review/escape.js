// Adversarial test: from many points on each track, drive full-throttle into the wall at various angles
// and also "steer hard" continuously; check whether |d| ever exceeds wallDist+2 while a wall exists there,
// or whether the car ends up with |d| > 14 (considered outside) anywhere with a wall flag.
const { F1, TRACKS } = require('./load');
const DT = 1 / 60;
const only = process.argv[2];
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
let totalEsc = 0;
for (const td of TRACKS) {
  if (only && !td.name.toLowerCase().includes(only.toLowerCase())) continue;
  const track = F1.buildTrack(td);
  const S = track.samples, N = S.length;
  const car = F1.createCar(); const st = car.state;
  const escapes = [];
  const starts = 24;
  for (let sIdx = 0; sIdx < starts; sIdx++) {
    const start = Math.floor(sIdx * N / starts);
    for (const mode of ['ramLeft', 'ramRight', 'holdLeft', 'holdRight', 'ramLeft45', 'ramRight45', 'reverseLeft']) {
      car.reset(track, start);
      let t = 0, launched = false, escaped = null;
      const inp = { up: true, down: false, left: false, right: false };
      let maxOver = 0;
      while (t < 25) {
        const v = st.speed;
        if (mode.startsWith('hold')) { inp.left = mode === 'holdLeft'; inp.right = !inp.left; inp.up = true; }
        else if (mode === 'reverseLeft') { inp.up = false; inp.down = true; inp.left = t > 3; inp.right = false; }
        else {
          // accelerate along the track to ~high speed, then turn hard toward the wall and hold
          const sgn = mode.includes('Left') ? 1 : -1;
          if (!launched) {
            const s = S[st.sampleIndex];
            const des = Math.atan2(s.tx, s.tz), err = wrapPi(des - st.heading);
            inp.left = err > 0.02; inp.right = err < -0.02; inp.up = true;
            if (v > (mode.endsWith('45') ? 40 : 75) || t > 12) launched = true;
          } else {
            inp.left = sgn > 0; inp.right = sgn < 0; inp.up = true;
          }
        }
        car.update(DT, inp, track);
        t += DT;
        const s = S[st.sampleIndex];
        const side = st.d > 0 ? s.wallPos : s.wallNeg;
        const over = Math.abs(st.d) - (track.wallDist - 1);
        if (side && over > maxOver) maxOver = over;
        if (side && over > 2.0 && !escaped) escaped = { mode, start, idx: st.sampleIndex, d: st.d.toFixed(2), v: (v * 3.6).toFixed(0), t: t.toFixed(1) };
        if (Math.abs(st.d) > 40 && !escaped) escaped = { mode, start, idx: st.sampleIndex, d: st.d.toFixed(2), far: true };
      }
      if (escaped) escapes.push(escaped);
    }
  }
  totalEsc += escapes.length;
  console.log(td.name.padEnd(45), escapes.length ? 'ESCAPES: ' + escapes.length : 'ok');
  for (const e of escapes.slice(0, 6)) console.log('    ', JSON.stringify(e));
  track.dispose();
}
console.log('total escapes', totalEsc);
