// Lives in the PAGE (injected by devtests/v6-smoke/smoke.js with executeJavaScript, after the game has booted):
// window.__v = observers of the v6 glue in js/main.js + a pit-lane driver.
//   observers  the last object main.js gave F1.ui.updateHUD (a copy of its telemetry fields), the last F1.ui.setPit
//              argument, every toast, every F1.audio.play / beep call, pit events seen by main.js (through the pit's
//              state), and while a service runs: whether the car moved.
//   pit driver (needs the time warp of devtests/gp-e2e/solo-page.js, window.__e, and its fake controller): a pure-pursuit
//              follower of a target path from where the car is, through the pit lane of track.pit into our own box
//              (boxes[slot]), stop there, wait for the service, and out again (the control law of
//              devtests/car-v6/pit-drive.js), driving the car through the controller (triggers + stick -> js/gamepad.js
//              -> car.update). The pit limiter is NOT touched here: the harness presses Q (a real key) itself.
(function () {
  'use strict';
  if (window.__v) return 'already';
  var F1 = window.F1;
  var V = window.__v = { hud: {}, hudN: 0, pit: null, pitN: 0, toasts: [], sounds: [], plan: null };
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---- observers (wrappers that call straight through) ----
  var uh = F1.ui.updateHUD;
  F1.ui.updateHUD = function (h) {
    var o = V.hud;
    for (var k in h) if (k !== 'others') o[k] = h[k];
    o.tyres = h.tyres ? { compound: h.tyres.compound, wear: h.tyres.wear.slice(), flat: h.tyres.flat.slice(), puncture: h.tyres.puncture,
      grip: h.tyres.grip ? { lat: h.tyres.grip.lat, brake: h.tyres.grip.brake, traction: h.tyres.grip.traction } : null } : null;
    o.othersN = h.others ? h.others.length : 0;
    V.hudN++;
    return uh.apply(this, arguments);
  };
  var sp = F1.ui.setPit;
  if (sp) F1.ui.setPit = function (p) {
    V.pit = p ? { inLane: p.inLane, limiter: p.limiter, speeding: p.speeding, limitKmh: p.limitKmh, boxAhead: p.boxAhead, slot: p.slot, pending: p.pending,
      service: p.service ? { total: p.service.total, left: p.service.left, penalty: p.service.penalty } : null } : null;
    V.pitN++;
    return sp.apply(this, arguments);
  };
  var to = F1.ui.toast;
  F1.ui.toast = function (text) {
    if (text) V.toasts.push({ text: String(text), clock: window.__e ? window.__e.clock : performance.now() });
    return to.apply(this, arguments);
  };
  if (F1.audio) {
    var pl = F1.audio.play, bp = F1.audio.beep;
    F1.audio.play = function (kind) { V.sounds.push({ kind: 'play:' + kind, clock: window.__e ? window.__e.clock : performance.now() }); return pl.apply(this, arguments); };
    F1.audio.beep = function (kind) { V.sounds.push({ kind: 'beep:' + kind, clock: window.__e ? window.__e.clock : performance.now() }); return bp.apply(this, arguments); };
  }
  // Rendering skipped inside pumped frames (the time warp of gp-e2e/solo-page.js): like its E.hookRenderer, but only the
  // MAIN render (F1.game.camera) is skipped: renders the scene starts from inside it (the cockpit's live mirrors render
  // from the glass's onBeforeRender) go through; skipping those corrupts three.js's render state (the outer render then
  // fails with "Cannot read properties of null (reading 'state')").
  V.hookRenderer = function () {
    var E = window.__e;
    if (!E) return false;
    if (E.renderer || V.hooked) return true;
    var o = F1.game.camera;
    while (o && !o.isScene) o = o.parent;
    if (!o) return false;
    V.hooked = true;
    E.scene = o;
    var inRun = false, run = E.run;
    E.run = function () { inRun = true; try { return run.apply(E, arguments); } finally { inRun = false; } };
    o.onBeforeRender = function (r) {
      delete o.onBeforeRender;
      if (E.renderer) return;
      E.renderer = r; E.renders++;
      var real = r.render;
      E.realRender = function () { E.renders++; real.call(r, E.scene, F1.game.camera); };
      r.render = function (s, c) {
        if (inRun && c === F1.game.camera) { E.skipped++; return; }
        E.renders++;
        return real.call(r, s, c);
      };
    };
    return true;
  };
  // time-warped windows: the telemetry graphic smooths / flashes on the game clock (its smoothing would lag behind
  // hundreds of frames a second of wall time otherwise)
  if (window.__e && F1.telemetry) F1.telemetry.clock = function () { return window.__e.clock; };
  V.toastsSince = function (n) { return V.toasts.slice(n).map(function (t) { return t.text; }); };
  V.soundsSince = function (n) { return V.sounds.slice(n).map(function (t) { return t.kind; }); };
  V.car = function () {
    var g = F1.game, s = g.car.state;
    return { x: s.x, y: s.y, z: s.z, h: s.heading, v: s.speed, i: s.sampleIndex, d: s.d, gear: s.gear, rpm: s.rpm, thr: s.throttle, brk: s.brake,
      battery: s.battery, deploy: s.deploy, harvest: s.harvest, limiter: s.limiter, inPit: s.inPit, limitKmh: s.limitKmh, hit: s.hit, grass: s.onGrass,
      spec: g.spec.id, n: g.track ? g.track.samples.length : 0 };
  };
  V.tyres = function () {
    var t = F1.game.tyres; if (!t) return null;
    var s = t.state;
    return { compound: s.compound, wear: s.wear.slice(), flat: s.flat.slice(), temp: s.temp.slice(), dirt: s.dirt, puncture: s.puncture,
      grip: { lat: s.grip.lat, brake: s.grip.brake, traction: s.grip.traction }, rate: t.wearRate };
  };
  V.pitState = function () {
    var p = F1.game.pit; if (!p) return null;
    var s = p.state;
    return { inLane: s.inLane, speeding: s.speeding, inBox: s.inBox, service: s.service ? { total: s.service.total, left: s.service.left, penalty: s.service.penalty, work: s.service.work } : null,
      stops: s.stops, pending: s.pending, boxAhead: s.boxAhead, visit: s.visit, slot: s.slot, limitKmh: s.limitKmh };
  };

  // ---- the pit-lane driver ----
  var STEP = 1 / 120;
  var A_LAT = 9, A_BRAKE = 7, A_STOP = 2.5;
  function wrapN(d, N) { return d > N / 2 ? d - N : (d < -N / 2 ? d + N : d); }
  function setPad(thr, brk, steer) {
    var E = window.__e, b = E.pad.buttons;
    var t = thr > 0 ? (thr >= 1 ? 1 : 0.04 + 0.96 * thr) : 0, k = brk > 0 ? (brk >= 1 ? 1 : 0.04 + 0.96 * brk) : 0;
    b[7].value = t; b[7].pressed = t > 0.5; b[6].value = k; b[6].pressed = k > 0.5;
    E.pad.axes[0] = steer === 0 ? 0 : -(steer > 0 ? 1 : -1) * (0.12 + 0.88 * Math.pow(Math.min(1, Math.abs(steer)), 1 / 1.6));
    E.pad.axes[1] = 0;
  }

  // o = { slot (box, default 0), vLane: m/s cap between the entry and exit lines (default: 2 km/h under the limit),
  //       cruise: true = the limiter holds the speed (throttle wide open in the lane), out: m to drive on after pit.to }
  // The path starts where the car is now: its own offset blended to the lane over the stretch up to pit.from.
  V.pitPlan = function (o) {
    o = o || {};
    var E = window.__e, g = F1.game, track = g.track, car = g.car, st = car.state, S = track.samples, N = S.length, ds = track.length / N, pit = track.pit;
    var wq = function (q) { return ((q % N) + N) % N; }, kOf = function (i) { return wq(i - pit.from); };
    var K = kOf(pit.to), kEn = kOf(pit.entry), kEx = kOf(pit.exit), vLim = pit.limitKmh / 3.6;
    var start = st.sampleIndex, run = wq(pit.from - start);
    if (run > N / 2 || run < 20) return { error: 'the car is not before the pit lane (run ' + run + ' samples)' };
    var out = Math.round((o.out || 150) / ds), back = Math.round(100 / ds);
    var L = run + K + out + 40, tgt = new Float64Array(L + 1), vmax = new Float64Array(L + 1), iOf = function (u) { return wq(start + u); };
    for (var u = 0; u <= L; u++) vmax[u] = 90;
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
    var P = [];
    for (u = 0; u <= L; u++) { var s = S[iOf(u)]; P.push([s.x + s.nx * tgt[u], s.z + s.nz * tgt[u]]); }
    for (u = 2; u <= L - 2; u++) {
      var pa = P[u - 2], pb = P[u], pc = P[u + 2];
      var ax = pb[0] - pa[0], az = pb[1] - pa[1], bx = pc[0] - pa[0], bz = pc[1] - pa[1];
      var kap = 2 * Math.abs(ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(pc[0] - pb[0], pc[1] - pb[1]) + 1e-9);
      vmax[u] = Math.min(vmax[u], Math.sqrt(A_LAT / Math.max(kap, 1e-6)));
    }
    var uEn = run + kEn, uEx = run + kEx, vLane = o.vLane > 0 ? o.vLane : vLim - 2 / 3.6;
    for (u = uEn - Math.round(40 / ds); u <= uEx; u++) vmax[u] = Math.min(vmax[u], vLane);
    vmax[ub] = Math.min(vmax[ub], 2);
    for (u = L - 1; u >= 0; u--) {
      var acc = u < ub && ub - u < 40 / ds ? A_STOP : A_BRAKE;
      vmax[u] = Math.min(vmax[u], Math.sqrt(vmax[u + 1] * vmax[u + 1] + 2 * acc * ds));
    }
    V.plan = {
      active: true, phase: 'approach', U: 0, sounds0: V.sounds.length, idx: start, start: start, L: L, run: run, ub: ub, uEn: uEn, uEx: uEx, slot: slot, box: b,
      cruise: !!o.cruise, vLane: vLane, tgt: tgt, vmax: vmax, integ: 0, stopped: null, served: false, stops0: g.pit.state.stops,
      rec: { maxLaneKmh: 0, cruiseKmh: 0, hits: 0, grass: 0, maxServiceMove: 0, serviceFrames: 0, frozenBad: 0, svcStartClock: null, svcDoneClock: null,
        svcTotal: null, svcPenalty: null, svcWork: null, lapNs: [], lapChanges: [], enterClock: null, exitClock: null }
    };
    if (!V.lineStep) {
      V.lineStep = E.ap.step;
      E.ap.step = function () { if (V.plan && V.plan.active) planStep(); else if (V.following) followStep(); else V.lineStep(); };
    }
    V.following = false;
    E.ap.on = true;
    return { ok: true, run: run, L: L, uEn: uEn, uEx: uEx, ub: ub, K: K };
  };

  function planStep() {
    var E = window.__e, pl = V.plan, g = F1.game, track = g.track, car = g.car, st = car.state, S = track.samples, N = S.length, ds = track.length / N;
    var pit = track.pit, P = g.pit.state, b = pl.box, vLim = pit.limitKmh / 3.6, rec = pl.rec;
    // continuous position along the plan
    var i = track.locate(st.x, st.z, pl.idx).index;
    pl.U += wrapN(i - pl.idx, N); pl.idx = i;
    var u = clamp(pl.U, 0, pl.L - 1), v = Math.max(0, st.speed);
    // what happened in the last frame
    if (st.hit > 0) rec.hits++;
    var kk = ((st.sampleIndex - pit.from) % N + N) % N;
    if (kk <= ((pit.to - pit.from) % N + N) % N && st.onGrass) rec.grass++;
    if (P.inLane) { rec.maxLaneKmh = Math.max(rec.maxLaneKmh, Math.abs(st.speed) * 3.6); if (rec.enterClock === null) rec.enterClock = E.clock; }
    else if (rec.enterClock !== null && rec.exitClock === null && pl.U > pl.uEx) rec.exitClock = E.clock;
    if (P.inLane && pl.U > pl.uEn + 10 && pl.U < pl.ub - 60 / ds) rec.cruiseKmh = Math.max(rec.cruiseKmh, st.speed * 3.6);
    if (rec.lapNs[rec.lapNs.length - 1] !== g.lap.n) {
      if (rec.lapNs.length) rec.lapChanges.push({ n: g.lap.n, inLane: P.inLane, carInPit: st.inPit, d: st.d, last: g.lap.last, U: pl.U, clock: E.clock });
      rec.lapNs.push(g.lap.n);
    }
    if (P.service && !pl.stopped) {
      var lx0 = Math.cos(b.heading), lz0 = -Math.sin(b.heading), dd = (b.x - st.x) * Math.sin(b.heading) + (b.z - st.z) * Math.cos(b.heading);
      pl.stopped = { along: -dd, across: (st.x - b.x) * lx0 + (st.z - b.z) * lz0, hd: Math.atan2(Math.sin(st.heading - b.heading), Math.cos(st.heading - b.heading)), inPit: st.inPit, clock: E.clock };
    }
    if (P.service) {
      if (rec.svcStartClock === null) { rec.svcStartClock = E.clock; rec.svcTotal = P.service.total; rec.svcPenalty = P.service.penalty; rec.svcWork = P.service.work; rec.svcX = st.x; rec.svcZ = st.z;
        rec.svcLap0 = g.lap.time; rec.svcSounds0 = V.sounds.length; }
      rec.serviceFrames++;
      var mv = Math.hypot(st.x - rec.svcX, st.z - rec.svcZ);
      if (mv > rec.maxServiceMove) rec.maxServiceMove = mv;
      if (st.speed !== 0) rec.frozenBad++;
    } else if (rec.svcStartClock !== null && rec.svcDoneClock === null) { rec.svcDoneClock = E.clock; rec.svcLap1 = g.lap.time; rec.svcLapN = g.lap.n; }
    if (pl.U >= pl.L - 40) { pl.active = false; pl.phase = 'done'; setPad(0, 0, 0); return; }

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
    var cruising = pl.cruise && F1.game.limiter && pl.U >= pl.uEn && vt >= vLim - 2.5 / 3.6 && dist > 30;
    var err = (cruising ? vLim + 5 : vt) - v;
    pl.integ = clamp(pl.integ + err * E.dt * 0.6, 0, 1);
    if (braking) { brk = 1; pl.integ = 0; }
    else if (cruising) thr = 1;
    else if (err > -0.4) thr = clamp(0.35 * err + pl.integ + (vt > 0.5 ? 0.15 : 0), 0, 1);
    else { brk = clamp(-0.3 * err, 0, 1); pl.integ *= 0.9; }
    setPad(thr, brk, steer);
  }
  // A centreline follower on the controller's stick only (triggers left alone: the keys W / S / E drive), every frame
  // while on. For straight-line tests that must stay on the road.
  V.follow = function (on) {
    var E = window.__e;
    if (!V.lineStep) {
      V.lineStep = E.ap.step;
      E.ap.step = function () { if (V.plan && V.plan.active) planStep(); else if (V.following) followStep(); else V.lineStep(); };
    }
    V.following = !!on;
    E.ap.on = true;
    if (!on) setPad(0, 0, 0);
    return true;
  };
  function followStep() {
    var g = F1.game, st = g.car.state, track = g.track, S = track.samples, N = S.length, ds = track.length / N, v = Math.max(0, st.speed);
    var la = clamp(8 + 0.5 * v, 10, 40), s = S[(st.sampleIndex + Math.round(la / ds)) % N];
    var gx = s.x - st.x, gz = s.z - st.z, sh = Math.sin(st.heading), ch = Math.cos(st.heading);
    var xf = gx * sh + gz * ch, yl = gx * ch - gz * sh, kap = 2 * yl / (xf * xf + yl * yl);
    var PERF = g.car.perf || F1.CAR_PERF, lock = PERF.steerLock / (1 + (v / PERF.steerSpeedRef) * (v / PERF.steerSpeedRef));
    var steer = clamp(Math.atan(kap * PERF.wheelbase) / lock, -1, 1);
    var E = window.__e;
    E.pad.buttons[7].value = 0; E.pad.buttons[7].pressed = false; E.pad.buttons[6].value = 0; E.pad.buttons[6].pressed = false;
    E.pad.axes[0] = Math.abs(steer) < 1e-4 ? 0 : -(steer > 0 ? 1 : -1) * (0.12 + 0.88 * Math.pow(Math.min(1, Math.abs(steer)), 1 / 1.6));
  }
  V.planInfo = function () {
    var p = V.plan; if (!p) return null;
    return { active: p.active, phase: p.phase, U: p.U, L: p.L, uEn: p.uEn, uEx: p.uEx, ub: p.ub, stopped: p.stopped, served: p.served, rec: p.rec };
  };
  return 'ok';
})();
