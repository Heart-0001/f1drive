// Lives in the PAGE (injected by devtests/v6-critic/critic.js). A REAL-TIME driver for room windows, where the time warp
// of gp-e2e/solo-page.js cannot be used: a fake standard controller (navigator.getGamepads) and a requestAnimationFrame
// loop that steers / drives it every frame, like a player's pad. window.__d.
//   __d.lapPlan({slot, laneKmh, vmax}) : from where the car is, around the track on the centreline (a curvature speed
//       profile) into the pit lane of track.pit, stop in box `slot`, wait for the service, out again (~150 m).
//       The approach may be almost a whole lap. The pit limiter is not touched (the harness presses Q / LB itself).
//   __d.info() : phase, where, what was seen (service, lap clock, movement while held)
//   __d.stop() : hands off, pedals released
// Control law: the pure pursuit / speed profile of devtests/v6-smoke/page.js (car-v6/pit-drive.js).
(function () {
  'use strict';
  if (window.__d) return 'already';
  var F1 = window.F1;
  var D = window.__d = { plan: null, on: false, dt: 0, last: 0, frames: 0 };
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  var b = [];
  for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
  D.pad = { index: 0, id: 'Critic Driver (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: b, vibrationActuator: { type: 'dual-rumble', playEffect: function () { return Promise.resolve('complete'); } } };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return [D.pad, null, null, null]; } });
  D.btn = function (k, v) { var x = D.pad.buttons[k]; x.value = v; x.pressed = v > 0.5; return true; };
  function setPad(thr, brk, steer) {
    var t = thr > 0 ? (thr >= 1 ? 1 : 0.04 + 0.96 * thr) : 0, k = brk > 0 ? (brk >= 1 ? 1 : 0.04 + 0.96 * brk) : 0;
    b[7].value = t; b[7].pressed = t > 0.5; b[6].value = k; b[6].pressed = k > 0.5;
    D.pad.axes[0] = steer === 0 ? 0 : -(steer > 0 ? 1 : -1) * (0.12 + 0.88 * Math.pow(Math.min(1, Math.abs(steer)), 1 / 1.6));
    D.pad.axes[1] = 0;
  }
  D.setPad = setPad;
  function loop(t) {
    requestAnimationFrame(loop);
    D.dt = D.last ? Math.min(0.25, (t - D.last) / 1000) : 0; D.last = t; D.frames++;
    try { if (D.plan && D.plan.active) step(); } catch (e) { D.err = String(e && e.stack || e); D.plan.active = false; setPad(0, 0, 0); }
  }
  requestAnimationFrame(loop);

  var A_LAT = 8, A_BRAKE = 6, A_STOP = 2.5;
  function wrapN(d, N) { return d > N / 2 ? d - N : (d < -N / 2 ? d + N : d); }

  D.lapPlan = function (o) {
    o = o || {};
    var g = F1.game, track = g.track, st = g.car.state, S = track.samples, N = S.length, ds = track.length / N, pit = track.pit;
    if (!pit) return { error: 'no pit' };
    var wq = function (q) { return ((q % N) + N) % N; }, kOf = function (i) { return wq(i - pit.from); };
    var K = kOf(pit.to), kEn = kOf(pit.entry), kEx = kOf(pit.exit), vLim = pit.limitKmh / 3.6;
    var start = st.sampleIndex, run = wq(pit.from - start);
    if (run < 40) run += N;                     // just past the start of the pit stretch: a whole lap first
    var out = Math.round(150 / ds), back = Math.round(100 / ds), blend = Math.round(80 / ds), lead = Math.round(220 / ds);
    var L = run + K + out + 40, tgt = new Float64Array(L + 1), vmax = new Float64Array(L + 1), iOf = function (u) { return wq(start + u); };
    var slot = o.slot || 0, bx = pit.boxes[slot % pit.boxes.length], ub = run + kOf(bx.index), d0 = st.d, dFrom = pit.laneD(pit.from);
    for (var u = 0; u <= L; u++) {
      vmax[u] = o.vmax || 70;
      if (u < run) {
        var f0 = clamp(u / blend, 0, 1); f0 = f0 * f0 * (3 - 2 * f0);
        var f1 = clamp((u - (run - lead)) / (lead - 5), 0, 1); f1 = f1 * f1 * (3 - 2 * f1);
        tgt[u] = d0 * (1 - f0) + dFrom * f1;
      } else if (u <= run + K) tgt[u] = pit.laneD(iOf(u));
      else { var f2 = clamp((u - run - K) / back, 0, 1); tgt[u] = pit.laneD(pit.to) * (1 - f2 * f2 * (3 - 2 * f2)); }
    }
    var a0 = ub - Math.round(28 / ds), a1 = ub - Math.round(6 / ds), b0 = ub + Math.round(4 / ds), b1 = ub + Math.round(28 / ds);
    for (u = a0; u <= b1; u++) {
      var fb = u < a1 ? (u - a0) / (a1 - a0) : (u <= b0 ? 1 : 1 - (u - b0) / (b1 - b0));
      fb = clamp(fb, 0, 1); fb = fb * fb * (3 - 2 * fb);
      tgt[u] = tgt[u] + (bx.d - tgt[u]) * fb;
    }
    var P = [];
    for (u = 0; u <= L; u++) { var s = S[iOf(u)]; P.push([s.x + s.nx * tgt[u], s.z + s.nz * tgt[u]]); }
    for (u = 2; u <= L - 2; u++) {
      var pa = P[u - 2], pb = P[u], pc = P[u + 2];
      var ax = pb[0] - pa[0], az = pb[1] - pa[1], cx = pc[0] - pa[0], cz = pc[1] - pa[1];
      var kap = 2 * Math.abs(ax * cz - az * cx) / (Math.hypot(ax, az) * Math.hypot(cx, cz) * Math.hypot(pc[0] - pb[0], pc[1] - pb[1]) + 1e-9);
      vmax[u] = Math.min(vmax[u], Math.sqrt(A_LAT / Math.max(kap, 1e-6)));
    }
    var uEn = run + kEn, uEx = run + kEx, vLane = o.laneKmh > 0 ? o.laneKmh / 3.6 : vLim - 2 / 3.6;
    for (u = uEn - Math.round(40 / ds); u <= uEx; u++) vmax[u] = Math.min(vmax[u], vLane);
    vmax[ub] = Math.min(vmax[ub], 2);
    for (u = L - 1; u >= 0; u--) {
      var acc = u < ub && ub - u < 40 / ds ? A_STOP : A_BRAKE;
      vmax[u] = Math.min(vmax[u], Math.sqrt(vmax[u + 1] * vmax[u + 1] + 2 * acc * ds));
    }
    D.plan = { active: true, phase: 'approach', U: 0, idx: start, start: start, L: L, run: run, ub: ub, uEn: uEn, uEx: uEx, slot: slot, box: bx,
      tgt: tgt, vmax: vmax, integ: 0, stopped: null, served: false, stops0: g.pit.state.stops,
      rec: { maxLaneKmh: 0, hits: 0, grass: 0, maxServiceMove: 0, serviceFrames: 0, frozenBad: 0, svcStart: null, svcDone: null, svcTotal: null,
        svcLap0: null, svcLap1: null, svcLapN0: null, maxHit: 0 } };
    return { ok: true, run: run, L: L, uEn: uEn, ub: ub, slot: slot };
  };

  function step() {
    var pl = D.plan, g = F1.game, track = g.track, car = g.car, st = car.state, S = track.samples, N = S.length, ds = track.length / N;
    var P = g.pit.state, bx = pl.box, rec = pl.rec, now = performance.now();
    var i = track.locate(st.x, st.z, pl.idx).index;
    pl.U += wrapN(i - pl.idx, N); pl.idx = i;
    var u = clamp(Math.round(pl.U), 0, pl.L - 1), v = Math.max(0, st.speed);
    if (st.hit > 0) { rec.hits++; if (st.hit > rec.maxHit) rec.maxHit = st.hit; }
    if (st.onGrass) rec.grass++;
    if (P.inLane) rec.maxLaneKmh = Math.max(rec.maxLaneKmh, Math.abs(st.speed) * 3.6);
    if (P.service) {
      if (rec.svcStart === null) { rec.svcStart = now; rec.svcTotal = P.service.total; rec.svcPenalty = P.service.penalty; rec.svcX = st.x; rec.svcZ = st.z;
        rec.svcLap0 = g.lap.time; rec.svcLapN0 = g.lap.n; }
      rec.serviceFrames++;
      var mv = Math.hypot(st.x - rec.svcX, st.z - rec.svcZ);
      if (mv > rec.maxServiceMove) rec.maxServiceMove = mv;
      if (st.speed !== 0) rec.frozenBad++;
    } else if (rec.svcStart !== null && rec.svcDone === null) { rec.svcDone = now; rec.svcLap1 = g.lap.time; rec.svcLapN1 = g.lap.n; }
    if (pl.U >= pl.L - 40) { pl.active = false; pl.phase = 'done'; setPad(0, 0, 0); return; }
    var vt = pl.vmax[u], fx = Math.sin(bx.heading), fz = Math.cos(bx.heading);
    var dist = pl.stopped ? Infinity : (bx.x - st.x) * fx + (bx.z - st.z) * fz;
    var nearBox = pl.U > pl.ub - 40 / ds;
    if (nearBox && dist < 25) vt = Math.min(vt, Math.sqrt(2 * 1.2 * Math.max(0, dist - 0.05)) + (dist > 0.05 ? 0.25 : 0));
    var braking = nearBox && !pl.stopped && dist < 0.06;
    if (P.service || (pl.stopped && !pl.served)) {
      pl.phase = 'service';
      if (!P.service && P.stops > pl.stops0) pl.served = true;
      if (!P.service && !pl.served && now - pl.stopped.clock > 3000) { pl.served = true; pl.noService = true; }   // stopped beside the box: give up
      setPad(0, P.service ? 0 : 1, 0);            // (held by the game during the service: no brake needed)
      return;
    }
    if (nearBox && !pl.stopped && braking && v < 0.02) { pl.stopped = { clock: now, inPit: st.inPit }; setPad(0, 1, 0); return; }
    pl.phase = pl.stopped ? 'out' : (pl.U < pl.uEn ? 'approach' : 'lane');
    var la = clamp(4 + 0.35 * v, 5, 20), j = clamp(u + Math.round(la / ds), 0, pl.L), s = S[((pl.start + j) % N + N) % N];
    var gx = s.x + s.nx * pl.tgt[j] - st.x, gz = s.z + s.nz * pl.tgt[j] - st.z;
    var sh = Math.sin(st.heading), ch = Math.cos(st.heading);
    var xf = gx * sh + gz * ch, yl = gx * ch - gz * sh;
    var kap = 2 * yl / (xf * xf + yl * yl);
    var PERF = car.perf || F1.CAR_PERF;
    var lock = PERF.steerLock / (1 + (v / PERF.steerSpeedRef) * (v / PERF.steerSpeedRef));
    var steer = clamp(Math.atan(kap * PERF.wheelbase) / lock, -1, 1), thr = 0, brk = 0;
    var err = vt - v;
    pl.integ = clamp(pl.integ + err * D.dt * 0.6, 0, 1);
    if (braking) { brk = 1; pl.integ = 0; }
    else if (err > -0.4) thr = clamp(0.35 * err + pl.integ + (vt > 0.5 ? 0.15 : 0), 0, 1);
    else { brk = clamp(-0.3 * err, 0, 1); pl.integ *= 0.9; }
    if (g.gp.inputLocked) { thr = 0; brk = 0; }
    setPad(thr, brk, steer);
  }
  D.stop = function () { if (D.plan) D.plan.active = false; setPad(0, 0, 0); return true; };
  D.info = function () {
    var p = D.plan; if (!p) return null;
    return { active: p.active, phase: p.phase, U: Math.round(p.U), L: p.L, ub: p.ub, stopped: !!p.stopped, served: p.served, noService: !!p.noService, rec: p.rec, err: D.err || null };
  };
  return 'ok';
})();
