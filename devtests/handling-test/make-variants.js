// node devtests/handling-test/make-variants.js
// Writes COPIES of js/car.js and js/raceline.js with the proposed steering law (nothing in the project is edited):
//   variants/car-x.js, variants/raceline-x.js       exploration copies: the law's constants can be overridden through
//                                                  window.HT_STEER (lib.js `hook`):
//                                                    lockMax   full lock at low speed (rad)               default 0.40
//                                                    low       the grip floor (x latBase)                 default 1.25
//                                                    bankFrom, bankTo  the banking factor fades in between (deg) 6, 9
//                                                    bank      false: no banking factor
//                                                    old       true: the v5 law (lock = 0.35 / (1 + (v/22)^2))
//                                                    cliff     true: the v5 racing-line rule (a corner tighter than the
//                                                              lock with its margin -> MIN_SPEED 25 km/h)
//   variants/car.proposed.js, raceline.proposed.js  the recommended files (no hook), and variants/*.diff (git diff)
// and the other files the change touches, each as <name>.proposed.* + a diff against the current project file:
//   car-v5.diff        devtests/car-v6/car-v5.js   the golden-rule oracle with the same law
//   build-cars.diff    tools/build-cars.mjs        its copy of the racing line's speed profile (start-up self-check)
//   calib-driver.diff  devtests/seasons-calib/driver.mjs  the calibration autopilot steers with perf.steerLockAt
//   audio.diff         js/audio.js                 the scrub guess for remote cars
//   car-cues.diff      js/car.js (on top of car.diff)  state.load / state.compress for the cockpit cues
//   cockpit.diff       js/cockpit.js               head counter-roll + compression cues
//   cockpit-test.diff  devtests/cockpit-test/api.test.js  the v5 camera identity on a level road + checks of the cues
//   cars-test.diff     test/cars.test.js           the 4-circuit era-index spot check: 0.6 % -> 1.0 % (2026 +0.84 %)
// Every replacement must match exactly once (the script throws otherwise), so a changed project file is noticed.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..'), OUT = path.join(__dirname, 'variants');
fs.mkdirSync(OUT, { recursive: true });
function rep(src, a, b, what) {
  const n = src.split(a).length - 1;
  if (n !== 1) throw new Error(what + ': expected 1 match, found ' + n);
  return src.replace(a, () => b);
}
const lf = (s) => s.split('\r\n').join('\n');
const BT = '`';

// ------------------------------------------------------------------ car.js
const CAR_CONST = [
  '  var STEER_LOCK = 0.35;            // rad: the v5 lock law at speed, lock = STEER_LOCK / (1 + (v/ref)^2), where full',
  '  var STEER_SPEED_REF = 22;         //   lock asks about the grip (1.0..1.3 x from ~85 km/h on): the keys stay tame',
  '  var STEER_LOCK_MAX = 0.40;        // rad (23 deg) at the road wheels at low speed, a Monaco rack. Real: ~14-17 deg,',
  '                                    //   ~20-22 at Monaco on 3.1-3.3 m wheelbases (kinematic radius 8.1-8.6 m); 23 deg',
  '                                    //   on this car\'s 3.6 m gives the same 8.5 m (formula1.com 2015, 2019; Autosport)',
  '  var STEER_LOW_GRIP = 1.25;        // full lock never asks less than this x the car\'s mechanical grip (latBase): full',
  '                                    //   lock up to ~52 km/h, the v5 law from ~85 km/h on',
  '  var STEER_BANK_FROM = 6 * Math.PI / 180;   // a road banked into the turn by more than js/track.js\'s derived',
  '  var STEER_BANK_TO = 9 * Math.PI / 180;     //   banking (<= 6 deg): the lock grows with the extra grip, in full from',
  '                                             //   9 deg (the real banked corners, 9.2..19 deg), faded in between',
  ''].join('\n');
