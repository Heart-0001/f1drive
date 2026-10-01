// Pit-stop driver for the end-to-end harnesses (devtests/gp-e2e/online-v6.js): from the racing line into the pit lane
// of track.pit, stop in the box of a room slot, stay put while the game holds the car for the service, out through
// the lane and back onto the racing line, then hand back to the race autopilot (autopilot.js). Controller values only
// (steer / throttle / brake + whether the pit limiter should be on); the harness page presses the pad's buttons.
// Pure logic: no DOM, no THREE. Loaded two ways from this one file:
//   node   require('./pitplan')              -> createPitPlan   (a dry run against the real js/car.js + js/pit.js)
//   page   the source is injected as text    -> window.createPitPlan
//
//   var plan = createPitPlan(track, line, st, { slot, scale, vmax, limiterM, backM })
//     track = F1.buildTrack(...) (track.pit), line = F1.buildRaceLine(...) (points[i].d / speed), st = car.state now
//     slot: the box (track.pit.boxes[slot]); scale: pace on the approach and the rejoin (x the line's speeds);
//     vmax: m/s cap; limiterM: m before the entry line from where the limiter should be on; backM: m after pit.to
//     over which the path returns to the racing line
//     -> plan, or { error } (no pit lane, or the car is too close to it: less than 60 m before pit.from)
//   plan.step(st, perf, dt, pitState, locked, others) -> { steer, throttle, brake, limiter, phase, done }
//     perf = car.perf (steerLock, steerSpeedRef, wheelbase); pitState = F1.game.pit.state; locked = gp.inputLocked;
//     others (optional) = [{x, z, speed}]: before the entry line and after the exit line the plan keeps a gap to a car
//     ahead in its way (time gap 0.5 s + 4 m behind its tail, as autopilot.js): cars leaving their boxes one right
//     after the other would otherwise run into each other once they are solid again on the track
//   plan.info() -> what happened: { phase, U, L, stopped, served, rec: { maxLaneKmh, hits, grass, ... } }
// The path over u = samples from where the plan starts: the racing line's offset, blended over the last `lead`
// metres into pit.laneD(pit.from); pit.laneD through the lane, into the box (late in, out over 24 m, as the pit-lane
// drive test devtests/car-v6/pit-drive.js does); after pit.to back to the racing line over backM. Target speed:
// the path's curvature (A_LAT), the racing line's speed x scale, the lane limit - 2 km/h from 40 m before the entry
// line to the exit line, 2 m/s at the box, braking A_BRAKE (A_STOP into the box). Control law: the pure pursuit and
// speed loop of devtests/v6-critic/driver.js.
(function (root) {
  'use strict';
  var A_LAT = 8, A_BRAKE = 6, A_STOP = 2.5, CAR_LEN = 5.4;
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function smooth(f) { f = clamp(f, 0, 1); return f * f * (3 - 2 * f); }

  function createPitPlan(track, line, st, o) {
    o = o || {};
    var pit = track.pit;
    if (!pit) return { error: 'no pit lane' };
    var S = track.samples, N = S.length, ds = track.length / N, LP = line.points;
    var wq = function (q) { return ((q % N) + N) % N; }, kOf = function (i) { return wq(i - pit.from); };
    var K = kOf(pit.to), kEn = kOf(pit.entry), kEx = kOf(pit.exit), vLim = pit.limitKmh / 3.6;
    var start = wq(st.sampleIndex), run = wq(pit.from - start);
    if (run * ds < 60) return { error: 'too close to the pit lane (' + (run * ds).toFixed(0) + ' m)' };
    var scale = o.scale > 0 ? o.scale : 1, vcap = o.vmax > 0 ? o.vmax : 90;
    var lead = Math.min(run - 5, Math.round(220 / ds)), back = Math.round((o.backM || 120) / ds), first = Math.round(20 / ds);
    var out = back + Math.round(40 / ds);
    var L = run + K + out + 40, tgt = new Float64Array(L + 1), vmax = new Float64Array(L + 1);
    var iOf = function (u) { return wq(start + u); };
    var slot = o.slot || 0, bx = pit.boxes[slot % pit.boxes.length], ub = run + kOf(bx.index), d0 = st.d, dFrom = pit.laneD(pit.from), dTo = pit.laneD(pit.to);
    for (var u = 0; u <= L; u++) {
      var i = iOf(u), ld = LP[i].d;
      if (u < run) {
        var a = ld + (d0 - LP[start].d) * (1 - smooth(u / first));       // from where the car is onto the line
        tgt[u] = a + (dFrom - a) * smooth((u - (run - lead)) / lead);
      } else if (u <= run + K) tgt[u] = pit.laneD(i);
      else tgt[u] = dTo + (ld - dTo) * smooth((u - run - K) / back);
      vmax[u] = Math.min(vcap, u < run - lead || u > run + K ? scale * LP[i].speed : vcap);
    }
    var a0 = ub - Math.round(28 / ds), a1 = ub - Math.round(6 / ds), b0 = ub + Math.round(4 / ds), b1 = ub + Math.round(28 / ds);
    for (u = a0; u <= b1; u++) {
      var fb = u < a1 ? (u - a0) / (a1 - a0) : (u <= b0 ? 1 : 1 - (u - b0) / (b1 - b0));
      tgt[u] = tgt[u] + (bx.d - tgt[u]) * smooth(fb);
    }
    var P = [];
    for (u = 0; u <= L; u++) { var s = S[iOf(u)]; P.push([s.x + s.nx * tgt[u], s.z + s.nz * tgt[u]]); }
    for (u = 2; u <= L - 2; u++) {
      var pa = P[u - 2], pb = P[u], pc = P[u + 2];
      var ax = pb[0] - pa[0], az = pb[1] - pa[1], cx = pc[0] - pa[0], cz = pc[1] - pa[1];
      var kap = 2 * Math.abs(ax * cz - az * cx) / (Math.hypot(ax, az) * Math.hypot(cx, cz) * Math.hypot(pc[0] - pb[0], pc[1] - pb[1]) + 1e-9);
      vmax[u] = Math.min(vmax[u], Math.sqrt(A_LAT / Math.max(kap, 1e-6)));
    }
    var uEn = run + kEn, uEx = run + kEx, vLane = vLim - 2 / 3.6;
    for (u = uEn - Math.round(40 / ds); u <= uEx; u++) vmax[u] = Math.min(vmax[u], vLane);
    vmax[ub] = Math.min(vmax[ub], 2);
    for (u = L - 1; u >= 0; u--) {
      var acc = u < ub && ub - u < 40 / ds ? A_STOP : A_BRAKE;
      vmax[u] = Math.min(vmax[u], Math.sqrt(vmax[u + 1] * vmax[u + 1] + 2 * acc * ds));
    }
    var limFrom = uEn - Math.round((o.limiterM || 30) / ds), limTo = uEx + Math.round(12 / ds);

    var pl = { phase: 'approach', U: 0, idx: start, integ: 0, stopped: null, served: false, stops0: null, done: false, t: 0,
      rec: { maxLaneKmh: 0, laneFrames: 0, hits: 0, maxHit: 0, grass: 0, serviceFrames: 0, maxServiceMove: 0, frozenBad: 0,
        svcTotal: null, svcPenalty: null, svcStartT: null, svcDoneT: null, enterT: null, exitT: null, stoppedAt: null, limiterFrames: 0, followFrames: 0 } };
    var outp = { steer: 0, throttle: 0, brake: 0, limiter: false, phase: 'approach', done: false };
    var svcX = 0, svcZ = 0;

    // m/s at most behind the closest car ahead in our way (Infinity: none): ahead along our heading, within a car
    // width and a bit to the side
    function follow(st, v, others) {
      var lim = Infinity, sh = Math.sin(st.heading), ch = Math.cos(st.heading);
      for (var k = 0; others && k < others.length; k++) {
        var o = others[k], dx = o.x - st.x, dz = o.z - st.z, ahead = dx * sh + dz * ch, lat = dx * ch - dz * sh;
        if (!(ahead > 0 && ahead < Math.max(60, v * 3.5)) || Math.abs(lat) > 2.8) continue;
        var want = CAR_LEN + 4 + 0.5 * v, l = Math.max(0, Math.max(0, o.speed || 0) + 0.8 * (ahead - want));
        if (l < lim) lim = l;
      }
      return lim;
    }

    function step(st, perf, dt, P2, locked, others) {
      var rec = pl.rec, v = Math.max(0, st.speed);
      pl.t += dt;
      outp.steer = outp.throttle = outp.brake = 0;
      if (pl.done) { outp.done = true; outp.limiter = false; return outp; }
      if (pl.stops0 === null) pl.stops0 = P2 ? P2.stops : 0;
      var i = track.locate(st.x, st.z, pl.idx).index, di = i - pl.idx;
      if (di > N / 2) di -= N; else if (di < -N / 2) di += N;
      pl.U += di; pl.idx = i;
      var uu = clamp(Math.round(pl.U), 0, L - 1);
      if (st.hit > 0) { rec.hits++; if (st.hit > rec.maxHit) rec.maxHit = st.hit; }
      if (st.onGrass) rec.grass++;
      if (P2 && P2.inLane) {
        rec.laneFrames++; rec.maxLaneKmh = Math.max(rec.maxLaneKmh, Math.abs(st.speed) * 3.6);
        if (rec.enterT === null) rec.enterT = pl.t;
      } else if (rec.enterT !== null && rec.exitT === null && pl.U > uEx) rec.exitT = pl.t;
      outp.limiter = pl.U >= limFrom && pl.U <= limTo;
      if (outp.limiter) rec.limiterFrames++;
      if (P2 && P2.service) {
        if (rec.svcStartT === null) { rec.svcStartT = pl.t; rec.svcTotal = P2.service.total; rec.svcPenalty = P2.service.penalty; svcX = st.x; svcZ = st.z; }
        rec.serviceFrames++;
        var mv = Math.hypot(st.x - svcX, st.z - svcZ);
        if (mv > rec.maxServiceMove) rec.maxServiceMove = mv;
        if (st.speed !== 0) rec.frozenBad++;
      } else if (rec.svcStartT !== null && rec.svcDoneT === null) rec.svcDoneT = pl.t;
      if (pl.U >= L - 40) { pl.done = true; pl.phase = 'done'; outp.done = true; outp.phase = 'done'; outp.limiter = false; return outp; }
      var vt = vmax[uu], fx = Math.sin(bx.heading), fz = Math.cos(bx.heading);
      var dist = pl.stopped ? Infinity : (bx.x - st.x) * fx + (bx.z - st.z) * fz;
      var nearBox = pl.U > ub - 40 / ds;
      if (nearBox && dist < 25) vt = Math.min(vt, Math.sqrt(2 * 1.2 * Math.max(0, dist - 0.05)) + (dist > 0.05 ? 0.25 : 0));
      var braking = nearBox && !pl.stopped && dist < 0.06;
      if ((P2 && P2.service) || (pl.stopped && !pl.served)) {
        pl.phase = 'service';
        if (P2 && !P2.service && P2.stops > pl.stops0) pl.served = true;
        if (P2 && !P2.service && !pl.served && pl.t - pl.stopped.t > 3) { pl.served = true; pl.noService = true; }   // stopped beside the box: give up
        outp.brake = P2 && P2.service ? 0 : 1;
        outp.phase = pl.phase;
        return outp;
      }
      if (nearBox && !pl.stopped && braking && v < 0.02) {
        var lx = Math.cos(bx.heading), lz = -Math.sin(bx.heading);
        pl.stopped = { t: pl.t, along: -dist, across: (st.x - bx.x) * lx + (st.z - bx.z) * lz, inPit: !!st.inPit };
        rec.stoppedAt = pl.stopped;
        outp.brake = 1; outp.phase = 'service';
        return outp;
      }
      pl.phase = pl.stopped ? 'out' : (pl.U < uEn ? 'approach' : 'lane');
      if (pl.U < uEn || pl.U > uEx) {                 // solid cars: keep a gap (in the lane everybody is a ghost)
        var fl = follow(st, v, others);
        if (fl < vt) { vt = fl; rec.followFrames++; }
      }
      var la = clamp(4 + 0.35 * v, 5, 20), j = clamp(uu + Math.round(la / ds), 0, L), s = S[iOf(j)];
      var gx = s.x + s.nx * tgt[j] - st.x, gz = s.z + s.nz * tgt[j] - st.z;
      var sh = Math.sin(st.heading), ch = Math.cos(st.heading);
      var xf = gx * sh + gz * ch, yl = gx * ch - gz * sh;
      var kap = 2 * yl / (xf * xf + yl * yl);
      var lock = perf.steerLock / (1 + (v / perf.steerSpeedRef) * (v / perf.steerSpeedRef));
      outp.steer = clamp(Math.atan(kap * perf.wheelbase) / lock, -1, 1);
      var err = vt - v;
      pl.integ = clamp(pl.integ + err * dt * 0.6, 0, 1);
      if (braking) { outp.brake = 1; pl.integ = 0; }
      else if (err > -0.4) outp.throttle = clamp(0.35 * err + pl.integ + (vt > 0.5 ? 0.15 : 0), 0, 1);
      else { outp.brake = clamp(-0.3 * err, 0, 1); pl.integ *= 0.9; }
      if (locked) { outp.throttle = 0; outp.brake = 0; }
      outp.phase = pl.phase;
      return outp;
    }

    return {
      step: step,
      get done() { return pl.done; },
      info: function () { return { phase: pl.phase, U: Math.round(pl.U), L: L, run: run, ub: ub, uEn: uEn, uEx: uEx, slot: slot, stopped: pl.stopped, served: pl.served, noService: !!pl.noService, rec: pl.rec }; }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createPitPlan;
  else root.createPitPlan = createPitPlan;
})(typeof window !== 'undefined' ? window : globalThis);
