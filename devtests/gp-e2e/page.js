// Runs INSIDE the game page (injected as text by the harnesses after autopilot.js): window.__e2e.
//   - a standard-mapping controller behind navigator.getGamepads whose sticks / triggers / Y button (reset; A until the
//     v6.1 pad layout) are set by the autopilot: the game reads it through its real input path (F1.gamepad.poll ->
//     mergeInput -> car.update)
//   - programmes the harness arms in advance, run from the page's own events so nothing depends on polling latency:
//     onPhase[phase] / onGo (autopilot settings applied when the session changes phase / the lights go out),
//     ram (drive at another car until touching / overlapping it), onHit (settings applied when a solid car hits us),
//     release (leave the parking place once the named cars have come past)
//   - recorders: frame rate, start lights per frame, closest approach to / impacts near every other car
//   - readers for the HUD, the panels and the results table (DOM text)
(function () {
  'use strict';
  var F1 = window.F1, ap = window.createAutopilot();
  var now = function () { return performance.now() / 1000; };

  /* ---------- the fake controller ---------- */
  var buttons = [];
  for (var bi = 0; bi < 17; bi++) buttons.push({ pressed: false, touched: false, value: 0 });
  var rumbles = 0;
  var pad = { index: 0, id: 'E2E Autopilot (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: buttons,
    vibrationActuator: { type: 'dual-rumble', playEffect: function () { rumbles++; return Promise.resolve('complete'); } } };
  function btn(i, v) { buttons[i].value = v; buttons[i].pressed = v > 0.5; }
  // inverse of js/gamepad.js: stick deadzone 0.12 + expo 1.6, trigger deadzone 0.04
  function stickFor(steer) {
    var a = Math.abs(steer);
    if (a < 0.003) return 0;
    var x = 0.12 + 0.88 * Math.pow(Math.min(1, a), 1 / 1.6);
    return steer > 0 ? -x : x;                        // stick left (negative axis) = steer left (+)
  }
  function trig(t) { return t > 0.002 ? 0.04 + 0.96 * Math.min(1, t) : 0; }

  var env = { t: 0, st: null, track: null, line: null, locked: false, others: [] };
  var lastDrive = -1, resetHeld = 0, driveCalls = 0;
  var last = { steer: 0, throttle: 0, brake: 0 };

  function apply(o) {
    for (var k in o) {
      if (k === 'holdFor') ap.cfg.holdUntil = now() + o[k];
      else ap.cfg[k] = o[k];
    }
  }

  function others() {
    var list = env.others, n = 0, net = F1.net;
    if (net && net.connected) {
      for (var i = 0; i < net.players.length; i++) {
        var p = net.players[i];
        if (!p.active) continue;
        var o = list[n] || (list[n] = {});
        o.id = p.id; o.x = p.state.x; o.z = p.state.z; o.heading = p.state.heading; o.speed = p.state.speed;
        o.solid = !F1.gp.isGhost(p.id);
        n++;
      }
    }
    list.length = n;
    return list;
  }

  // Called by the game whenever it reads the controller (once per rendered frame; every 100 ms in the menu).
  function drive() {
    var g = F1.game, t = performance.now();
    if (t - lastDrive < 2) return;                      // (rumble() reads the pad again in the same frame)
    lastDrive = t;
    pad.timestamp = t;
    if (resetHeld && --resetHeld === 0) btn(3, 0);
    if (!e2e.on || !g || !g.running || !g.car || !g.track || !g.raceLine) {
      pad.axes[0] = 0; btn(6, 0); btn(7, 0);
      last.steer = last.throttle = last.brake = 0;
      return;
    }
    driveCalls++;
    env.t = t / 1000; env.st = g.car.state; env.track = g.track; env.line = g.raceLine; env.locked = !!F1.gp.inputLocked;
    others();
    programmes(env);
    var o = ap.step(env);
    pad.axes[0] = stickFor(o.steer);
    btn(7, trig(o.throttle)); btn(6, trig(o.brake));
    if (o.reset) { btn(3, 1); resetHeld = 2; e2e.resetPresses++; }
    last.steer = o.steer; last.throttle = o.throttle; last.brake = o.brake;
  }

  /* ---------- programmes ---------- */
  function find(id) { for (var i = 0; i < env.others.length; i++) if (env.others[i].id === id) return env.others[i]; return null; }

  function programmes(env) {
    var st = env.st, r = e2e.ram, o, d;
    if (r && ap.cfg.mode === 'ram' && !r.result) {
      o = find(r.id);
      d = o ? Math.sqrt((o.x - st.x) * (o.x - st.x) + (o.z - st.z) * (o.z - st.z)) : Infinity;
      if (!r.t0 && !env.locked && env.t >= (ap.cfg.holdUntil || 0)) r.t0 = env.t;
      if (d < r.min || r.min == null) r.min = d;
      var why = '';
      if (r.untilHit && st.hit > 0.005 && d < 8 && !r.hitAt) { r.hitAt = env.t; r.hitMax = 0; }
      if (r.hitAt) { if (st.hit > r.hitMax) r.hitMax = st.hit; if (env.t - r.hitAt >= (r.after || 0)) why = 'hit'; }
      else if (r.untilDist && d < r.untilDist) why = 'dist';
      else if (r.t0 && env.t - r.t0 > (r.timeout || 6)) why = 'timeout';
      if (why) { r.result = { why: why, after: env.t - r.t0, dist: d, hit: r.hitMax || st.hit, min: r.min }; apply(r.then || { mode: 'line' }); }
    }
    var oh = e2e.onHit;
    if (oh && !oh.done && st.hit > 0.005) {
      for (var j = 0; j < env.others.length; j++) {
        o = env.others[j];
        if (o.solid && (o.x - st.x) * (o.x - st.x) + (o.z - st.z) * (o.z - st.z) < 64) { oh.done = env.t; oh.hit = st.hit; apply(oh.then); break; }
      }
    }
    var rel = e2e.release;
    if (rel && !rel.done && ap.parked) {
      var N = env.track.samples.length, all = true;
      for (var i = 0; i < rel.ids.length; i++) {
        var id = rel.ids[i];
        if (rel.passed[id]) continue;
        o = find(id);
        if (o) {
          var h = rel.hint[id], loc = env.track.locate(o.x, o.z, h == null ? -1 : h);
          rel.hint[id] = loc.index;
          var k = ((loc.index - st.sampleIndex + N + (N >> 1)) % N) - (N >> 1);      // samples ahead of us, -N/2..N/2
          if (rel.was[id] != null && rel.was[id] < 0 && rel.was[id] > -200 && k >= 0) rel.behind[id] = true;   // drew level
          if (rel.behind[id] && k >= (rel.clear || 12)) rel.passed[id] = env.t;
          rel.was[id] = k;
        }
        if (!rel.passed[id]) all = false;
      }
      if (all) { rel.done = env.t; apply(rel.then); }
    }
  }

  /* ---------- recorders (own rAF loop: one row per rendered frame) ---------- */
  var fps = { n: 0, t0: performance.now(), last: 0, maxGap: 0, slow: 0 };
  var prox = {};                 // other player id -> closest approach / strongest impact of ours while it was near
  var hit = { max: 0, maxGhostNear: 0, maxSolidNear: 0 };
  var lights = null;             // rows while armed
  var moved = null;              // launch: {goPerf, movedPerf}
  function lamps() { return document.querySelectorAll('#hud-lights i.on').length; }
  var rafT = 0;                  // the rAF timestamp of the frame being run (our callback runs before the game's)
  function loop(t) {
    requestAnimationFrame(loop);
    rafT = t;
    if (fps.last) { var gap = t - fps.last; if (gap > fps.maxGap) fps.maxGap = gap; if (gap > 50) fps.slow++; }
    fps.last = t; fps.n++;
    var g = F1.game;
    if (!g || !g.car || !g.track) return;
    var st = g.car.state, net = F1.net;
    if (st.hit > hit.max) hit.max = st.hit;
    if (net && net.connected) {
      for (var i = 0; i < net.players.length; i++) {
        var p = net.players[i];
        if (!p.active) continue;
        var r = prox[p.id] || (prox[p.id] = { min: 1e9, minGhost: 1e9, minSolid: 1e9, hitGhost: 0, hitSolid: 0 });
        var d = Math.sqrt((p.state.x - st.x) * (p.state.x - st.x) + (p.state.z - st.z) * (p.state.z - st.z));
        var ghost = F1.gp.isGhost(p.id);
        if (d < r.min) r.min = d;
        if (ghost) { if (d < r.minGhost) r.minGhost = d; if (d < 7.5 && st.hit > r.hitGhost) r.hitGhost = st.hit; }
        else { if (d < r.minSolid) r.minSolid = d; if (d < 7.5 && st.hit > r.hitSolid) r.hitSolid = st.hit; }
      }
    }
  }
  // The start, frame by frame: main.js calls F1.gp.update first thing in every frame it simulates and F1.ui.setLights
  // at its end, so a row written right after setLights is what THAT frame put on screen (lamps, green state) and did
  // to the car, and the clocks read right before gp.update are the ones the frame decided with.
  // (Our own rAF callback runs before the game's: it would see each frame one frame late.)
  // Also measured here: how long after its rAF timestamp the game's frame really starts (frameDelay), and - for the
  // frames after lights out - how far the race clock (lap.time) is from the session clock (raceClock: ahead > 0).
  // e2e.hitch = ms: fault injection, a main-thread hitch of that length right before the frame in which the lights go out
  // (once per arming): what a GC pause / a slow frame at that moment does.
  var frameClock = 0, frameWall = 0, frameDelay = 0, gpUpdate = F1.gp.update;
  F1.gp.update = function () {
    var gp = F1.gp, s = gp.snapshot;
    if (e2e.hitch > 0 && s && gp.taking && (gp.phase === 'grid' || gp.phase === 'race') && (!e2e.go || e2e.go.sid !== gp.sid) && F1.net.serverNow() >= s.goAt) {
      var end = performance.now() + e2e.hitch;
      e2e.hitch = 0;
      while (performance.now() < end) { /* busy */ }
    }
    frameDelay = performance.now() - rafT;
    frameClock = F1.net.serverNow(); frameWall = Date.now();
    return gpUpdate.apply(this, arguments);
  };
  var setLights = F1.ui.setLights;
  F1.ui.setLights = function () {
    var r = setLights.apply(this, arguments), g = F1.game;
    if (!g || !g.car) return r;
    var st = g.car.state, t = performance.now();
    if (moved && moved.movedPerf === null && Math.abs(st.speed) > 0.3) moved.movedPerf = t;
    var rc = e2e.raceClock;
    if (rc && rc.n < 600 && g.lap && g.lap.started && F1.gp.snapshot && (F1.gp.phase === 'race' || F1.gp.phase === 'grid') && F1.gp.taking && !F1.gp.inputLocked) {
      var ahead = g.lap.time * 1000 - (frameClock - F1.gp.snapshot.goAt);      // ms
      if (rc.n === 0) { rc.first = ahead; rc.max = rc.min = ahead; }
      else { if (ahead > rc.max) rc.max = ahead; if (ahead < rc.min) rc.min = ahead; }
      rc.sum += ahead; rc.n++;
      if (frameDelay > rc.delayMax) rc.delayMax = frameDelay;
      rc.delaySum += frameDelay;
    }
    if (lights) {
      var gp = F1.gp, L = document.getElementById('hud-lights');
      lights.push([t, frameClock, frameWall, gp.phase, gp.inputLocked ? 1 : 0, lamps(), gp.lights, L.classList.contains('go') ? 1 : 0,
        L.classList.contains('hidden') ? 0 : 1, st.speed, st.x, st.z, document.getElementById('hud-lights-text').textContent]);
      if (lights.length > 3000) lights.shift();
    }
    return r;
  };

  /* ---------- DOM readers ---------- */
  function $(id) { return document.getElementById(id); }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function shown(id) { var e = $(id); if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function text(id) { var e = $(id); return e ? clean(e.innerText) : null; }
  function q(node, sel) { var e = node.querySelector(sel); return e ? clean(e.textContent) : ''; }
  function gpRows(id) {
    var out = [], rows = $(id).querySelectorAll('.gp-row');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.push({ pos: q(r, '.gp-pos'), name: q(r, '.mp-pname'), sub: q(r, '.gp-sub'), val: q(r, '.gp-val'), best: q(r, '.gp-best'),
        self: r.classList.contains('self'), out: r.classList.contains('out'), colour: r.querySelector('.mp-dot').style.background });
    }
    return out;
  }

  var e2e = window.__e2e = {
    on: false, ap: ap, resetPresses: 0, hitch: 0, raceClock: null, onPhase: {}, onGo: null, ram: null, onHit: null, release: null, go: null, phases: [], lapsDone: [], rejected: [],
    /** Autopilot settings: any of ap.cfg's fields, plus holdFor (s from now). */
    set: function (o) { apply(o); return true; },
    /** Arm a programme: { onPhase: {quali: cfg, ...}, onGo: cfg, ram: {...}, release: {...} } */
    arm: function (o) {
      if (o.onPhase) e2e.onPhase = o.onPhase;
      if ('onGo' in o) e2e.onGo = o.onGo;
      if ('ram' in o) e2e.ram = o.ram;
      if ('onHit' in o) e2e.onHit = o.onHit;
      if ('release' in o) { e2e.release = o.release; if (o.release) { o.release.passed = {}; o.release.was = {}; o.release.behind = {}; o.release.hint = {}; } }
      return true;
    },
    start: function () { e2e.on = true; return true; },
    stop: function () { e2e.on = false; return true; },
    /** What the autopilot did since the last call. */
    stats: function (reset) { var s = reset ? ap.resetStats() : ap.stats; return { steps: s.steps, grass: s.grass, wall: s.wall, wallMax: s.wallMax, car: s.car, carMax: s.carMax,
      carAt: s.carAt.slice(), resets: s.resets, reverses: s.reverses, maxDev: s.maxDev, accSteps: s.accSteps, avoidSteps: s.avoidSteps, parked: ap.parked, events: s.events.slice(), blend: ap.blend,
      mode: ap.cfg.mode, scale: ap.cfg.scale, rumbles: rumbles, now: now(), goPerf: e2e.go ? e2e.go.perf / 1000 : null, resetPresses: e2e.resetPresses, last: { steer: last.steer, throttle: last.throttle, brake: last.brake } }; },
    /** Frames rendered since the last call: { fps, frames, ms, maxGap, slow (gaps > 50 ms) } */
    fps: function () { var t = performance.now(), o = { frames: fps.n, ms: t - fps.t0, fps: fps.n * 1000 / (t - fps.t0), maxGap: fps.maxGap, slow: fps.slow };
      fps.n = 0; fps.t0 = t; fps.maxGap = 0; fps.slow = 0; return o; },
    prox: function (reset) { var o = JSON.parse(JSON.stringify(prox)); o.hitMax = hit.max; if (reset) { prox = {}; hit.max = 0; } return o; },
    lightsRec: function () { lights = []; return true; },
    lightsStop: function () { var r = lights; lights = null; return r; },
    launch: function () { return moved && moved.movedPerf !== null ? moved.movedPerf - moved.goPerf : null; },

    car: function () { var s = F1.game.car.state; return { x: s.x, y: s.y || 0, z: s.z, h: s.heading, v: s.speed, i: s.sampleIndex, d: s.d, steer: s.steer, hit: s.hit, grass: s.onGrass,
      n: F1.game.track.samples.length }; },
    // the car in the frame of grid box slot + 1, from the RULE (front bar (slot + 1) * 8 m behind the line, 3 m left / right),
    // not from track.grid: nose = m from the front of the bar back to the car's nose (0.25 = at its rear edge)
    box: function (slot) {
      var tr = F1.game.track, S = tr.samples, n = S.length, k = slot + 1, c = F1.game.car.state;
      var s = S[((n - Math.round(k * 8 / (tr.length / n))) % n + n) % n], lat = k % 2 ? 3 : -3;
      var nx = c.x + Math.sin(c.heading) * 2.8, nz = c.z + Math.cos(c.heading) * 2.8, turn = c.heading - Math.atan2(s.tx, s.tz);
      return { nose: -((nx - s.x) * s.tx + (nz - s.z) * s.tz), off: (nx - s.x) * s.nx + (nz - s.z) * s.nz - lat, turn: Math.atan2(Math.sin(turn), Math.cos(turn)), d: c.d, v: c.speed };
    },
    gp: function () { var g = F1.gp; return { phase: g.phase, online: g.online, taking: g.taking, locked: g.inputLocked, lights: g.lights, goFlash: g.goFlash, sinceGo: g.sinceGo,
      gridSlot: g.gridSlot, lap: g.lap, lapTotal: g.lapTotal, sid: g.sid, canControl: g.canControl, selfId: g.selfId }; },
    lap: function () { var l = F1.game.lap; return l ? { started: l.started, n: l.n, time: l.time, last: l.last, best: l.best, behind: l.behind, void: l.void,
      prog: l.progress(F1.game.car.state.sampleIndex) } : null; },
    state: function () { return { car: e2e.car(), gp: e2e.gp(), lap: e2e.lap(), running: F1.game.running, clock: F1.net.serverNow(), wall: Date.now() }; },
    view: function () { var v = F1.gp.view(); v.sid = F1.gp.sid; v.clock = F1.net.serverNow(); v.endsAt = F1.gp.snapshot ? F1.gp.snapshot.endsAt : 0; v.winnerAt = F1.gp.snapshot ? F1.gp.snapshot.winnerAt : 0; return v; },
    snap: function () { return F1.gp.snapshot; },
    // remote cars: id -> { name, active, drawn translucent, visible, x, z, v, solid (the game's own rule) }
    remotes: function () {
      var m = F1.game.remoteModels, out = {};
      F1.net.players.forEach(function (p) {
        var ghost = null, vis = null;
        if (m[p.id]) { ghost = false; vis = m[p.id].group.visible; m[p.id].group.traverse(function (o) { if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 0.9) ghost = true; }); }
        out[p.name] = { id: p.id, active: p.active, ghost: ghost, visible: vis, x: p.state.x, z: p.state.z, v: p.state.speed, isGhost: F1.gp.isGhost(p.id) };
      });
      return out;
    },
    shown: shown, text: text,
    // the start lights, read without forcing a layout (polled every 50 ms while the lights are on)
    lightsNow: function () { var L = $('hud-lights'); return { shown: !L.classList.contains('hidden'), on: lamps(), go: L.classList.contains('go') }; },
    hud: function () {
      return { lapRow: text('hud-lap'), cur: text('hud-cur'), last: text('hud-last'), best: text('hud-best'), speed: text('hud-speed'),
        gpShown: shown('hud-gp'), title: text('hud-gp-title'), pos: text('hud-gp-pos'), lapShown: shown('hud-gp-laprow'), gpLap: text('hud-gp-lap'),
        note: shown('hud-gp-note') ? text('hud-gp-note') : '', ends: shown('hud-gp-ends') ? text('hud-gp-ends') : '', rows: gpRows('hud-gp-rows'),
        spec: shown('hud-gp-spec') ? text('hud-gp-spec') : '', roster: shown('hud-players'), toast: shown('hud-toast') ? text('hud-toast') : '',
        lights: { shown: shown('hud-lights'), on: lamps(), go: $('hud-lights').classList.contains('go'), text: $('hud-lights-text').textContent },
        results: shown('gp-results'), menu: shown('menu'), hudShown: shown('hud'), error: $('error').classList.contains('hidden') ? '' : $('error-text').textContent };
    },
    roster: function () {           // the room's roster box in the HUD: [{name, best}]
      var out = [], rows = $('hud-players').querySelectorAll('.prow');
      for (var i = 0; i < rows.length; i++) out.push({ name: q(rows[i], '.mp-pname'), best: q(rows[i], '.pt') });
      return out;
    },
    results: function () {          // the results overlay
      var rows = [], trs = $('gp-results-body').querySelectorAll('tbody tr');
      for (var i = 0; i < trs.length; i++) {
        var t = trs[i];
        rows.push({ pos: q(t, '.c-pos'), name: q(t, '.mp-pname'), you: !!t.querySelector('.mp-tag'), laps: q(t, '.c-laps'), time: q(t, '.c-time'), gap: q(t, '.c-gap'), best: q(t, '.c-best'),
          fl: t.querySelector('.c-best').classList.contains('fl'), out: t.classList.contains('out'), self: t.classList.contains('self') });
      }
      return { shown: shown('gp-results'), sub: text('gp-results-sub'), rows: rows, spec: shown('gp-results-spec') ? text('gp-results-spec') : '', note: text('gp-results-note'),
        again: shown('gp-res-again'), end: shown('gp-res-end'), close: shown('gp-close') };
    },
    panel: function () {            // the Grand Prix panel in the menu
      return { setup: shown('gp-setup'), startDisabled: $('gp-start').disabled, hint: shown('gp-hint') ? text('gp-hint') : '', session: shown('gp-session'), state: text('gp-state'),
        self: shown('gp-self') ? text('gp-self') : '', skip: shown('gp-skip'), again: shown('gp-again'), end: shown('gp-end'), rows: gpRows('gp-standings'),
        spec: shown('gp-spec') ? text('gp-spec') : '' };
    },
    toasts: []                      // every toast text the page showed: [ms, text]
  };

  // every toast, as shown (they replace each other quickly)
  var toastEl = $('hud-toast'), lastToast = '';
  new MutationObserver(function () {
    var t = toastEl.classList.contains('hidden') ? '' : clean(toastEl.textContent);
    if (t && t !== lastToast) { e2e.toasts.push([Math.round(performance.now()), t]); if (e2e.toasts.length > 200) e2e.toasts.shift(); }
    lastToast = t;
  }).observe(toastEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  F1.gp.on('phase', function (phase, prev) {
    e2e.phases.push([Math.round(performance.now()), phase, F1.gp.sid, F1.net.connected ? F1.net.serverNow() : 0]);
    var o = e2e.onPhase && e2e.onPhase[phase];
    if (o) apply(o);
  });
  F1.gp.on('go', function () {
    var t = performance.now();
    e2e.go = { server: F1.net.serverNow(), wall: Date.now(), perf: t, goAt: F1.gp.snapshot.goAt, phase: F1.gp.phase, sid: F1.gp.sid, frameDelay: frameDelay };
    e2e.raceClock = { n: 0, first: 0, max: 0, min: 0, sum: 0, delayMax: 0, delaySum: 0, goFrameDelay: frameDelay };
    moved = { goPerf: t, movedPerf: null };
    if (e2e.onGo) apply(e2e.onGo);
  });
  F1.gp.on('lapRejected', function (why) { e2e.rejected.push(why); });
  // every lap the game's lap counter completes (main.js hands it to F1.gp.lapDone): [seconds, phase, session id]
  var lapDone = F1.gp.lapDone;
  F1.gp.lapDone = function (time) {
    e2e.lapsDone.push({ time: time, phase: F1.gp.phase, sid: F1.gp.sid, clock: F1.net.serverNow() });
    return lapDone.apply(this, arguments);
  };

  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { drive(); return [pad, null, null, null]; } });
  requestAnimationFrame(loop);
  return true;
})();