const CAR_HOOK = [
  '  var HT = root.HT_STEER || null;   // handling-test exploration hook (not in the proposed file)',
  '  if (HT) {',
  '    if (typeof HT.lockMax === \'number\') STEER_LOCK_MAX = HT.lockMax;',
  '    if (typeof HT.low === \'number\') STEER_LOW_GRIP = HT.low;',
  '    if (typeof HT.bankFrom === \'number\') STEER_BANK_FROM = HT.bankFrom * Math.PI / 180;',
  '    if (typeof HT.bankTo === \'number\') STEER_BANK_TO = HT.bankTo * Math.PI / 180;',
  '  }',
  '  var HT_OLD = !!(HT && HT.old), HT_BANK = !(HT && HT.bank === false);',
  ''].join('\n');
function lockFn(hook) {
  return [
    '    // Steering lock (rad at the road wheels, state.steer = +-1) at speed v on a road banked ' + BT + 'bank' + BT + ' (rad, left higher',
    '    // > 0) turning towards turnSign (+1 left): the v5 law STEER_LOCK / (1 + (v / STEER_SPEED_REF)^2), where full lock',
    '    // asks about the grip, but never less lock than asks STEER_LOW_GRIP x the mechanical grip (low speed) and, on a real',
    '    // banked corner turning into the bank, that much more as the bank holds more (maxLatAccel banked / flat); at most',
    '    // STEER_LOCK_MAX. Exactly the v5 lock above ~85 km/h except on the real banked corners; STEER_LOCK_MAX to ~52 km/h.',
    '    function steerLockAt(v, bank, turnSign) {',
    '      var av = v < 0 ? -v : v, r = av / STEER_SPEED_REF, lock = STEER_LOCK / (1 + r * r);',
    hook ? '      if (HT_OLD) return lock;' : null,
    '      if (!(av > 0.5)) return STEER_LOCK_MAX;',
    '      var t = Math.tan(lock), tl = STEER_LOW_GRIP * s.latBase * WHEELBASE / (av * av), up = false;',
    '      if (tl > t) { t = tl; up = true; }',
    '      var ab = bank < 0 ? -bank : (bank || 0);',
    '      if (ab > STEER_BANK_FROM' + (hook ? ' && HT_BANK' : '') + ') {',
    '        var gb = maxLatAccel(av, bank, 0, 0, turnSign), gf = maxLatAccel(av, 0, 0, 0, turnSign);',
    '        if (gb > gf && gf > 0) {',
    '          var w = ab < STEER_BANK_TO ? (ab - STEER_BANK_FROM) / (STEER_BANK_TO - STEER_BANK_FROM) : 1;',
    '          t *= 1 + (gb / gf - 1) * w; up = true;',
    '        }',
    '      }',
    '      if (!up) return lock;',
    '      t = Math.atan(t);',
    '      return t < STEER_LOCK_MAX ? t : STEER_LOCK_MAX;',
    '    }',
    ''].filter(x => x !== null).join('\n');
}
function car(hook) {
  const raw = fs.readFileSync(path.join(ROOT, 'js', 'car.js'), 'utf8'), crlf = raw.indexOf('\r\n') >= 0;
  let s = lf(raw);
  s = rep(s,
    '  var STEER_LOCK = 0.35;            // rad at standstill\n' +
    '  var STEER_SPEED_REF = 22;         // m/s; lock = STEER_LOCK / (1 + (v/ref)^2)\n',
    CAR_CONST + (hook ? CAR_HOOK : ''), 'constants');
  const DT = '    // Drivetrain (shared by car.js for the own car and by audio.js for remote cars): the gear by speed against';
  s = rep(s, DT, lockFn(hook) + '\n' + DT, 'steerLockAt');
  s = rep(s,
    '      wheelbase: WHEELBASE, steerLock: STEER_LOCK, steerSpeedRef: STEER_SPEED_REF,',
    '      wheelbase: WHEELBASE, steerLock: STEER_LOCK, steerSpeedRef: STEER_SPEED_REF,\n' +
    '      steerLockMax: STEER_LOCK_MAX, steerLowGrip: STEER_LOW_GRIP,\n' +
    '      steerLockAt: steerLockAt,        // (v, bank, turnSign) -> rad: the steering lock (state.steer = +-1) there', 'perf');
  s = rep(s,
    '      var ratio = av / STEER_SPEED_REF;\n' +
    '      var delta = state.steer * STEER_LOCK / (1 + ratio * ratio);',
    '      var delta = state.steer === 0 ? 0 : state.steer * K.steerLockAt(av, Math.atan(slopeLeft), state.steer);', 'delta');
  return crlf ? s.split('\n').join('\r\n') : s;
}

