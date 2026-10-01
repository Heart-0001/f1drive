// node devtests/handling-test/make-variants.js
// Writes COPIES of js/car.js and js/raceline.js with the proposed steering law (nothing in the project is edited):
//   variants/car-x.js, variants/raceline-x.js       exploration copies: the law's constants can be overridden through
//                                                  window.HT_STEER = {low, bank, lock, ref, margin, old} (lib.js `hook`)
//   variants/car.proposed.js, raceline.proposed.js  the recommended files (no hook), and variants/*.diff (diff -u)
// Every replacement must match exactly once (the script throws otherwise), so a changed js/car.js is noticed.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..'), OUT = path.join(__dirname, 'variants');
fs.mkdirSync(OUT, { recursive: true });
function rep(src, a, b, what) {
  const n = src.split(a).length - 1;
  if (n !== 1) throw new Error(what + ': expected 1 match, found ' + n);
  return src.replace(a, () => b);
}

// ------------------------------------------------------------------ car.js
function car(hook) {
  let s = fs.readFileSync(path.join(ROOT, 'js', 'car.js'), 'utf8');
  s = rep(s,
`  var STEER_LOCK = 0.35;            // rad at standstill
  var STEER_SPEED_REF = 22;         // m/s; lock = STEER_LOCK / (1 + (v/ref)^2)
`,
`  var STEER_LOCK = 0.35;            // rad: full lock at the road wheels (20 deg: a Monaco-spec rack; F1 cars run ~14 deg
                                    //   elsewhere, ~20-22 at Monaco: formula1.com, Ferrari SF15-T / Smedley 2019)
  var STEER_SPEED_REF = 22;         // m/s; the v5 law at speed: lock = STEER_LOCK / (1 + (v/ref)^2) (keyboard stability)
  var STEER_LOW_GRIP = 1.25;        // ... but never less lock than asks STEER_LOW_GRIP x the mechanical grip: full lock up
                                    //   to ~57 km/h (Monaco's hairpin at ~47 km/h), the v5 law from ~85 km/h on
` + (hook ? `  var HT = root.HT_STEER || null;   // handling-test exploration hook (not in the proposed file)
  if (HT) {
    if (typeof HT.lock === 'number') STEER_LOCK = HT.lock;
    if (typeof HT.ref === 'number') STEER_SPEED_REF = HT.ref;
    if (typeof HT.low === 'number') STEER_LOW_GRIP = HT.low;
  }
  var HT_OLD = !!(HT && HT.old), HT_BANK = !(HT && HT.bank === false);
` : ''), 'constants');

  s = rep(s,
`    // Drivetrain (shared by car.js for the own car and by audio.js for remote cars): the gear by speed against`,
`    // Steering lock (rad at the road wheels) at speed v on a road banked \`bank\` (rad, left higher > 0), turning towards
    // turnSign (+1 left): the v5 law (STEER_LOCK / (1 + (v / STEER_SPEED_REF)^2): at speed, full lock asks for about
    // the grip, so a keyboard's bang-bang steering stays tame), but never less than the lock that asks STEER_LOW_GRIP x
    // the mechanical grip (low speed: full lock up to ~57 km/h, the v5 law from ~85 km/h on); a road banked into the
    // turn, which holds more (maxLatAccel), gets that much more lock (never less than on the flat); at most STEER_LOCK.
    // On the flat above ~85 km/h this is exactly the v5 lock.
    function steerLockAt(v, bank, turnSign) {
      var av = v < 0 ? -v : v, r = av / STEER_SPEED_REF, lock = STEER_LOCK / (1 + r * r);
` + (hook ? `      if (HT_OLD) return lock;
` : '') + `      if (!(av > 0.5)) return STEER_LOCK;
      var t = Math.tan(lock), tl = STEER_LOW_GRIP * s.latBase * WHEELBASE / (av * av), up = false;
      if (tl > t) { t = tl; up = true; }
      if (bank` + (hook ? ` && HT_BANK` : '') + `) {
        var gb = maxLatAccel(av, bank, 0, 0, turnSign), gf = maxLatAccel(av, 0, 0, 0, turnSign);
        if (gb > gf && gf > 0) { t *= gb / gf; up = true; }
      }
      if (!up) return lock;
      t = Math.atan(t);
      return t < STEER_LOCK ? t : STEER_LOCK;
    }

    // Drivetrain (shared by car.js for the own car and by audio.js for remote cars): the gear by speed against`, 'steerLockAt');

  s = rep(s,
`      wheelbase: WHEELBASE, steerLock: STEER_LOCK, steerSpeedRef: STEER_SPEED_REF,`,
`      wheelbase: WHEELBASE, steerLock: STEER_LOCK, steerSpeedRef: STEER_SPEED_REF, steerLowGrip: STEER_LOW_GRIP,
      steerLockAt: steerLockAt,        // (v, bank, turnSign) -> rad: the steering lock (state.steer = +-1) at that speed`, 'perf');

  s = rep(s,
`      var ratio = av / STEER_SPEED_REF;
      var delta = state.steer * STEER_LOCK / (1 + ratio * ratio);`,
`      var delta = state.steer === 0 ? 0 : state.steer * K.steerLockAt(av, Math.atan(slopeLeft), state.steer);`, 'delta');
  return s;
}

