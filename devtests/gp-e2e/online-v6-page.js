// Runs INSIDE the game page for devtests/gp-e2e/online-v6.js, injected after autopilot.js, pitplan.js and page.js
// (window.__e2e): window.__v6. Everything goes through the fake controller of page.js (its pad object, read by the
// game through navigator.getGamepads), on top of the race autopilot:
//   - ERS: RB held on the straights while the autopilot accelerates (throttle >= 0.5, no brake, > 20 m/s, steering
//     < 0.2, battery left), never in the pit plan
//   - the pit stop: armed with __v6.armPit({ onLap, startM, scale, compound }); on that lap of the race, startM metres
//     before track.pit.from, the pit plan (pitplan.js) takes over: into the lane (LB: limiter on before the entry line,
//     off after the exit line), into the box of our room slot, held for the service, out and back onto the racing
//     line, then the autopilot drives on. compound: X pressed until F1.game.nextCompound is it (before the stop).
//     (Pad layout of v6.1, js/gamepad.js: A / RB battery, B / LB limiter, X next compound, Y reset, View line.)
//   - recorders: ERS use, pit-lane intervals (session clock), the service, what our car felt in the lane, and every
//     other car seen in the lane while we were in it (drawn translucent? solid for the game? closest distance)
(function () {
  'use strict';
  if (window.__v6) return 'already';
  var F1 = window.F1, e2e = window.__e2e, ap = e2e.ap, step = ap.step;
  var pad = navigator.getGamepads()[0];               // page.js's fake controller (drive() returns at once: e2e.on is false)
  var V = window.__v6 = {
    ers: { on: true, frames: 0, boostFrames: 0, deployFrames: 0, maxDeploy: 0, minBattery: 1, harvestFrames: 0, batteryAtGo: null },
    pitArm: null, plan: null, planInfo: null, planErr: null, taps: [], tapLog: [],
    lane: [],               // [{ in: session clock, out: session clock | null, perfIn, perfOut }]
    seen: {},               // other player id -> { frames, translucent, solid, minDist, hitWhile } while both in the lane
    pitEvents: [], toastAtService: null,
    hitLog: []              // frames with an impact while the pit plan drives: { t, phase, i, d, v, hit, near, nd, paved, inLane }
  };
  function btn(i, v) { pad.buttons[i].value = v; pad.buttons[i].pressed = v > 0.5; }

  // a button tap: down for two pad reads, up for two (gamepad.js reacts to the edge)
  function tap(i, why) { V.taps.push({ b: i, n: 0 }); V.tapLog.push([Math.round(performance.now()), i, why || '']); }
  function runTaps() {
    var t = V.taps[0];
    if (!t) return;
    btn(t.b, t.n < 2 ? 1 : 0);
    if (++t.n >= 4) V.taps.shift();
  }

  V.armPit = function (o) { V.pitArm = o; V.plan = null; V.planInfo = null; V.planErr = null; return true; };
  V.info = function () { return { plan: V.plan ? V.plan.info() : V.planInfo, err: V.planErr, lane: V.lane, seen: V.seen, ers: V.ers, events: V.pitEvents, taps: V.tapLog.slice(-20),
    limiter: F1.game.limiter, next: F1.game.nextCompound, tyres: F1.game.tyres ? { compound: F1.game.tyres.state.compound, wear: F1.game.tyres.state.wear.slice(), puncture: F1.game.tyres.state.puncture } : null,
    stops: F1.game.pit ? F1.game.pit.state.stops : null, hold: ap.stats.holds, hitLog: V.hitLog }; };

  function distToPitFrom(st, track) {
    var N = track.samples.length, k = ((track.pit.from - st.sampleIndex) % N + N) % N;
    return k * track.length / N;
  }

  ap.step = function (env) {
    var g = F1.game, st = env.st, track = env.track, c = ap.cfg, o;
    runTaps();
    // the pit programme
    var arm = V.pitArm;
    if (arm && !V.plan && !arm.started && F1.gp.phase === 'race' && g.lap && g.lap.n === arm.onLap && track.pit && !env.locked) {
      var m = distToPitFrom(st, track);
      if (m < arm.startM && m > arm.startM - 120) {
        var p = window.createPitPlan(track, g.raceLine, st, { slot: F1.net.slot || 0, scale: arm.scale || c.scale, limiterM: 30 });
        arm.started = performance.now();
        if (p.error) V.planErr = p.error; else V.plan = p;
      }
    }
    if (arm && arm.compound && g.nextCompound !== arm.compound && !V.taps.length && !(g.pit && g.pit.state.service)) tap(2, 'compound');   // X
    if (V.plan) {
      var keep = c.mode;
      c.mode = 'idle'; step(env); c.mode = keep;      // (the autopilot keeps its bookkeeping fresh, and restarts clean afterwards)
      o = V.plan.step(st, g.car.perf || F1.CAR_PERF, env.dt || 1 / 60, g.pit ? g.pit.state : null, env.locked, env.others);
      // what hit us during the stop: where, in which phase of the plan, the nearest other car, on the pit asphalt?
      if (st.hit > 0.005 && V.hitLog.length < 80) {
        var nearId = null, nd = 1e9;
        for (var hi = 0; hi < env.others.length; hi++) { var ot = env.others[hi], dd = Math.hypot(ot.x - st.x, ot.z - st.z); if (dd < nd) { nd = dd; nearId = ot.id; } }
        V.hitLog.push({ t: +env.t.toFixed(2), phase: o.phase, i: st.sampleIndex, d: +st.d.toFixed(2), v: +st.speed.toFixed(1), hit: +st.hit.toFixed(3), near: nearId, nd: +nd.toFixed(1),
          paved: !!(track.pit.paved && track.pit.paved(st.sampleIndex, st.d)), inLane: !!(g.pit && g.pit.state.inLane) });
      }
      if (o.limiter !== g.limiter && !V.taps.length) tap(4, o.limiter ? 'limiter on' : 'limiter off');
      btn(5, 0);
      if (V.plan.done) { V.planInfo = V.plan.info(); V.plan = null; if (g.limiter && !V.taps.length) tap(4, 'limiter off (done)'); }
      return { steer: o.steer, throttle: o.throttle, brake: o.brake, reset: false };
    }
    o = step(env);
    var v = st.speed;
    // ERS on the straights
    var E = V.ers, boost = E.on && !env.locked && o.throttle >= 0.5 && !(o.brake > 0) && v > 20 && Math.abs(o.steer) < 0.2 && st.battery > 0.02 && !(g.pit && g.pit.state.inLane);
    btn(5, boost ? 1 : 0);
    E.frames++; if (boost) E.boostFrames++;
    return o;
  };
  // (page.js gives the autopilot no dt: the frame's own)
  var lastT = 0;
  var stepAp = ap.step;
  ap.step = function (env) { var t = env.t; env.dt = lastT ? Math.min(0.25, Math.max(0, t - lastT)) : 1 / 60; lastT = t; return stepAp(env); };

  // per frame (own rAF loop, at 10 Hz for the model look-up): ERS state, the pit lane
  var lastModelCheck = 0, wasIn = false;
  function loop(t) {
    requestAnimationFrame(loop);
    var g = F1.game;
    if (!g || !g.car || !g.track || !g.running) return;
    var st = g.car.state, E = V.ers, P = g.pit ? g.pit.state : null;
    if (st.deploy > 0.05) { E.deployFrames++; if (st.deploy > E.maxDeploy) E.maxDeploy = st.deploy; }
    if (st.harvest > 0.05) E.harvestFrames++;
    if (F1.gp.phase === 'race' && st.battery < E.minBattery) E.minBattery = st.battery;
    if (!P) return;
    var now = F1.net.connected ? F1.net.serverNow() : 0;
    if (P.inLane && !wasIn) V.lane.push({ in: now, out: null, perfIn: Math.round(t), perfOut: null, phase: F1.gp.phase });
    if (!P.inLane && wasIn && V.lane.length) { var l = V.lane[V.lane.length - 1]; l.out = now; l.perfOut = Math.round(t); }
    wasIn = P.inLane;
    if (P.inLane && F1.net.connected) {
      var check = t - lastModelCheck > 100;
      if (check) lastModelCheck = t;
      for (var i = 0; i < F1.net.players.length; i++) {
        var p = F1.net.players[i];
        if (!p.active || !g.track.pit.contains(p.state.x, p.state.z)) continue;
        var s = V.seen[p.id] || (V.seen[p.id] = { frames: 0, translucentChecks: 0, opaqueChecks: 0, gpGhost: 0, minDist: 1e9, hitWhile: 0 });
        s.frames++;
        var d = Math.hypot(p.state.x - st.x, p.state.z - st.z);
        if (d < s.minDist) s.minDist = d;
        if (st.hit > s.hitWhile) s.hitWhile = st.hit;
        if (F1.gp.isGhost(p.id)) s.gpGhost++;
        if (check) {
          var mdl = g.remoteModels[p.id], tr = false;
          if (mdl) mdl.group.traverse(function (o) { if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 0.9) tr = true; });
          if (tr) s.translucentChecks++; else s.opaqueChecks++;
        }
      }
    }
  }
  requestAnimationFrame(loop);
  if (F1.game.pit) {
    // the pit events main.js reacts to (through its toasts): service start / done with the session clock, the lap
    // clock (it must run on while the car is held), the tyres, the pit strip's text
    var lastSvc = null;
    setInterval(function () {
      var g = F1.game, P = g.pit && g.pit.state; if (!P) return;
      var s = P.service ? 'on' : 'off';
      if (s !== lastSvc) {
        var ty = g.tyres ? g.tyres.state : null, el = document.getElementById('hud-pit');
        V.pitEvents.push({ ev: s, clock: F1.net.connected ? Math.round(F1.net.serverNow()) : 0, perf: Math.round(performance.now()), total: P.service ? +P.service.total.toFixed(3) : null,
          stops: P.stops, lapT: g.lap ? +g.lap.time.toFixed(3) : null, lapN: g.lap ? g.lap.n : null, compound: ty ? ty.compound : null, wear: ty ? ty.wear.map(function (w) { return +w.toFixed(4); }) : null,
          x: +g.car.state.x.toFixed(2), z: +g.car.state.z.toFixed(2), strip: el && !el.classList.contains('hidden') ? el.innerText.replace(/\s+/g, ' ').trim() : '' });
        lastSvc = s;
      }
    }, 20);
  }

  /* ---------- frame cost: main-thread time of every rAF callback of a frame (game + recorders), per frame ---------- */
  var raf = window.requestAnimationFrame.bind(window), costTs = -1, costSum = 0;
  var cost = V.costRec = { n: 0, sum: 0, max: 0, over8: 0, over16: 0, buf: [] };
  function costFlush() {
    if (costTs < 0) return;
    cost.n++; cost.sum += costSum; if (costSum > cost.max) cost.max = costSum;
    if (costSum > 8) cost.over8++; if (costSum > 16.7) cost.over16++;
    if (cost.buf.length < 20000) cost.buf.push(costSum);
  }
  window.requestAnimationFrame = function (cb) {
    return raf(function (ts) {
      var t0 = performance.now();
      try { cb(ts); } finally {
        if (ts !== costTs) { costFlush(); costTs = ts; costSum = 0; }
        costSum += performance.now() - t0;
      }
    });
  };
  /** ms of main-thread script + render calls per frame since the last reset: { frames, mean, p50, p95, max, over8, over16 } */
  V.cost = function (reset) {
    var b = cost.buf.slice().sort(function (a, c) { return a - c; }), q = function (p) { return b.length ? +b[Math.min(b.length - 1, Math.floor(p * b.length))].toFixed(2) : null; };
    var o = { frames: cost.n, mean: cost.n ? +(cost.sum / cost.n).toFixed(2) : null, p50: q(0.5), p95: q(0.95), max: +cost.max.toFixed(1), over8: cost.over8, over16: cost.over16 };
    if (reset) { cost.n = 0; cost.sum = 0; cost.max = 0; cost.over8 = 0; cost.over16 = 0; cost.buf = []; }
    return o;
  };

  /* ---------- what the server says when it refuses / welcomes us (js/net.js keeps its socket to itself) ---------- */
  V.ws = [];
  var WS = window.WebSocket;
  if (WS && !WS.__v6) {
    var Hooked = function (url, protocols) {
      var s = protocols === undefined ? new WS(url) : new WS(url, protocols);
      s.addEventListener('message', function (ev) {
        try { var m = JSON.parse(ev.data); if (m && (m.t === 'error' || m.t === 'welcome')) V.ws.push({ t: m.t, code: m.code || null, at: Date.now(), url: String(url) }); } catch (e) {}
      });
      return s;
    };
    Hooked.prototype = WS.prototype; Hooked.__v6 = true;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Hooked[k] = WS[k]; });
    window.WebSocket = Hooked;
  }

  /* ---------- liveries: the colours the remote car models are painted in, against their CarSpecs ---------- */
  function hex(c) { return '#' + c.getHexString(); }
  V.liveries = function () {
    var g = F1.game, out = {};
    Object.keys(g.remoteModels).forEach(function (id) {
      var m = g.remoteModels[id], rc = g.remoteCars[id], cols = {};
      m.group.traverse(function (o) {
        var a = o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.color;
        if (!a || a.itemSize < 3) return;
        for (var k = 0; k < a.count; k++) cols['#' + [a.getX(k), a.getY(k), a.getZ(k)].map(function (v) { var h = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16); return h.length < 2 ? '0' + h : h; }).join('')] = 1;
      });
      var spec = rc && rc.spec;
      out[id] = { spec: spec ? spec.id : null, colour: spec ? spec.colour : null, colour2: spec ? spec.colour2 : null,
        painted1: !!(spec && cols[spec.colour.toLowerCase()]), painted2: !!(spec && cols[String(spec.colour2).toLowerCase()]), colours: Object.keys(cols).length, visible: m.group.visible };
    });
    return out;
  };

  /* ---------- the light curtains as the own camera sees them ---------- */
  V.curtains = function () {
    var g = F1.game, tr = g.track, P = tr && tr.pit, cam = g.camera;
    if (!P || !cam) return null;
    var mesh = tr.group ? tr.group.getObjectByName('pitCurtains') : null, out = { mesh: !!mesh, visible: !!(mesh && mesh.visible), opacity: mesh ? +mesh.material.opacity.toFixed(2) : null };
    cam.updateMatrixWorld();
    [['entry', P.entry], ['exit', P.exit]].forEach(function (e) {
      var s = tr.samples[e[1]], d = P.laneD(e[1]), y = (tr.surfaceY ? tr.surfaceY(e[1], d) : (s.y || 0)) + 2;
      var v = new THREE.Vector3(s.x + s.nx * d, y, s.z + s.nz * d), dist = v.distanceTo(cam.getWorldPosition(new THREE.Vector3()));
      v.project(cam);
      out[e[0]] = { ndcX: +v.x.toFixed(2), ndcY: +v.y.toFixed(2), dist: +dist.toFixed(1), onScreen: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z < 1 && v.z > -1 };
    });
    return out;
  };
  return 'ok';
})();