// ------------------------------------------------------------------ raceline.js
function raceline(hook) {
  const raw = fs.readFileSync(path.join(ROOT, 'js', 'raceline.js'), 'utf8'), crlf = raw.indexOf('\r\n') >= 0;
  let s = lf(raw);
  s = rep(s,
    '  var maxLatAccel = fbMaxLat, maxAccel = fbMaxAccel, maxDecel = fbMaxDecel;\n',
    '  var maxLatAccel = fbMaxLat, maxAccel = fbMaxAccel, maxDecel = fbMaxDecel;\n' +
    '  var steerLockAt = null;     // perf.steerLockAt (js/car.js) when present: the car\'s own lock law (speed, banking)\n', 'decl');
  s = rep(s,
    '    maxLatAccel = fbMaxLat; maxAccel = fbMaxAccel; maxDecel = fbMaxDecel;\n    if (!p) return;',
    '    maxLatAccel = fbMaxLat; maxAccel = fbMaxAccel; maxDecel = fbMaxDecel; steerLockAt = null;\n    if (!p) return;', 'reset');
  s = rep(s,
    '      maxLatAccel = p.maxLatAccel; maxAccel = p.maxAccel; maxDecel = p.maxDecel;\n    }',
    '      maxLatAccel = p.maxLatAccel; maxAccel = p.maxAccel; maxDecel = p.maxDecel;\n    }\n' +
    '    if (typeof p.steerLockAt === \'function\') steerLockAt = p.steerLockAt;', 'sync');
  s = rep(s, [
    '    // steering lock: tan(STEER_LOCK / (1 + (v/ref)^2)) / WHEELBASE >= k * margin',
    '    var x = Math.atan(WHEELBASE * k * STEER_MARGIN);',
    '    if (x >= STEER_LOCK) v = MIN_SPEED;',
    '    else v = Math.min(v, STEER_SPEED_REF * Math.sqrt(STEER_LOCK / x - 1));'].join('\n'), [
    '    // steering lock: tan(lock(v)) / WHEELBASE >= k * margin',
    '    var x = Math.atan(WHEELBASE * k * STEER_MARGIN);',
    '    if (steerLockAt) {',
    '      // the car\'s own law (js/car.js perf.steerLockAt: speed, banking), falling with speed: the fastest speed whose lock',
    '      // is enough. A path tighter than full lock with the margin cannot be followed any better slower (below ~52 km/h',
    '      // the radius at full lock does not shrink any more): the car turns its tightest, so the target is the top of the',
    '      // full-lock range (or the grip speed below it), not a crawl.',
    '      var lk0 = steerLockAt(MIN_SPEED, bank, turnSign);',
    hook ? '      if (global.HT_STEER && global.HT_STEER.cliff && lk0 < x) v = MIN_SPEED; else' : null,
    '      if (lk0 < x) x = lk0;',
    '      if (steerLockAt(v, bank, turnSign) < x) {',
    '        var a = MIN_SPEED, b = v, c;',
    '        for (var n = 0; n < 24; n++) { c = 0.5 * (a + b); if (steerLockAt(c, bank, turnSign) >= x) a = c; else b = c; }',
    '        v = a;',
    '      }',
    '    } else if (x >= STEER_LOCK) v = MIN_SPEED;',
    '    else v = Math.min(v, STEER_SPEED_REF * Math.sqrt(STEER_LOCK / x - 1));'].filter(x => x !== null).join('\n'), 'cornerSpeed');
  return crlf ? s.split('\n').join('\r\n') : s;
}