// ------------------------------------------------------------------ raceline.js
function raceline() {
  let s = fs.readFileSync(path.join(ROOT, 'js', 'raceline.js'), 'utf8');
  const CR = String.fromCharCode(13), crlf = s.indexOf(CR + '\n') >= 0;
  s = s.split(CR + '\n').join('\n');
  s = rep(s,
`  var maxLatAccel = fbMaxLat, maxAccel = fbMaxAccel, maxDecel = fbMaxDecel;
`,
`  var maxLatAccel = fbMaxLat, maxAccel = fbMaxAccel, maxDecel = fbMaxDecel;
  var steerLockAt = null;     // perf.steerLockAt (js/car.js) when present: the car's own lock law (speed, banking)
`, 'decl');
  s = rep(s,
`    maxLatAccel = fbMaxLat; maxAccel = fbMaxAccel; maxDecel = fbMaxDecel;
    if (!p) return;`,
`    maxLatAccel = fbMaxLat; maxAccel = fbMaxAccel; maxDecel = fbMaxDecel; steerLockAt = null;
    if (!p) return;`, 'reset');
  s = rep(s,
`      maxLatAccel = p.maxLatAccel; maxAccel = p.maxAccel; maxDecel = p.maxDecel;
    }`,
`      maxLatAccel = p.maxLatAccel; maxAccel = p.maxAccel; maxDecel = p.maxDecel;
    }
    if (typeof p.steerLockAt === 'function') steerLockAt = p.steerLockAt;`, 'sync');
  s = rep(s,
`    // steering lock: tan(STEER_LOCK / (1 + (v/ref)^2)) / WHEELBASE >= k * margin
    var x = Math.atan(WHEELBASE * k * STEER_MARGIN);
    if (x >= STEER_LOCK) v = MIN_SPEED;
    else v = Math.min(v, STEER_SPEED_REF * Math.sqrt(STEER_LOCK / x - 1));`,
`    // steering lock: tan(lock(v)) / WHEELBASE >= k * margin
    var x = Math.atan(WHEELBASE * k * STEER_MARGIN);
    if (steerLockAt) {
      // the car's law (js/car.js perf.steerLockAt: speed, banking); it falls with speed: the fastest speed whose lock is enough
      if (steerLockAt(v, bank, turnSign) < x) {
        var a = MIN_SPEED, b = v, c;
        if (steerLockAt(a, bank, turnSign) < x) v = MIN_SPEED;
        else {
          for (var n = 0; n < 18; n++) { c = 0.5 * (a + b); if (steerLockAt(c, bank, turnSign) >= x) a = c; else b = c; }
          v = a;
        }
      }
    } else if (x >= STEER_LOCK) v = MIN_SPEED;
    else v = Math.min(v, STEER_SPEED_REF * Math.sqrt(STEER_LOCK / x - 1));`, 'cornerSpeed');
  return crlf ? s.split('\n').join(CR + '\n') : s;
}

fs.writeFileSync(path.join(OUT, 'car-x.js'), car(true));
fs.writeFileSync(path.join(OUT, 'car.proposed.js'), car(false));
fs.writeFileSync(path.join(OUT, 'raceline-x.js'), raceline());
fs.writeFileSync(path.join(OUT, 'raceline.proposed.js'), raceline());
for (const [orig, prop, name] of [['js/car.js', 'car.proposed.js', 'car'], ['js/raceline.js', 'raceline.proposed.js', 'raceline']]) {
  let d = '';
  try { d = cp.execSync(`git diff --no-index -- "${path.join(ROOT, orig)}" "${path.join(OUT, prop)}"`, { encoding: 'utf8' }); }
  catch (e) { d = e.stdout || ''; }
  fs.writeFileSync(path.join(OUT, name + '.diff'), d);
}
console.log('variants written to', OUT);
