// Lives in the PAGE (injected by devtests/gp-e2e/solo-v6.js after solo-page.js, before a track is picked):
// window.__v6 = recorders for the v6 checks + a small driving programme. Like solo-page.js it never writes car.state,
// the tyres, the pit or the session: the car is driven through the fake controller (solo-page.js's E.pad) and real keys.
//
//   recorder   every game frame (through E.ap.step, which solo-page.js calls first in every pumped frame while E.ap.on;
//              it sees the state the previous frame left): the battery / deploy / harvest and whether the battery button
//              was held (pad RB = E.ap.boost, or the E key = F1.game.boost), a compact time series, at every crossing of
//              the line the tyres as the telemetry graphic got them (E.tel: the object main.js handed F1.telemetry.draw)
//              + the grip multipliers, and the tyres at the start / end of every pit service.
//              V.resetKers() starts a new battery tally (e.g. at lights out: the race alone).
//   steerOnly  the stick follows the centreline, the triggers stay at rest: the keyboard (W / E held by the harness) drives
//              (the ERS A/B runs from the start position).
//   ab(m)      pumps frames until the car has covered m metres from where it stands; -> speed, battery, deploy there.
(function () {
  'use strict';
  if (window.__v6) return 'already';
  var F1 = window.F1, E = window.__e;
  if (!E) return 'no __e';
  var V = window.__v6 = { steerOnly: false, series: [], every: 6, laps: [], services: [], kers: null, maxBoostKmh: 0, overTopFrames: 0, frames: 0 };
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function tyreCopy(t) { return t ? { compound: t.compound, wear: t.wear.slice(), flat: t.flat.slice(), puncture: t.puncture, grip: { lat: t.grip.lat, brake: t.grip.brake, traction: t.grip.traction } } : null; }

  var lastLines = -1, kers, inService = false;
  V.resetKers = function () {
    kers = V.kers = { frames: 0, deployFrames: 0, harvestFrames: 0, heldFrames: 0, deployT: 0, harvestT: 0, heldT: 0, heldNoDeploy: 0, deployNotHeld: 0, emptyFrames: 0, cycles: 0, recharged: 0,
      minBattery: 1, maxBattery: 0, maxDeploy: 0, maxHarvest: 0, low: false, lowAt: null, peakAfterLow: 0, deployWhileEmpty: 0, deployE: 0, harvestE: 0, start: E.clock,
      drains: [] };       // drains: [battery when the button went down, lowest before it was released / recharging]
    V.maxBoostKmh = 0; V.overTopFrames = 0;
    return true;
  };
  V.resetKers();
  var prevB = null, drain = null, lastDt = 0, lastSteps = -1;
  function record() {
    var g = F1.game, car = g && g.car;
    if (!car || !g.track) return;
    var st = car.state, gp = g.gp, ps = g.pit ? g.pit.state : null, spec = car.spec;
    // (this runs at the start of a frame: the state is the previous frame's, whose dt was lastDt; E.dt is the new one's)
    var fdt = lastDt;
    lastDt = E.dt;
    // a frame shorter than a physics step runs no car.update: its state (deploy, harvest) is the frame before's and says
    // nothing about the button of this one
    var stepped = E.truth.steps !== lastSteps;
    lastSteps = E.truth.steps;
    V.frames++;
    // battery bookkeeping (the button as the input path had it in the frame that just ran: pad RB or the E key)
    var b = st.battery, held = !!(E.ap.boost || g.boost);
    kers.frames++;
    if (stepped) {
      if (st.deploy > 0) { kers.deployFrames++; kers.deployT += fdt; if (!held) kers.deployNotHeld++; if (b <= 0 && prevB !== null && prevB <= 0) kers.deployWhileEmpty++; }
      if (st.harvest > 0) { kers.harvestFrames++; kers.harvestT += fdt; }
      if (held) { kers.heldFrames++; kers.heldT += fdt; if (!(st.deploy > 0)) kers.heldNoDeploy++; }
    }
    if (b < kers.minBattery) kers.minBattery = b;
    if (b > kers.maxBattery) kers.maxBattery = b;
    if (st.deploy > kers.maxDeploy) kers.maxDeploy = st.deploy;
    if (st.harvest > kers.maxHarvest) kers.maxHarvest = st.harvest;
    if (prevB !== null && spec && spec.ers) { if (b < prevB) kers.deployE += (prevB - b) * spec.ers.store; else kers.harvestE += (b - prevB) * spec.ers.store; }
    if (st.deploy > 0 && !drain) drain = { from: prevB !== null ? prevB : b, low: b, clock: E.clock };
    if (drain) { if (b < drain.low) drain.low = b; if (!(st.deploy > 0) && b > drain.low + 0.02) { if (kers.drains.length < 200) kers.drains.push([+drain.from.toFixed(4), +drain.low.toFixed(4)]); drain = null; } }
    if (b <= 0.05 && !kers.low) { kers.low = true; kers.cycles++; kers.lowAt = E.clock; kers.peakAfterLow = b; }
    if (kers.low) { if (b > kers.peakAfterLow) kers.peakAfterLow = b; if (b >= 0.35) { kers.low = false; kers.recharged++; } }
    if (b <= 0) kers.emptyFrames++;
    prevB = b;
    var kmh = Math.abs(st.speed) * 3.6;
    if (st.deploy > 0 && kmh > V.maxBoostKmh) V.maxBoostKmh = kmh;
    if (car.perf && Math.abs(st.speed) > car.perf.topSpeed * 1.004) V.overTopFrames++;
    // a compact time series (every V.every frames): clock, phase code, session lap, km/h, battery, deploy, harvest, button,
    // throttle, brake, in the pit lane, limiter, max tyre wear
    if (V.frames % V.every === 0 && V.series.length < 40000) {
      var ty = car.tyres ? car.tyres.state : null;
      V.series.push([E.clock, ({ free: 0, quali: 1, grid: 2, race: 3, results: 4 })[gp.phase], gp.lap, +kmh.toFixed(2), +b.toFixed(4), +st.deploy.toFixed(3),
        +st.harvest.toFixed(3), held ? 1 : 0, +st.throttle.toFixed(2), +st.brake.toFixed(2), ps && ps.inLane ? 1 : 0, g.limiter ? 1 : 0, ty ? +Math.max.apply(null, ty.wear).toFixed(4) : 0]);
    }
    // at every crossing of the line (solo-page.js's ground truth): the tyres as the telemetry graphic got them
    if (E.truth.lines !== lastLines) {
      lastLines = E.truth.lines;
      var t = E.tel, gr = car.tyres ? car.tyres.state.grip : null;
      V.laps.push({ line: E.truth.lines - 1, clock: E.clock, phase: gp.phase, gpLap: gp.lap, steps: E.truth.steps, held: E.truth.held,
        tel: t && t.tyres ? { compound: t.tyres.compound, wear: t.tyres.wear.slice(), flat: t.tyres.flat.slice(), puncture: t.tyres.puncture, next: t.nextCompound } : null,
        grip: gr ? { lat: gr.lat, brake: gr.brake, traction: gr.traction } : null, battery: b, inLane: !!(ps && ps.inLane) });
    }
    // the tyres at the start of every service (before the new set) and right after it (the new set)
    if (ps && ps.service && !inService) {
      inService = true;
      V.services.push({ startClock: E.clock, before: tyreCopy(car.tyres && car.tyres.state), telBefore: E.tel && E.tel.tyres ? { wear: E.tel.tyres.wear.slice(), compound: E.tel.tyres.compound } : null,
        total: ps.service.total, work: ps.service.work, penalty: ps.service.penalty, next: g.nextCompound, after: null, endClock: null });
    } else if (ps && !ps.service && inService) {
      inService = false;
      var sv = V.services[V.services.length - 1];
      sv.endClock = E.clock; sv.after = tyreCopy(car.tyres && car.tyres.state);
      sv.telAfter = E.tel && E.tel.tyres ? { wear: E.tel.tyres.wear.slice(), compound: E.tel.tyres.compound } : null;
    }
  }

  // the centreline follower on the stick (steerOnly): triggers at rest
  function steerStep() {
    var g = F1.game, st = g.car.state, track = g.track, S = track.samples, N = S.length, ds = track.length / N, v = Math.max(0, st.speed);
    var la = clamp(8 + 0.5 * v, 10, 40), s = S[(E.truth.idx + Math.round(la / ds)) % N];
    var gx = s.x - st.x, gz = s.z - st.z, sh = Math.sin(st.heading), ch = Math.cos(st.heading);
    var xf = gx * sh + gz * ch, yl = gx * ch - gz * sh, kap = 2 * yl / (xf * xf + yl * yl);
    var PERF = g.car.perf || F1.CAR_PERF, lock = PERF.steerLock / (1 + (v / PERF.steerSpeedRef) * (v / PERF.steerSpeedRef));
    var steer = clamp(Math.atan(kap * PERF.wheelbase) / lock, -1, 1);
    var b = E.pad.buttons;
    b[7].value = 0; b[7].pressed = false; b[6].value = 0; b[6].pressed = false; b[5].value = 0; b[5].pressed = false;
    E.pad.axes[0] = Math.abs(steer) < 1e-4 ? 0 : -(steer > 0 ? 1 : -1) * (0.12 + 0.88 * Math.pow(Math.min(1, Math.abs(steer)), 1 / 1.6));
    E.pad.axes[1] = 0;
    E.ap.thr = 0; E.ap.brk = 0; E.ap.boost = false;
    E.ap.want = E.pad.axes[0] === 0 ? 0 : -(E.pad.axes[0] > 0 ? 1 : -1) * Math.pow((Math.abs(E.pad.axes[0]) - 0.12) / 0.88, 1.6);
    E.ap.checkPad = false;                     // (the keyboard drives here: the pad check is the autopilot's)
  }

  var base = E.ap.step;
  E.ap.step = function () {
    record();
    if (V.steerOnly) { steerStep(); return; }
    return base.apply(E.ap, arguments);
  };

  // m metres from where the car is now, frame by frame -> the car there (the keys are held by the harness)
  V.ab = function (m, maxFrames) {
    var g = F1.game, track = g.track, ds = track.length / track.samples.length, U0 = E.truth.U, x0 = g.car.state.x, z0 = g.car.state.z;
    var out = { frames: 0, deployFrames: 0, deployT: 0, maxDeploy: 0, minBattery: 1, emptyAt: null, t0: E.clock, grass: 0, hits: 0, b0: g.car.state.battery };
    V.steerOnly = true; E.ap.on = true;
    while (out.frames < (maxFrames || 2400)) {
      var r = E.run(1, '', 5000);
      if (!r.n) break;
      out.frames += r.n;
      var st = g.car.state;
      if (st.deploy > 0) { out.deployFrames++; out.deployT += E.dt; }        // (E.dt: the frame that just ran)
      if (st.deploy > out.maxDeploy) out.maxDeploy = st.deploy;
      if (st.battery < out.minBattery) out.minBattery = st.battery;
      if (out.emptyAt === null && g.spec.ers && st.battery <= 0) out.emptyAt = (E.clock - out.t0) / 1000;
      if (st.onGrass) out.grass++;
      if (st.hit > 0) out.hits++;
      if ((E.truth.U - U0) * ds >= m) break;
    }
    var s = g.car.state;
    out.kmh = s.speed * 3.6; out.battery = s.battery; out.deploy = s.deploy; out.timeS = (E.clock - out.t0) / 1000; out.dist = (E.truth.U - U0) * ds;
    out.from = { x: x0, z: z0 }; out.tel = E.telBrief(); out.boostKey = !!g.boost; out.upKey = !!g.input.up;
    return out;
  };
  // the straight ahead of the car: metres until the racing line allows less than vKmh (where a car at that speed brakes)
  V.straightFromStart = function (vKmh) {
    var g = F1.game, P = g.raceLine.points, N = P.length, ds = g.track.length / N, i0 = E.truth.idx;
    for (var k = 0; k < N; k++) if (P[(i0 + k) % N].limit < vKmh / 3.6) return k * ds;
    return N * ds;
  };
  V.brief = function () { return { kers: kers, laps: V.laps, services: V.services, maxBoostKmh: V.maxBoostKmh, overTopFrames: V.overTopFrames, frames: V.frames, series: V.series.length }; };
  return 'ok';
})();