// ------------------------------------------------------------------ the other files the law touches
function edit(file, edits) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8'), crlf = raw.indexOf('\r\n') >= 0;
  let s = lf(raw);
  for (const [a, b, what] of edits) s = rep(s, a, b, file + ' ' + what);
  return crlf ? s.split('\n').join('\r\n') : s;
}
// devtests/car-v6/car-v5.js: the golden-rule oracle gets the same law (module level: the reference car only)
function carV5() {
  const fn = lockFn(false).split('\n').map(l => l.replace(/^    /, '  ')).join('\n').replace('s.latBase', 'LAT_BASE');
  return edit('devtests/car-v6/car-v5.js', [
    ['  var STEER_LOCK = 0.35;            // rad at standstill\n  var STEER_SPEED_REF = 22;         // m/s; lock = STEER_LOCK / (1 + (v/ref)^2)\n',
     '  var STEER_LOCK = 0.35;            // rad at standstill\n  var STEER_SPEED_REF = 22;         // m/s; lock = STEER_LOCK / (1 + (v/ref)^2)\n' +
     '  // v6.2 (js/car.js steerLockAt, the reference car): full lock 0.40 rad at low speed, never less than asks 1.25 x the\n' +
     '  // mechanical grip, more on a real banked corner (in full from 9 deg). The golden rule holds against this law.\n' +
     '  var STEER_LOCK_MAX = 0.40, STEER_LOW_GRIP = 1.25, STEER_BANK_FROM = 6 * Math.PI / 180, STEER_BANK_TO = 9 * Math.PI / 180;\n', 'constants'],
    ['  // Tuning + the load model itself, for other modules (racing line) so they use the same physics.\n  F1.CAR_PERF = {',
     fn + '\n  // Tuning + the load model itself, for other modules (racing line) so they use the same physics.\n  F1.CAR_PERF = {', 'steerLockAt'],
    ['    wheelbase: WHEELBASE, steerLock: STEER_LOCK, steerSpeedRef: STEER_SPEED_REF,',
     '    wheelbase: WHEELBASE, steerLock: STEER_LOCK, steerSpeedRef: STEER_SPEED_REF,\n    steerLockMax: STEER_LOCK_MAX, steerLowGrip: STEER_LOW_GRIP, steerLockAt: steerLockAt,', 'perf'],
    ['      var ratio = av / STEER_SPEED_REF;\n      var delta = state.steer * STEER_LOCK / (1 + ratio * ratio);',
     '      var delta = state.steer === 0 ? 0 : state.steer * steerLockAt(av, Math.atan(slopeLeft), state.steer);', 'delta']
  ]);
}
// tools/build-cars.mjs: its copy of the racing line's speed profile (checked against F1.buildRaceLine at start-up)
function buildCars() {
  return edit('tools/build-cars.mjs', [
    ['  const x = Math.atan(p.wheelbase * k * STEER_MARGIN);\n  if (x >= p.steerLock) v = MIN_SPEED;\n  else v = Math.min(v, p.steerSpeedRef * Math.sqrt(p.steerLock / x - 1));',
     ['  let x = Math.atan(p.wheelbase * k * STEER_MARGIN);',
      '  if (typeof p.steerLockAt === \'function\') {           // = js/raceline.js cornerSpeed (v6.2): the car\'s own lock law',
      '    const lk0 = p.steerLockAt(MIN_SPEED, bank, turnSign);',
      '    if (lk0 < x) x = lk0;',
      '    if (p.steerLockAt(v, bank, turnSign) < x) {',
      '      let a = MIN_SPEED, b = v;',
      '      for (let n = 0; n < 24; n++) { const c = 0.5 * (a + b); if (p.steerLockAt(c, bank, turnSign) >= x) a = c; else b = c; }',
      '      v = a;',
      '    }',
      '  } else if (x >= p.steerLock) v = MIN_SPEED;',
      '  else v = Math.min(v, p.steerSpeedRef * Math.sqrt(p.steerLock / x - 1));'].join('\n'), 'cornerSpeed']
  ]);
}
// devtests/seasons-calib/driver.mjs: the calibration autopilot steers with the car's own lock law
function driverMjs() {
  return edit('devtests/seasons-calib/driver.mjs', [
    ['    const lock = 0.35 / (1 + (v / 22) * (v / 22));',
     '    const lock = typeof car.perf.steerLockAt === \'function\' ? car.perf.steerLockAt(v, S[st.sampleIndex].bank || 0, kap >= 0 ? 1 : -1) :\n' +
     '      0.35 / (1 + (v / 22) * (v / 22));', 'lock']
  ]);
}
// js/audio.js: the tyre-scrub guess for cars whose state has no slip (remote cars) uses the car's lock law
function audio() {
  return edit('js/audio.js', [
    ['          r = av / PH.steerSpeedRef;\n          req = av * av * Math.abs(Math.tan(t * PH.steerLock / (1 + r * r))) / PH.wheelbase;',
     '          r = av / PH.steerSpeedRef;\n' +
     '          r = F1.CAR_PERF && typeof F1.CAR_PERF.steerLockAt === \'function\' ? F1.CAR_PERF.steerLockAt(av, 0, t) : PH.steerLock / (1 + r * r);\n' +
     '          req = av * av * Math.abs(Math.tan(t * r)) / PH.wheelbase;', 'scrub']
  ]);
}
// js/car.js on top of the law (for the cockpit cues): the tyres' load and the road's share of it
function carCues(src) {
  const crlf = src.indexOf('\r\n') >= 0;
  let s = lf(src);
  s = rep(s, '      vib: 0                          // 0..1 flat spots / puncture (js/tyres.js)',
    '      vib: 0,                         // 0..1 flat spots / puncture (js/tyres.js)\n' +
    '      load: 1,                        // (v6.2) g: the tyres\' normal load (1 standing on a flat road; downforce, banking, dips)\n' +
    '      compress: 0                     // (v6.2) g: its share from the road\'s shape: banking, dips (> 0), crests (< 0)', 'state');
  s = rep(s, '    var eDep = 0, eHar = 0, stepSlip = 0, punct = 0;', '    var eDep = 0, eHar = 0, stepSlip = 0, punct = 0, stepLoad = GRAVITY, stepComp = 0;', 'vars');
  s = rep(s, '      state.deploy = state.harvest = state.slip = 0;', '      state.deploy = state.harvest = state.slip = 0;\n      state.load = 1; state.compress = 0;', 'reset');
  s = rep(s, '      var an = A0 - aLeft * sr;               // tyre load incl. the centripetal part\n      if (an < AN_MIN) an = AN_MIN;',
    '      var an = A0 - aLeft * sr;               // tyre load incl. the centripetal part\n      if (an < AN_MIN) an = AN_MIN;\n' +
    '      stepLoad = an; stepComp = an - GRAVITY - K.downforce * v * v;', 'an');
  s = rep(s, '      state.slip = stepSlip;', '      state.slip = stepSlip;\n      state.load = stepLoad / GRAVITY; state.compress = stepComp / GRAVITY;', 'out');
  return crlf ? s.split('\n').join('\r\n') : s;
}
// js/cockpit.js: the visual cues of the banking / road shape
function cockpit() {
  return edit('js/cockpit.js', [
    ['  var BLUR_SPEED = 7;              // m/s: above this the sidewall lettering is drawn motion-blurred\n',
     '  var BLUR_SPEED = 7;              // m/s: above this the sidewall lettering is drawn motion-blurred\n' +
     '  // road shape cues (v6.2): the camera used to roll 1:1 with the car, so a banked road stayed level on screen and only\n' +
     '  // the scenery leaned (Zandvoort / Madring "not felt"). The driver\'s head keeps part of the roll out (the banking\n' +
     '  // then reads as the road and the cockpit tilting) and sinks / nods under the road\'s compression (car.state.compress:\n' +
     '  // banking, dips; it rises over crests).\n' +
     '  var HEAD_ROLL_KEEP = 0.45;       // share of the car\'s roll the head takes out (0 = the v6.1 camera)\n' +
     '  var HEAD_ROLL_TAU = 0.25;        // s: the neck follows the car\'s roll this much later\n' +
     '  var COMPRESS_EYE = 0.012;        // m the eye sinks per g of compression\n' +
     '  var COMPRESS_NOD = 0.004;        // rad the head nods down per g\n' +
     '  var COMPRESS_MIN = -1, COMPRESS_MAX = 2.5, COMPRESS_TAU = 0.08;   // g, g, s\n', 'constants'],
    ['    var lastHeading = null, latG = 0, shake = 0, time = 0, fov = FOV_MIN, wheelAngle = 0, vibPhase = 0;',
     '    var lastHeading = null, latG = 0, shake = 0, time = 0, fov = FOV_MIN, wheelAngle = 0, vibPhase = 0;\n' +
     '    var headRoll = 0, comp = 0;     // v6.2: the roll the head follows (smoothed), the compression (g, smoothed)', 'state'],
    ['      // head leans slightly into the corner\n      camera.position.set(latG * 0.006 + ox + hx, EYE_Y + oy, EYE_Z + hz);\n      camera.rotation.set(rx + lookPitch, Math.PI + lookYaw, latG * 0.005 + rz);',
     '      // road shape: the head keeps HEAD_ROLL_KEEP of the roll out, about the car\'s forward axis whatever the look (in the\n' +
     '      // YXZ look angles: x -= a sin(yaw), z += a cos(yaw); rotation.y stays PI + yaw, which main.js reads for the\n' +
     '      // listener), and sinks / nods with the compression\n' +
     '      headRoll += ((state.roll || 0) - headRoll) * (dt > 0 ? Math.min(1, dt / HEAD_ROLL_TAU) : 1);\n' +
     '      var cmp = num(state.compress) ? Math.max(COMPRESS_MIN, Math.min(COMPRESS_MAX, state.compress)) : 0;\n' +
     '      comp += (cmp - comp) * (dt > 0 ? Math.min(1, dt / COMPRESS_TAU) : 1);\n' +
     '      var hr = HEAD_ROLL_KEEP * headRoll;\n' +
     '\n' +
     '      // head leans slightly into the corner\n' +
     '      camera.position.set(latG * 0.006 + ox + hx, EYE_Y + oy - COMPRESS_EYE * comp, EYE_Z + hz);\n' +
     '      camera.rotation.set(rx + lookPitch - COMPRESS_NOD * comp - hr * Math.sin(lookYaw), Math.PI + lookYaw,\n' +
     '        latG * 0.005 + rz + hr * Math.cos(lookYaw));', 'camera']
  ]);
}

