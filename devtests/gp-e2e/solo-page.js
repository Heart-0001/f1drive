// Lives in the PAGE (injected by devtests/gp-e2e/solo.js with executeJavaScript, before a track is picked):
// window.__e = time warp + fake controller + autopilot + observers. Nothing in here writes car.state or the
// session: the car is driven through navigator.getGamepads (a standard-mapping pad), everything else only reads.
//
//   time warp   window.requestAnimationFrame / cancelAnimationFrame are replaced by a queue that __e.run() pumps with
//               synthetic timestamps 1/60 s apart (or another pace: setPace), as fast as the machine allows. main.js
//               derives dt from them, so the physics step and dt are what they are in real time. renderer.render is
//               skipped inside pumped frames (every __e.renderEvery-th frame is drawn for real, and __e.draw() draws
//               one for a screenshot).
//   observers   __e.log: gp events (phase / go / lapRejected), every gp.lapDone() call with what the session and the
//               HUD said right after it, ground-truth line crossings (the car's own continuous position, counted in
//               physics steps), toasts and the HUD lap texts as they changed, the start procedure frame by frame.
//               The two wrappers (car.update, gp.lapDone) call straight through: they only look.
//   v6 (additive; used by solo.js and solo-v6.js, harmless for the other harnesses that inject this file):
//               - held steps: while the car is held in its pit box for a service main.js runs pit.update + lap.update
//                 but no car.update; E.hookCar also wraps pit.update and counts those steps into E.truth.steps (they
//                 are on the lap clock: a stop costs time) and E.truth.held.
//               - every F1.ui.toast() call is logged ('toastCall', game clock): the toast ELEMENT hides on a wall-clock
//                 timer, which says nothing under the warp.
//               - F1.telemetry.clock is the game clock (its smoothing / flashing would lag hundreds of frames behind the
//                 warp otherwise); E.tel is the object the telemetry graphic drew last (main.js's live hud object).
//               - E.pitPlan(o): a pit-lane driver (ap.mode 'pit': the control law of devtests/car-v6/pit-drive.js /
//                 v6-smoke/page.js) through the same fake controller: into the own box, wait, out again.
//               - ap.ers = {min, vMin}: a battery manager for the line autopilot (RB held on straights, see ap.step).
//               - ap.gripPace = true: the line autopilot slows down for worn tyres (by the square root of the grip left).
(function () {
  'use strict';
  if (window.__e) return 'already';
  var F1 = window.F1;
  var STEP = 1 / 120, FRAME_MS = 1000 / 60, CLOCK_BASE = 1000000;
  // clock: the offline session clock as it must be (js/gp.js starts at CLOCK_BASE and adds dt * 1000 per frame: the same
  // additions in the same order here, so the two must be bit-identical)
  var E = window.__e = { t: 1000, frames: 0, gameFrames: 0, clock: CLOCK_BASE, dt: 0, log: [], n: {}, renders: 0, skipped: 0,
    renderEvery: 0, fatal: '', clockErr: 0, grid: [], visChanges: 0 };

  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function ev(type, o) {
    o = o || {};
    o.type = type; o.f = E.gameFrames; o.clock = E.clock; o.i = E.log.length;
    E.log.push(o);
    E.n[type] = (E.n[type] || 0) + 1;
    return o;
  }

  /* ================= time warp ================= */
  var queue = [], rafSeq = 0, dispatching = false, mirrorLastT = 0;
  // frame pacing: 1/60 s by default; setPace(ms, jitter) for another rate / an irregular one (5..35 ms, a fixed
  // pseudo-random sequence); stall(ms) makes the next frame that late (main.js clamps dt to 0.25 s)
  var pace = { ms: FRAME_MS, jitter: false, seed: 20260930, stall: 0 };
  E.setPace = function (ms, jitter) { pace.ms = ms > 0 ? ms : FRAME_MS; pace.jitter = !!jitter; return true; };
  E.stall = function (ms) { pace.stall = ms; return true; };
  function delta() {
    if (pace.stall) { var st = pace.stall; pace.stall = 0; return st; }
    if (!pace.jitter) return pace.ms;
    pace.seed = (pace.seed * 1103515245 + 12345) % 2147483648;
    return 5 + 30 * pace.seed / 2147483648;
  }
  window.requestAnimationFrame = function (fn) {
    // outside a frame = main.js resume(): it has forgotten its last timestamp, so its first frame has dt 0
    if (!dispatching) mirrorLastT = 0;
    queue.push({ id: ++rafSeq, fn: fn });
    return rafSeq;
  };
  window.cancelAnimationFrame = function (id) {
    for (var i = 0; i < queue.length; i++) if (queue[i].id === id) { queue.splice(i, 1); return; }
  };
  document.addEventListener('visibilitychange', function () { E.visChanges++; });   // (main.js would reset lastT)

  function tick() {
    E.t += delta(); E.frames++;
    if (!queue.length) return false;
    var cbs = queue, dt = mirrorLastT ? (E.t - mirrorLastT) / 1000 : 0;   // exactly main.js frame()
    queue = []; mirrorLastT = E.t;
    if (dt > 0.25) dt = 0.25;
    E.dt = dt; E.clock += dt * 1000; E.gameFrames++;
    dispatching = true;
    try {
      if (ap.on) ap.step();
      for (var i = 0; i < cbs.length; i++) cbs[i].fn(E.t);
    } finally { dispatching = false; }
    observe();
    return true;
  }

  var conds = {};
  // Pump up to maxFrames game frames, until cond (a JS expression; E, F1, g = F1.game in scope) holds, the game
  // stops asking for frames (menu), an error overlay appears, or budgetMs of wall time have gone by.
  E.run = function (maxFrames, cond, budgetMs) {
    var fn = cond ? (conds[cond] || (conds[cond] = new Function('E', 'F1', 'g', 'return (' + cond + ');'))) : null;
    var t0 = performance.now(), n = 0, hit = false, idle = false;
    if (fn && fn(E, F1, F1.game)) hit = true;
    while (!hit && n < maxFrames) {
      if (!tick()) { idle = true; break; }
      n++;
      if (E.fatal) break;
      if (fn && fn(E, F1, F1.game)) { hit = true; break; }
      if ((n & 31) === 0 && performance.now() - t0 > (budgetMs || 150)) break;
    }
    return { n: n, hit: hit, idle: idle, fatal: E.fatal, f: E.gameFrames, clock: E.clock, wall: performance.now() - t0 };
  };
  // Synthetic time goes by while nothing asks for frames (the menu is open). -> false when the game IS running.
  E.spin = function (frames) {
    if (queue.length) return false;
    for (var i = 0; i < frames; i++) { E.t += delta(); E.frames++; }
    return true;
  };
  E.queued = function () { return queue.length; };

  /* ---------- rendering: skipped inside pumped frames ---------- */
  E.hookRenderer = function () {
    if (E.renderer || E.scene) return true;
    var o = F1.game.camera;
    while (o && !o.isScene) o = o.parent;
    if (!o) return false;
    E.scene = o;
    o.onBeforeRender = function (r) {               // three.js hands the renderer to the scene
      delete o.onBeforeRender;
      if (E.renderer) return;
      E.renderer = r; E.renders++;                  // (this very frame is being drawn for real)
      var real = r.render, skipping = false;
      E.realRender = function () { E.renders++; skipping = false; real.call(r, E.scene, F1.game.camera); };
      r.render = function (s, c) {
        // (v6: renders started from inside the main one - the cockpit's live mirrors, from the glass's onBeforeRender -
        //  go through and are not counted; skipping them breaks three.js's render state in the main render.
        //  v6.1: the HUD mirrors (js/hudmirrors.js) render right AFTER the main render, not inside it: in a frame whose
        //  main render was skipped they are skipped too - they save and restore the renderer's state themselves)
        if (c !== F1.game.camera) { if (skipping) return; return real.call(r, s, c); }
        if (dispatching && !(E.renderEvery > 0 && E.gameFrames % E.renderEvery === 0)) { E.skipped++; skipping = true; return; }
        skipping = false;
        E.renders++;
        return real.call(r, s, c);
      };
    };
    return true;
  };
  // one real frame for a screenshot: the main render and the HUD mirrors over it (their last pose)
  E.draw = function () {
    if (!E.realRender) return false;
    E.realRender();
    var hm = F1.game && F1.game.hudMirrors;
    if (hm) hm.render();
    return true;
  };

  /* ================= fake controller ================= */
  (function () {
    var b = [];
    for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
    E.rumbles = 0;
    E.pad = { index: 0, id: 'Autopilot Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard',
      timestamp: 0, axes: [0, 0, 0, 0], buttons: b,
      vibrationActuator: { type: 'dual-rumble', playEffect: function () { E.rumbles++; return Promise.resolve('complete'); } } };
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return [E.pad, null, null, null]; } });
  })();
  function btn(i, v) { var x = E.pad.buttons[i]; x.value = v; x.pressed = v > 0.5; }
  // what js/gamepad.js must turn back into throttle / brake 0..1 and steer -1..1 (+1 = left): its trigger deadzone
  // (0.04), radial stick deadzone (0.12) and steering expo (1.6) are inverted here
  function setPad(thr, brk, steer) {
    btn(7, thr > 0 ? (thr >= 1 ? 1 : 0.04 + 0.96 * thr) : 0);
    btn(6, brk > 0 ? (brk >= 1 ? 1 : 0.04 + 0.96 * brk) : 0);
    E.pad.axes[0] = steer === 0 ? 0 : -(steer > 0 ? 1 : -1) * (0.12 + 0.88 * Math.pow(Math.min(1, Math.abs(steer)), 1 / 1.6));
    E.pad.axes[1] = 0;
    ap.thr = thr; ap.brk = brk; ap.want = steer;
  }

  /* ================= ground truth: the car's own continuous position ================= */
  // track.locate with a local window (never the global re-locate that makes car.state.sampleIndex jump at Suzuka),
  // unwrapped: U < 0 = before the line. A crossing of the line is logged with the number of physics steps so far.
  var T = E.truth = { track: null, N: 0, idx: 0, U: 0, lines: 0, steps: 0, cut: false, held: 0 };
  var carStepped = false;                     // car.update ran since the last pit.update (else: a held step)
  function wrapN(d) { var N = T.N; return d > N / 2 ? d - N : (d < -N / 2 ? d + N : d); }
  function newStats() { return { frames: 0, grass: 0, hits: 0, maxHit: 0, vmax: 0, reverses: 0, resets: 0, maxOut: -99 }; }
  // the car was placed (track loaded, qualifying start, grid) or timing starts again (back to free practice)
  function rebase(why) {
    var car = F1.game.car;
    if (!car || !T.track) return;
    var i = car.state.sampleIndex;
    // (sample 0 is already past the line, which lies between the last sample and sample 0: js/laps.js starts the timing at
    //  the NEXT crossing then, a lap later)
    T.idx = i; T.U = i === 0 ? 0 : i - T.N; T.lines = i === 0 ? 1 : 0; T.cut = false;
    ev('placed', { why: why, idx: i, steps: T.steps });
  }
  E.frac = function () { return T.U >= 0 ? (T.U % T.N) / T.N : T.U / T.N; };   // of the lap; negative before the line
  T.jump = function (i) {                     // the autopilot leaves the road for another one (Suzuka shortcut)
    var d = i - T.idx;
    T.U += d; T.idx = i; T.cut = true;
    ev('truth-jump', { to: i, by: d });
  };
  E.hookCar = function () {
    var car = F1.game.car;
    if (!car) return false;
    if (car.__e) return true;
    car.__e = true;
    var orig = car.update;
    car.update = function (dt, input, track) {
      orig.call(car, dt, input, track);
      if (track !== T.track) { T.track = track; T.N = track.samples.length; rebase('track'); }
      if (!input) return;                     // main.js placeOnGrid: re-locating only
      var st = car.state;
      T.steps++; carStepped = true;
      var i = track.locate(st.x, st.z, T.idx).index, d = wrapN(i - T.idx);
      T.U += d; T.idx = i;
      var k = Math.floor(T.U / T.N);
      if (k >= T.lines) {
        T.lines = k + 1;
        var ps = F1.game.pit ? F1.game.pit.state : null;
        ev('cross', { steps: T.steps, line: k, cut: T.cut, phase: F1.gp.phase, stats: ap.stats, lapTime: F1.game.lap ? F1.game.lap.time : null,
          held: T.held, inLane: !!(ps && ps.inLane), d: st.d });
        T.cut = false; ap.stats = newStats();
      }
    };
    T.track = F1.game.track; T.N = T.track.samples.length;
    rebase('hook');
    hookPit();
    return true;
  };
  // A step in which main.js ran pit.update without car.update: the car is held in its box for the service, the lap clock
  // runs on (js/main.js frame(): lap.update(idx, 0, STEP)). Counted into the ground truth.
  function hookPit() {
    var p = F1.game.pit;
    if (!p || p.__e) return;
    p.__e = true;
    var orig = p.update;
    p.update = function () {
      if (!carStepped) { T.steps++; T.held++; }
      carStepped = false;
      return orig.apply(p, arguments);
    };
  }

  /* ================= autopilot ================= */
  // The control law of devtests/raceline-test/test.js / laps-test/drive.js: throttle / brake from the racing line's
  // own advice (raceLine.levels, the colour of the line just ahead), pure-pursuit steering at a point of the line
  // 7..35 m ahead - here as an analog stick instead of left / right keys. Plus recovery: off the road it slows down
  // and steers back, stuck against a wall it reverses out, and as a last resort (facing the wrong way for a second, or
  // stuck again) it presses Y (reset to the track; A until the v6.1 pad layout of js/gamepad.js).
  var ap = E.ap = { on: false, mode: 'idle', thr: 0, brk: 0, want: 0, still: 0, wrong: 0, rev: 0, lastRecov: -1e9,
    resetState: 0, resetTries: 0, cutPlan: null, cut: null, stats: newStats(), padErr: 0, boost: false, ers: null, pit: null };
  ap.step = function () {
    var g = F1.game, car = g.car, track = g.track, rl = g.raceLine;
    if (!car || !track || !rl || ap.mode === 'idle') { setPad(0, 0, 0); btn(3, 0); setBoost(false); return; }
    var st = car.state, S = track.samples, N = S.length, ds = track.length / N, P = rl.points;
    var v = Math.max(0, st.speed), idx = T.track === track ? T.idx : st.sampleIndex;
    var locked = g.gp.inputLocked, thr = 0, brk = 0, want = 0;
    ap.ersOpen = false; ap.ersWant = false; ap.ersStraight = false;
    function pursue(tp) {
      var dx = tp.x - st.x, dz = tp.z - st.z, lat = dx * Math.cos(st.heading) - dz * Math.sin(st.heading);
      var d2 = dx * dx + dz * dz, kap = d2 > 1e-6 ? 2 * lat / d2 : 0, lock = 0.35 / (1 + (v / 22) * (v / 22));
      return clamp(Math.atan(kap * 3.6) / lock, -1, 1);
    }
    // what the pad gave the game in the previous frame, against what was asked for (the input path is the real one)
    if (ap.checkPad && F1.gamepad) {
      var ps = F1.gamepad.state, e = Math.max(Math.abs(ps.steer - ap.want), Math.abs(ps.throttle - ap.thr), Math.abs(ps.brake - ap.brk),
        ps.boost === ap.boost ? 0 : 1);
      if (e > ap.padErr) ap.padErr = e;
    }
    ap.checkPad = true;

    if (ap.mode === 'pit') { setBoost(false); btn(3, 0); pitStep(); return; }

    if (ap.upset) {
      // (a test of the recovery, asked for by the harness: the car is thrown off through the same controller.
      //  'wall': full throttle and full lock for u.time seconds; 'spin': slow down, then full lock until it faces backwards)
      var u = ap.upset, herr = wrapPi(st.heading - Math.atan2(S[idx].tx, S[idx].tz));
      if (u.steer === undefined) u.steer = st.d > 0 ? -1 : 1;          // (spin: towards the side with more room)
      if ((u.time -= E.dt) >= 0 && (u.kind !== 'spin' || Math.abs(herr) <= 2.6)) {
        if (u.kind === 'spin') setPad(v < 8 ? 1 : 0, v > 10 ? 1 : 0, v > 10 ? 0 : u.steer);
        else setPad(1, 0, u.steer);
        btn(3, 0); setBoost(false);
        tally(st, S[idx].halfW || track.halfWidth);
        return;
      }
      ap.upset = null; ap.still = 0; ap.wrong = 0;
      ev('ap-upset-end', { kind: u.kind, idx: idx, d: st.d, v: st.speed, herr: herr, grass: st.onGrass, stats: JSON.parse(JSON.stringify(ap.stats)) });
    }

    if (ap.mode === 'cut') {
      // Suzuka: along the centreline of road a to the crossing, then onto road b (laps-test/drive.js turnOnto)
      var c = ap.cut;
      if (!c.onB && wrapN(idx - c.a) >= -5) { c.onB = true; T.jump(c.b - 2); idx = T.idx; ev('ap-cut', { a: c.a, b: c.b, v: v }); }
      want = pursue(S[(idx + 5) % N]);
      thr = v < 8 ? 1 : 0; brk = v > 10 ? 1 : 0;
      if (c.onB && wrapN(idx - c.b) > 100) { ap.mode = 'line'; ap.cut = null; ap.cutPlan = null; ev('ap-cut-done', { idx: idx, carIdx: st.sampleIndex }); }
    } else {
      // advice for where the car really is (main.js redraws it after the physics). ap.gripPace (v6, off by default): the
      // racing line's speeds are for new tyres; with worn ones (grip multipliers g < 1) the line is asked about a car
      // 1 / sqrt(g) faster than this one, so it brakes earlier and corners slower by sqrt(g) (cornering speed ~ sqrt(grip))
      var vAdv = st.speed;
      if (ap.gripPace && car.tyres) { var gg = Math.min(car.tyres.state.grip.lat, car.tyres.state.grip.brake); if (gg < 1 && gg > 0.2) vAdv = st.speed / Math.sqrt(gg); }
      rl.update({ sampleIndex: idx, speed: vAdv });
      var lv = rl.levels[2];
      thr = lv < 0.45 || v < 5 ? 1 : 0;
      brk = lv >= 0.6 && v >= 5 ? 1 : 0;
      want = pursue(P[(idx + Math.round(Math.min(35, Math.max(7, 5 + 0.3 * v)) / ds)) % N]);
      if (ap.ers && ap.mode === 'line') ersStep(car, idx, v, lv, N, ds, P);
      if (ap.ers && ap.ersOpen) { thr = 1; brk = 0; }
      if (ap.mode === 'stop') { thr = 0; brk = st.speed > 0.6 ? 1 : 0; }   // (the brake held at a standstill would reverse)
      else if (ap.cutPlan) {
        // slow down for the shortcut: 8 m/s, 40 m before the crossing
        var dist = wrapN(ap.cutPlan.a - idx) * ds;
        if (dist > 0 && dist < 600) {
          var allow = Math.sqrt(64 + 2 * 6 * Math.max(0, dist - 40));
          if (v > allow) { thr = 0; brk = 1; } else if (v > allow - 2) thr = 0;
          if (dist < 120) { ap.mode = 'cut'; ap.cut = { a: ap.cutPlan.a, b: ap.cutPlan.b, onB: false }; }
        }
      }
    }

    var s = S[idx], hw = s.halfW || track.halfWidth;
    if (locked) { thr = 1; brk = 0; ap.still = 0; ap.wrong = 0; ap.rev = 0; }   // full throttle through the start lights
    // (still / wrong / rev: seconds of game time)
    else if (ap.mode !== 'stop') {
      if (st.onGrass && ap.mode === 'line') { if (v > 20) { thr = 0; brk = 1; } else if (v > 12) thr = 0; }   // off: slow down, steer back
      ap.wrong = Math.abs(wrapPi(st.heading - Math.atan2(s.tx, s.tz))) > 1.7 ? ap.wrong + E.dt : 0; // facing the wrong way
      ap.still = Math.abs(st.speed) < 1 && !(ap.rev > 0) ? ap.still + E.dt : 0;                  // not moving
      if (ap.rev > 0) { ap.rev -= E.dt; thr = 0; brk = 1; want = want > 0 ? -1 : 1; }              // reversing out
      else if (ap.resetState === 0 && (ap.still > 2 || ap.wrong > 1)) {
        if (ap.wrong <= 1 && E.clock - ap.lastRecov > 20000) { ap.rev = 1.5; ap.stats.reverses++; ev('ap-reverse', { idx: idx, d: st.d }); }
        else { ap.resetState = 1; ap.resetTries = 0; ap.stats.resets++; ev('ap-reset', { idx: idx, d: st.d, wrong: ap.wrong }); }
        ap.lastRecov = E.clock; ap.still = 0; ap.wrong = 0;
      }
    }
    // Y (reset): a press that a poll() after a long wall-clock gap swallowed is simply repeated
    if (ap.resetState === 1) { btn(3, 1); ap.resetState = 2; }
    else if (ap.resetState === 2) {
      btn(3, 0);
      ap.resetState = (Math.abs(st.d) < 0.05 && Math.abs(st.speed) < 0.5) || ++ap.resetTries > 5 ? 0 : 1;
    }
    setPad(thr, brk, want);
    // the battery (RB held): only what ersStep decided for a full-throttle frame on the line
    setBoost(!!(ap.ers && ap.ersWant && thr === 1 && brk === 0 && !locked && ap.mode === 'line' && !ap.rev && ap.resetState === 0 && !st.onGrass));
    tally(st, hw);
  };

  /* ---------- battery manager (v6): RB held on straights ---------- */
  // ap.ers = { min: battery share kept (default 0.02), vMin: m/s (default 25), reach: braking decel assumed for "nothing to
  // brake for within reach" (m/s^2, default 8) }. A straight = no sample of the racing line within braking reach (from the
  // current speed at `reach` m/s^2, + 0.6 s) is limited below the car's top speed (points[i].limit, which includes the
  // braking curves before the corners). There the battery is deployed while it lasts (above `min`), and the throttle is
  // held open even when the line's advice says lift / brake: js/raceline.js caps every sample at the car's top speed
  // WITHOUT the battery, so a car deploying past it is told to brake on the straight (ap.ersOverrides counts those
  // frames; E.ersLog keeps the first few as evidence). Braking harvests by itself (js/car.js).
  function setBoost(on) { btn(5, on ? 1 : 0); ap.boost = !!on; }
  E.ersLog = [];
  ap.ersOverrides = 0;
  function ersStep(car, idx, v, lv, N, ds, P) {
    var o = ap.ers, top = car.perf && car.perf.topSpeed ? car.perf.topSpeed : 330 / 3.6;
    var dec = o.reach > 0 ? o.reach : 8, reachM = v * v / (2 * dec) + v * 0.6, n = Math.min(N >> 1, Math.ceil(reachM / ds)), k, straight = v > 5;
    for (k = 0; straight && k <= n; k++) if (P[(idx + k) % N].limit < top * 0.999) straight = false;
    ap.ersStraight = straight;
    ap.ersOpen = straight && v > top * 0.97;             // at / past the (unboosted) top speed with nothing to brake for
    if (ap.ersOpen && lv >= 0.45) {
      ap.ersOverrides++;
      if (E.ersLog.length < 12) E.ersLog.push({ clock: E.clock, idx: idx, kmh: v * 3.6, topKmh: top * 3.6, lv: lv, battery: car.state.battery, reachM: reachM });
    }
    ap.ersWant = straight && v > (o.vMin > 0 ? o.vMin : 25) && car.state.battery > (o.min >= 0 ? o.min : 0.02);
  }

  /* ---------- pit-lane driver (v6) ---------- */
  // E.pitPlan({ slot (box, default 0), vLane: m/s between the lines (default 2 km/h under the limit), vLaneOut: m/s from
  // the box to the exit line (default vLane; over the limit after the stop is a new offence, held at the exit line), cruise: the pit
  // limiter holds the speed (throttle open in the lane while F1.game.limiter), out: m to drive on after pit.to (150),
  // then: the ap.mode afterwards ('line') }) -> { ok, run, L, uEn, uEx, ub } or { error }. From where the car is (it must
  // be 40..N/2 samples before pit.from): a target path from its own offset to the lane, into the box, stop, wait for the
  // service (the brake held), out again and back to the centreline; the speed from the path's curvature (A_LAT) and
  // braking (A_BRAKE, A_STOP into the box). The pit limiter is NOT touched: the harness presses Q itself.
  // ap.pit.rec: what happened (see below). E.pitInfo() -> a plain copy.
  var PIT_A_LAT = 9, PIT_A_BRAKE = 7, PIT_A_STOP = 2.5;
  E.pitPlan = function (o) {
    o = o || {};
    var g = F1.game, track = g.track, car = g.car, st = car.state, S = track.samples, N = S.length, ds = track.length / N, pit = track.pit;
    if (!pit) return { error: 'no pit lane' };
    var wq = function (q) { return ((q % N) + N) % N; }, kOf = function (i) { return wq(i - pit.from); };
    var K = kOf(pit.to), kEn = kOf(pit.entry), kEx = kOf(pit.exit), vLim = pit.limitKmh / 3.6;
    var start = T.track === track ? T.idx : st.sampleIndex, run = wq(pit.from - start);
    if (run > N / 2 || run < 40) return { error: 'the car is not before the pit lane (run ' + run + ' samples)' };
    var out = Math.round((o.out || 150) / ds), back = Math.round(100 / ds);
    var L = run + K + out + 40, tgt = new Float64Array(L + 1), vmax = new Float64Array(L + 1), iOf = function (u) { return wq(start + u); };
    var u;
    for (u = 0; u <= L; u++) vmax[u] = 95;
    var slot = o.slot || 0, b = pit.boxes[slot], ub = run + kOf(b.index), d0 = st.d;
    for (u = 0; u <= L; u++) {
      if (u < run) { var f = clamp(u / (run - 10), 0, 1); f = f * f * (3 - 2 * f); tgt[u] = d0 + (pit.laneD(pit.from) - d0) * f; }
      else if (u <= run + K) tgt[u] = pit.laneD(iOf(u));
      else { var f2 = clamp((u - run - K) / back, 0, 1); tgt[u] = pit.laneD(pit.to) * (1 - f2 * f2 * (3 - 2 * f2)); }
    }
    var a0 = ub - Math.round(28 / ds), a1 = ub - Math.round(6 / ds), b0 = ub + Math.round(4 / ds), b1 = ub + Math.round(28 / ds);
    for (u = a0; u <= b1; u++) {
      var fb = u < a1 ? (u - a0) / (a1 - a0) : (u <= b0 ? 1 : 1 - (u - b0) / (b1 - b0));
      fb = clamp(fb, 0, 1); fb = fb * fb * (3 - 2 * fb);
      tgt[u] = tgt[u] + (b.d - tgt[u]) * fb;
    }
    var PP = [];
    for (u = 0; u <= L; u++) { var s = S[iOf(u)]; PP.push([s.x + s.nx * tgt[u], s.z + s.nz * tgt[u]]); }
    for (u = 2; u <= L - 2; u++) {
      var pa = PP[u - 2], pb = PP[u], pc = PP[u + 2];
      var ax = pb[0] - pa[0], az = pb[1] - pa[1], bx = pc[0] - pa[0], bz = pc[1] - pa[1];
      var kap = 2 * Math.abs(ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(pc[0] - pb[0], pc[1] - pb[1]) + 1e-9);
      vmax[u] = Math.min(vmax[u], Math.sqrt(PIT_A_LAT / Math.max(kap, 1e-6)));
    }
    var uEn = run + kEn, uEx = run + kEx, vLane = o.vLane > 0 ? o.vLane : vLim - 2 / 3.6;
    var vOut = o.vLaneOut > 0 ? o.vLaneOut : vLane;           // from the box to the exit line (default vLane)
    for (u = uEn - Math.round(40 / ds); u <= uEx; u++) vmax[u] = Math.min(vmax[u], u > ub ? vOut : vLane);
    vmax[ub] = Math.min(vmax[ub], 2);
    for (u = L - 1; u >= 0; u--) {
      var acc = u < ub && ub - u < 40 / ds ? PIT_A_STOP : PIT_A_BRAKE;
      vmax[u] = Math.min(vmax[u], Math.sqrt(vmax[u + 1] * vmax[u + 1] + 2 * acc * ds));
    }
    ap.pit = {
      active: true, phase: 'approach', U: 0, idx: start, start: start, L: L, run: run, ub: ub, uEn: uEn, uEx: uEx, slot: slot, box: b,
      cruise: !!o.cruise, vLane: vLane, tgt: tgt, vmax: vmax, integ: 0, stopped: null, served: false, stops0: g.pit.state.stops, then: o.then || 'line',
      rec: { maxLaneKmh: 0, cruiseKmh: 0, minLaneKmh: 1e9, hits: 0, grass: 0, maxServiceMove: 0, serviceFrames: 0, frozenBad: 0, svcStartClock: null, svcDoneClock: null,
        svcTotal: null, svcPenalty: null, svcWork: null, svcHeld0: null, svcHeld1: null, svcLap0: null, svcLap1: null, enterClock: null, exitClock: null,
        limiterAtEntry: null, limiterAtExit: null, speedingFrames: 0, penNowFrames: 0, lapNs: [], lapChanges: [],
        holdStartClock: null, holdDoneClock: null, holdTotal: null, holdFrames: 0, holdHeld0: null, holdHeld1: null }
    };
    ap.mode = 'pit';
    ap.on = true;
    ev('pit-plan', { run: run, L: L, uEn: uEn, uEx: uEx, ub: ub, vLane: vLane, cruise: !!o.cruise });
    return { ok: true, run: run, L: L, uEn: uEn, uEx: uEx, ub: ub, K: K };
  };
  E.pitInfo = function () {
    var p = ap.pit; if (!p) return null;
    return { active: p.active, phase: p.phase, U: p.U, L: p.L, uEn: p.uEn, uEx: p.uEx, ub: p.ub, stopped: p.stopped, served: p.served, rec: JSON.parse(JSON.stringify(p.rec)) };
  };
  function pitStep() {
    var pl = ap.pit, g = F1.game, track = g.track, car = g.car, st = car.state, S = track.samples, N = S.length, ds = track.length / N;
    var pit = track.pit, P = g.pit.state, b = pl.box, vLim = pit.limitKmh / 3.6, rec = pl.rec;
    // continuous position along the plan
    var i = track.locate(st.x, st.z, pl.idx).index;
    pl.U += wrapN(i - pl.idx); pl.idx = i;
    var u = clamp(pl.U, 0, pl.L - 1), v = Math.max(0, st.speed);
    // what happened in the last frame
    if (st.hit > 0) rec.hits++;
    var kk = ((st.sampleIndex - pit.from) % N + N) % N;
    if (kk <= ((pit.to - pit.from) % N + N) % N && st.onGrass) rec.grass++;
    if (P.inLane) {
      rec.maxLaneKmh = Math.max(rec.maxLaneKmh, Math.abs(st.speed) * 3.6);
      if (rec.enterClock === null) { rec.enterClock = E.clock; rec.limiterAtEntry = g.limiter; }
      if (P.speeding) rec.speedingFrames++;
    } else if (rec.enterClock !== null && rec.exitClock === null && pl.U > pl.uEx) { rec.exitClock = E.clock; rec.limiterAtExit = g.limiter; }
    if (P.inLane && pl.U > pl.uEn + 10 && pl.U < pl.ub - 60 / ds) {
      rec.cruiseKmh = Math.max(rec.cruiseKmh, st.speed * 3.6);
      rec.minLaneKmh = Math.min(rec.minLaneKmh, st.speed * 3.6);
    }
    if (rec.lapNs[rec.lapNs.length - 1] !== g.lap.n) {
      if (rec.lapNs.length) rec.lapChanges.push({ n: g.lap.n, inLane: P.inLane, carInPit: st.inPit, d: st.d, last: g.lap.last, U: pl.U, clock: E.clock });
      rec.lapNs.push(g.lap.n);
    }
    // the box service (work > 0) and a penalty hold at the exit line (work 0: js/pit.js 'penaltyStart') apart
    var svcBox = !!(P.service && P.service.work > 0), hold = !!(P.service && !(P.service.work > 0));
    if (hold) {
      if (rec.holdStartClock === null) { rec.holdStartClock = E.clock; rec.holdTotal = P.service.total; rec.holdHeld0 = T.held; }
      rec.holdFrames++;
    } else if (rec.holdStartClock !== null && rec.holdDoneClock === null) { rec.holdDoneClock = E.clock; rec.holdHeld1 = T.held; }
    if (svcBox && !pl.stopped) {
      var lx0 = Math.cos(b.heading), lz0 = -Math.sin(b.heading), dd = (b.x - st.x) * Math.sin(b.heading) + (b.z - st.z) * Math.cos(b.heading);
      pl.stopped = { along: -dd, across: (st.x - b.x) * lx0 + (st.z - b.z) * lz0, hd: Math.atan2(Math.sin(st.heading - b.heading), Math.cos(st.heading - b.heading)), inPit: st.inPit, clock: E.clock };
    }
    if (svcBox) {
      if (rec.svcStartClock === null) {
        rec.svcStartClock = E.clock; rec.svcTotal = P.service.total; rec.svcPenalty = P.service.penalty; rec.svcWork = P.service.work;
        rec.svcX = st.x; rec.svcZ = st.z; rec.svcLap0 = g.lap.time; rec.svcHeld0 = T.held;
      }
      rec.serviceFrames++;
      if (P.service.penalty > 0 && P.service.left > P.service.total - P.service.penalty) rec.penNowFrames++;
      var mv = Math.hypot(st.x - rec.svcX, st.z - rec.svcZ);
      if (mv > rec.maxServiceMove) rec.maxServiceMove = mv;
      if (st.speed !== 0) rec.frozenBad++;
    } else if (rec.svcStartClock !== null && rec.svcDoneClock === null) {
      rec.svcDoneClock = E.clock; rec.svcLap1 = g.lap.time; rec.svcLapN = g.lap.n; rec.svcHeld1 = T.held;
    }
    if (pl.U >= pl.L - 40) {
      pl.active = false; pl.phase = 'done'; setPad(0, 0, 0);
      ap.mode = pl.then; ap.still = 0; ap.wrong = 0; ap.rev = 0;
      ev('pit-done', { idx: i, d: st.d, v: st.speed });
      return;
    }

    var vt = pl.vmax[u], fx = Math.sin(b.heading), fz = Math.cos(b.heading);
    var dist = pl.stopped ? Infinity : (b.x - st.x) * fx + (b.z - st.z) * fz;
    if (dist < 25) vt = Math.min(vt, Math.sqrt(2 * 1.2 * Math.max(0, dist - 0.05)) + (dist > 0.05 ? 0.25 : 0));
    var braking = !pl.stopped && dist < 0.06;
    if (P.service || (pl.stopped && !pl.served)) {
      // held for the service: brake held (main.js freezes the car anyway), until the stop is over
      pl.phase = 'service';
      if (!P.service && P.stops > pl.stops0) pl.served = true;
      setPad(0, 1, 0);
      return;
    }
    if (!pl.stopped && (braking || P.service) && v < 0.02) {
      var lx = Math.cos(b.heading), lz = -Math.sin(b.heading);
      pl.stopped = { along: -dist, across: (st.x - b.x) * lx + (st.z - b.z) * lz, hd: Math.atan2(Math.sin(st.heading - b.heading), Math.cos(st.heading - b.heading)), inPit: st.inPit, clock: E.clock };
      setPad(0, 1, 0);
      return;
    }
    pl.phase = pl.stopped ? 'out' : (pl.U < pl.uEn ? 'approach' : 'lane');
    var la = clamp(4 + 0.35 * v, 5, 20), j = clamp(u + Math.round(la / ds), 0, pl.L), s = S[((pl.start + j) % N + N) % N];
    var gx = s.x + s.nx * pl.tgt[j] - st.x, gz = s.z + s.nz * pl.tgt[j] - st.z;
    var sh = Math.sin(st.heading), ch = Math.cos(st.heading);
    var xf = gx * sh + gz * ch, yl = gx * ch - gz * sh;
    var kap = 2 * yl / (xf * xf + yl * yl);
    var PERF = car.perf || F1.CAR_PERF;
    var lock = PERF.steerLock / (1 + (v / PERF.steerSpeedRef) * (v / PERF.steerSpeedRef));
    var steer = clamp(Math.atan(kap * PERF.wheelbase) / lock, -1, 1), thr = 0, brk = 0;
    var cruising = pl.cruise && g.limiter && pl.U >= pl.uEn && vt >= vLim - 2.5 / 3.6 && dist > 30;
    var err = (cruising ? vLim + 5 : vt) - v;
    pl.integ = clamp(pl.integ + err * E.dt * 0.6, 0, 1);
    if (braking) { brk = 1; pl.integ = 0; }
    else if (cruising) thr = 1;
    else if (err > -0.4) thr = clamp(0.35 * err + pl.integ + (vt > 0.5 ? 0.15 : 0), 0, 1);
    else { brk = clamp(-0.3 * err, 0, 1); pl.integ *= 0.9; }
    setPad(thr, brk, steer);
    tally(st, S[i].halfW || track.halfWidth);
  }
  // what happened to the car since the last crossing of the line (st.hit: the strongest impact of the previous frame)
  function tally(st, hw) {
    var o = ap.stats;
    o.frames++;
    if (st.onGrass) o.grass++;
    if (st.hit > 0) { o.hits++; if (st.hit > o.maxHit) o.maxHit = st.hit; }
    if (st.speed > o.vmax) o.vmax = st.speed;
    if (Math.abs(st.d) + 1 - hw > o.maxOut) o.maxOut = Math.abs(st.d) + 1 - hw;
  }

  /* ================= observers ================= */
  var gp = F1.gp;
  // v6: every toast main.js asks for, stamped with the game clock (the element hides on a wall-clock timer)
  E.toasts = [];
  if (F1.ui && F1.ui.toast) {
    var uiToast = F1.ui.toast;
    F1.ui.toast = function (text, ms) {
      if (text) { var t = { text: String(text), ms: ms || 0, clock: E.clock, f: E.gameFrames, phase: gp.phase }; E.toasts.push(t); ev('toastCall', { text: t.text, ms: t.ms, phase: gp.phase }); }
      return uiToast.apply(this, arguments);
    };
  }
  // v6: the broadcast graphic on the game clock; E.tel = what it drew last (main.js's hud object, live)
  E.tel = null; E.telN = 0;
  if (F1.telemetry && typeof F1.telemetry.draw === 'function') {
    F1.telemetry.clock = function () { return E.clock; };
    var telDraw = F1.telemetry.draw;
    F1.telemetry.draw = function (t) { E.tel = t; E.telN++; return telDraw.apply(this, arguments); };
  }
  var el = { toast: $('hud-toast'), err: $('error'), errText: $('error-text'), lap: $('hud-lap'), cur: $('hud-cur'), last: $('hud-last'),
    best: $('hud-best'), gp: $('hud-gp'), gpTitle: $('hud-gp-title'), gpPos: $('hud-gp-pos'), gpLap: $('hud-gp-lap'), gpLapRow: $('hud-gp-laprow'),
    gpRows: $('hud-gp-rows'), lights: $('hud-lights'), lightsText: $('hud-lights-text'), res: $('gp-results') };
  var lamps = el.lights.getElementsByTagName('i');
  function hidden(e) { return e.classList.contains('hidden'); }
  function txt(e) { return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }
  function lampsOn() { var n = 0; for (var i = 0; i < lamps.length; i++) if (lamps[i].classList.contains('on')) n++; return n; }
  function rows(box) {
    return [].map.call(box.querySelectorAll('.gp-row'), function (r) {
      var q = function (c) { var e = r.querySelector(c); return e ? txt(e) : null; };
      return { cls: r.className, pos: q('.gp-pos'), name: q('.mp-pname'), sub: q('.gp-sub'), val: q('.gp-val'), best: q('.gp-best'),
        fl: !!r.querySelector('.gp-best.fl'), dot: (r.querySelector('.mp-dot') || { style: {} }).style.background };
    });
  }
  // the HUD as text, without asking for layout (cheap enough to take inside the pump)
  function hudBrief() {
    return { lap: txt(el.lap), cur: txt(el.cur), last: txt(el.last), best: txt(el.best),
      gpShown: !hidden(el.gp), gpTitle: txt(el.gpTitle), gpPos: txt(el.gpPos).replace(/\s/g, ''), gpLap: txt(el.gpLap), gpLapRow: !hidden(el.gpLapRow),
      rows: rows(el.gpRows), toast: txt(el.toast), toastShown: !hidden(el.toast),
      lights: { shown: !hidden(el.lights), on: lampsOn(), go: el.lights.classList.contains('go'), text: txt(el.lightsText) },
      results: !hidden(el.res) };
  }
  function me() { var s = gp.snapshot; return s && s.players.length ? s.players[0] : null; }
  function meBrief() {
    var p = me(), s = gp.snapshot;
    return p ? { phase: s.phase, sid: s.sid, qLaps: p.qLaps, qBest: p.qBest, qDone: p.qDone, rLaps: p.rLaps, rTime: p.rTime, rBest: p.rBest, fin: p.fin, dnf: p.dnf,
      gap: p.gap, down: p.down } : null;
  }
  function lapBrief() {
    var l = F1.game.lap;
    return l ? { started: l.started, n: l.n, time: l.time, last: l.last, best: l.best, void: l.void, behind: l.behind, jumping: l.jumping, jumps: l.jumps } : null;
  }

  var pending = [];                           // log entries that get the HUD as it is after the frame
  var last = { toast: '', toastShown: false, lap: null, gpLap: null, void: false };
  function observeDom() {
    var t = txt(el.toast), sh = !hidden(el.toast);
    if (t !== last.toast || sh !== last.toastShown) {
      // (hidden again = the wall-clock timer of F1.ui.toast: says nothing about game time)
      if (sh && (t !== last.toast || !last.toastShown)) ev('toast', { text: t, phase: gp.phase });
      last.toast = t; last.toastShown = sh;
    }
    var l = txt(el.lap);
    if (l !== last.lap) { last.lap = l; ev('hudLap', { text: l, phase: gp.phase }); }
    var gl = hidden(el.gp) || hidden(el.gpLapRow) ? null : txt(el.gpLap);
    if (gl !== last.gpLap) { last.gpLap = gl; ev('gpLap', { text: gl, phase: gp.phase }); }
    if (!hidden(el.err) && !E.fatal) { E.fatal = txt(el.errText) || 'error overlay'; ev('fatal', { text: E.fatal }); }
    for (var i = 0; i < pending.length; i++) { pending[i].hud = hudBrief(); pending[i].lapAfter = lapBrief(); pending[i].meAfter = meBrief(); }
    pending.length = 0;
  }
  E.observeDom = function () { observeDom(); return true; };

  function observe() {
    var g = F1.game, st = g.car ? g.car.state : null, lap = g.lap;
    if (!gp.online) { var ce = Math.abs(gp.now() - E.clock); if (ce > E.clockErr) E.clockErr = ce; }
    if (lap && lap.void !== last.void) { last.void = lap.void; ev('void', { on: lap.void, lapN: lap.n, time: lap.time, idx: st.sampleIndex, truth: T.idx }); }
    if (st && (gp.phase === 'grid' || gp.goFlash)) {
      var ps = F1.gamepad ? F1.gamepad.state : { throttle: -1, brake: -1 };
      E.grid.push([E.clock, gp.phase === 'grid' ? 1 : 0, gp.inputLocked ? 1 : 0, gp.lights, lampsOn(), hidden(el.lights) ? 0 : 1,
        el.lights.classList.contains('go') ? 1 : 0, st.speed, st.x, st.z, ps.throttle, st.steer, txt(el.lightsText), gp.goFlash ? 1 : 0, E.gameFrames, T.steps]);
    }
    observeDom();
  }

  gp.on('phase', function (phase, prev) {
    // (main.js's own listener ran first: the car stands where the phase put it)
    if (phase === 'quali' || phase === 'grid' || phase === 'free') rebase(phase);
    // (the HUD is looked at after the frame, or by the next __e.observeDom(): main.js's 'change' listener has not run yet)
    pending.push(ev('phase', { phase: phase, prev: prev, sid: gp.sid, steps: T.steps, gpNow: gp.now(), inFrame: dispatching, me: meBrief(), lap: lapBrief() }));
  });
  gp.on('go', function () {
    pending.push(ev('go', { sinceGo: gp.sinceGo, steps: T.steps, gpNow: gp.now(), goAt: gp.snapshot.goAt, lap: lapBrief(), phase: gp.phase }));
  });
  gp.on('lapRejected', function (why) { ev('lapRejected', { why: why }); });
  var lapDone = gp.lapDone;
  gp.lapDone = function (time) {
    var e = ev('lapDone', { time: time, phase: gp.phase, sid: gp.sid, steps: T.steps, gpNow: gp.now(), lapBefore: lapBrief(), meBefore: meBrief(), truthLine: T.lines - 1 });
    var r = lapDone.apply(gp, arguments);
    e.phaseAfter = gp.phase; e.me = meBrief(); e.view = gp.view();
    pending.push(e);
    return r;
  };

  /* ---------- a full look at the page (uses layout: not for the pump) ---------- */
  function shown(id) {
    var e = typeof id === 'string' ? $(id) : id;
    if (!e) return false;
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  }
  E.shown = shown;
  // what the telemetry graphic was handed in the last frame it drew (a copy)
  E.telBrief = function () {
    var t = E.tel;
    if (!t) return null;
    var ty = t.tyres;
    return { n: E.telN, speedKmh: t.speedKmh, gear: t.gear, rpm: t.rpm, rpmShift: t.rpmShift, rpmMax: t.rpmMax, throttle: t.throttle, brake: t.brake,
      battery: t.battery, deploy: t.deploy, harvest: t.harvest, limiter: t.limiter, inPit: t.inPit, limitKmh: t.limitKmh, nextCompound: t.nextCompound,
      team: t.team, car: t.car, colour: t.colour, colour2: t.colour2,
      tyres: ty ? { compound: ty.compound, wear: ty.wear.slice(), flat: ty.flat.slice(), puncture: ty.puncture } : null };
  };
  E.snap = function () {
    var g = F1.game, st = g.car ? g.car.state : null, n = g.track ? g.track.samples.length : 0, s = gp.snapshot;
    var resRows = [].map.call(document.querySelectorAll('#gp-results-body tbody tr'), function (r) {
      return { cls: r.className.trim(), cells: [].map.call(r.cells, function (c) { return txt(c); }), fl: !!r.querySelector('td.c-best.fl'),
        you: !!r.querySelector('.mp-tag'), name: txt(r.querySelector('.mp-pname')) };
    });
    return {
      f: E.gameFrames, clock: E.clock, gpNow: gp.now(), running: g.running, queued: queue.length, fatal: E.fatal,
      // (v6.2: the HUD timing box and the results name the track by its Chinese name, js/track-names-zh.js)
      trackId: g.trackData ? g.trackData.id : null, trackLen: g.track ? g.track.length : 0,
      trackName: g.trackData ? ((window.F1_TRACK_NAMES_ZH || {})[g.trackData.id] || g.trackData).name : null,
      car: st ? { x: st.x, z: st.z, h: st.heading, v: st.speed, i: st.sampleIndex, d: st.d, steer: st.steer, grass: st.onGrass, hit: st.hit, n: n } : null,
      gp: { phase: gp.phase, sid: gp.sid, online: gp.online, taking: gp.taking, canControl: gp.canControl, locked: gp.inputLocked, lights: gp.lights,
        goFlash: gp.goFlash, sinceGo: gp.sinceGo, gridSlot: gp.gridSlot, lap: gp.lap, lapTotal: gp.lapTotal },
      snapshot: s ? JSON.parse(JSON.stringify(s)) : null, me: meBrief(), view: gp.view(), lap: lapBrief(),
      truth: { idx: T.idx, U: T.U, N: T.N, lines: T.lines, steps: T.steps, frac: E.frac() },
      pad: F1.gamepad ? { connected: F1.gamepad.state.connected, thr: F1.gamepad.state.throttle, brk: F1.gamepad.state.brake, steer: F1.gamepad.state.steer, boost: F1.gamepad.state.boost } : null,
      ap: { mode: ap.mode, on: ap.on, thr: ap.thr, brk: ap.brk, want: ap.want, padErr: ap.padErr, boost: ap.boost },
      tel: E.telBrief(),
      tyres: g.car && g.car.tyres ? { compound: g.car.tyres.state.compound, wear: g.car.tyres.state.wear.slice(), flat: g.car.tyres.state.flat.slice(), puncture: g.car.tyres.state.puncture,
        grip: { lat: g.car.tyres.state.grip.lat, brake: g.car.tyres.state.grip.brake, traction: g.car.tyres.state.grip.traction }, rate: g.car.tyres.wearRate } : null,
      pitState: g.pit ? { inLane: g.pit.state.inLane, speeding: g.pit.state.speeding, inBox: g.pit.state.inBox, visit: g.pit.state.visit, stops: g.pit.state.stops, pending: g.pit.state.pending,
        service: g.pit.state.service ? { total: g.pit.state.service.total, left: g.pit.state.service.left, penalty: g.pit.state.service.penalty, work: g.pit.state.service.work } : null } : null,
      spec: g.spec ? { id: g.spec.id, year: g.spec.year, team: g.spec.team, teamZh: g.spec.teamZh, car: g.spec.car, colour: g.spec.colour, cockpit: g.spec.cockpit, ers: g.spec.ers } : null,
      limiter: g.limiter, nextCompound: g.nextCompound, battery: st ? st.battery : null,
      hud: hudBrief(),
      dom: {
        hud: shown('hud'), menu: shown('menu'), hudGp: shown('hud-gp'), lights: shown('hud-lights'), results: shown('gp-results'), players: shown('hud-players'),
        toast: shown('hud-toast'), gpLapRow: shown('hud-gp-laprow'), gpNote: shown('hud-gp-note') ? txt($('hud-gp-note')) : '', gpEnds: shown('hud-gp-ends'),
        hintPad: shown('hud-hint-pad'), hintKeys: shown('hud-hint-keys'), track: txt($('hud-track')), speed: txt($('hud-speed')), gear: txt($('hud-gear')),
        error: shown('error') ? txt(el.errText) : '',
        res: { sub: txt($('gp-results-sub')), rows: resRows, again: shown('gp-res-again'), end: shown('gp-res-end'), close: shown('gp-close'), note: txt($('gp-results-note')) },
        menuGp: { setup: shown('gp-setup'), startDisabled: $('gp-start').disabled, q: $('gp-q').value, r: $('gp-r').value, hint: shown('gp-hint') ? txt($('gp-hint')) : '',
          session: shown('gp-session'), state: txt($('gp-state')), self: shown('gp-self') ? txt($('gp-self')) : '', skip: shown('gp-skip'), again: shown('gp-again'),
          end: shown('gp-end'), rows: rows($('gp-standings')), resume: shown('menu-resume'), padStatus: shown('pad-status') }
      }
    };
  };
  // the car against grid box slot + 1, from the rule (front bar (slot + 1) * 8 m behind the line, 0.25 m thick), not
  // from track.grid: nose = metres from the front of the bar back to the tip of the car's nose, turn = heading - the
  // road's direction there, lat = lateral offset of the nose from the centreline (+ = driver's left)
  E.box = function (slot) {
    var tr = F1.game.track, S = tr.samples, n = S.length, k = slot + 1, c = F1.game.car.state;
    var s = S[((n - Math.round(k * 8 / (tr.length / n))) % n + n) % n];
    var nx = c.x + Math.sin(c.heading) * 2.8, nz = c.z + Math.cos(c.heading) * 2.8, turn = c.heading - Math.atan2(s.tx, s.tz);
    var G = tr.grid && tr.grid[slot];
    return { nose: -((nx - s.x) * s.tx + (nz - s.z) * s.tz), lat: (nx - s.x) * s.nx + (nz - s.z) * s.nz, turn: Math.atan2(Math.sin(turn), Math.cos(turn)),
      back: (n - c.sampleIndex) % n, d: c.d, v: c.speed, halfW: s.halfW || tr.halfWidth, gridD: G ? G.d : null };
  };
  return 'ok';
})();