// devtests/cockpit-test/api.test.js: the v5 camera identity on a level road (the cues only act on roll / compression),
// and a check of the cues themselves
function cockpitTest() {
  return edit('devtests/cockpit-test/api.test.js', [
    ['  const s = { x: 3, y: 1, z: -7, heading: 0.4, speed: 0, steer: 0, pitch: 0.02, roll: -0.03, onGrass: false, hit: 0 };',
     '  const s = { x: 3, y: 1, z: -7, heading: 0.4, speed: 0, steer: 0, pitch: 0.02, roll: 0, onGrass: false, hit: 0 };   // (level: v6.2 cues off)', 'level'],
    ['  check(\'camera (pose, FOV, shake, look) identical to the v5 cockpit over 600 frames\', maxd === 0, { maxDiff: maxd });',
     ['  check(\'camera (pose, FOV, shake, look) identical to the v5 cockpit over 600 frames\', maxd === 0, { maxDiff: maxd });',
      '',
      '  // v6.2 road-shape cues: on a 19 deg bank the view tilts by 55 % of the roll (the head keeps 45 % out, about the car\'s',
      '  // forward axis also while looking aside), and the eye sinks 1.2 cm per g of compression',
      '  {',
      '    const cc = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000), nc = F1.createCockpit(cc);',
      '    const st = { x: 0, y: 0, z: 0, heading: 0, speed: 50, steer: 0, pitch: 0, roll: -0.33, compress: 1.5, onGrass: false, hit: 0 };',
      '    for (let i = 0; i < 240; i++) nc.update(st, 1 / 60);',
      '    nc.group.updateMatrixWorld(true);',
      '    const e = cc.matrixWorld.elements, tilt = Math.atan2(Math.hypot(e[4], e[6]), e[5]);',
      '    check(\'road-shape cues: the view tilts 55 % of a 19 deg bank, the eye sinks 1.8 cm at 1.5 g of compression\',',
      '      Math.abs(tilt - 0.55 * 0.33) < 0.005 && Math.abs(cc.position.y - (0.80 - 0.018)) < 0.002, { tilt: tilt, eyeY: cc.position.y });',
      '    nc.setLook(1, 0);',
      '    for (let i = 0; i < 240; i++) nc.update(st, 1 / 60);',
      '    nc.group.updateMatrixWorld(true);',
      '    const f = cc.matrixWorld.elements, tilt2 = Math.atan2(Math.hypot(f[4], f[6]), f[5]);',
      '    check(\'road-shape cues: looking aside, the counter-roll stays about the car\\\'s forward axis (the view tilts no more)\',',
      '      Math.abs(tilt2 - 0.55 * 0.33) < 0.01, { tilt: tilt2 });',
      '    nc.dispose();',
      '  }'].join('\n'), 'cues']
  ]);
}

// test/cars.test.js: the 4-circuit spot check of the era index after the recalibration with the new law measured
// 2010..2025 within 0.57 %, 2026 +0.84 % (its 0.6 % had been +0.56 % before: COTA and Zandvoort now respond to grip)
function carsTest() {
  return edit('test/cars.test.js', [
    ['// over all 40 circuits; any four must stay within 0.6 % (single circuits scatter by 1..2 % in the low-downforce years).',
     '// over all 40 circuits; any four must stay within 1.0 % (single circuits scatter by 1..2 % in the low-downforce years;\n' +
     '// since the v6.2 steering law the slow and banked corners respond to grip too: 2026 +0.84 % on these four).', 'comment'],
    ['median within 0.6 % every season', 'median within 1.0 % every season', 'title'],
    ['    assert(Math.abs(err) <= 0.006, s.year + \': \' + r.toFixed(4) + \' vs index \' + s.paceIndex);',
     '    assert(Math.abs(err) <= 0.010, s.year + \': \' + r.toFixed(4) + \' vs index \' + s.paceIndex);', 'tolerance']
  ]);
}

fs.writeFileSync(path.join(OUT, 'car-x.js'), car(true));
fs.writeFileSync(path.join(OUT, 'api.test.proposed.js'), cockpitTest());
fs.writeFileSync(path.join(OUT, 'cars.test.proposed.js'), carsTest());
fs.writeFileSync(path.join(OUT, 'car.proposed.js'), car(false));
fs.writeFileSync(path.join(OUT, 'raceline-x.js'), raceline(true));
fs.writeFileSync(path.join(OUT, 'raceline.proposed.js'), raceline(false));
fs.writeFileSync(path.join(OUT, 'car-v5.proposed.js'), carV5());
fs.writeFileSync(path.join(OUT, 'build-cars.proposed.mjs'), buildCars());
fs.writeFileSync(path.join(OUT, 'driver.proposed.mjs'), driverMjs());
fs.writeFileSync(path.join(OUT, 'audio.proposed.js'), audio());
fs.writeFileSync(path.join(OUT, 'car.cues.js'), carCues(car(false)));
fs.writeFileSync(path.join(OUT, 'cockpit.proposed.js'), cockpit());
for (const [orig, prop, name] of [['js/car.js', 'car.proposed.js', 'car'], ['js/raceline.js', 'raceline.proposed.js', 'raceline'],
  ['devtests/car-v6/car-v5.js', 'car-v5.proposed.js', 'car-v5'], ['tools/build-cars.mjs', 'build-cars.proposed.mjs', 'build-cars'],
  ['devtests/seasons-calib/driver.mjs', 'driver.proposed.mjs', 'calib-driver'], ['js/audio.js', 'audio.proposed.js', 'audio'],
  ['devtests/handling-test/variants/car.proposed.js', 'car.cues.js', 'car-cues'], ['js/cockpit.js', 'cockpit.proposed.js', 'cockpit'],
  ['devtests/cockpit-test/api.test.js', 'api.test.proposed.js', 'cockpit-test'], ['test/cars.test.js', 'cars.test.proposed.js', 'cars-test']]) {
  let d = '';
  const rel = path.relative(ROOT, path.join(OUT, prop)).split(path.sep).join('/');
  try { d = cp.execSync(`git diff --no-index -- "${orig}" "${rel}"`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { d = e.stdout || ''; }
  fs.writeFileSync(path.join(OUT, name + '.diff'), d);
}
console.log('variants written to', OUT);
