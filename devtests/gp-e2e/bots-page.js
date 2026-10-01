// Lives in the PAGE (injected by devtests/gp-e2e/bots.js with executeJavaScript, after solo-page.js in the time-warped
// windows, alone in the real-time room windows): window.__bots.
//
//   the player   our car is driven by a computer driver of its own (F1.createAIDriver, the same brain as the bots: it
//                sees every other car, so it races them instead of driving through them) through a fake standard-mapping
//                controller behind navigator.getGamepads: RT / LT / left stick from its pedals and steering, RB (battery)
//                from its boost, B (pit limiter, a toggle) pressed when the limiter it wants differs from the game's,
//                Y (reset) when it asks for R. Nothing here writes car.state or the session: the game's real input path.
//                Time-warped (solo-page.js present): it replaces __e.ap.step, so it runs once per warped frame before
//                main.js's frame (the line autopilot / pit driver of solo-page.js take over when __bots.on is false).
//                Real time: it runs whenever the game polls the controller (once per frame).
//                Options: __bots.skill (0..1), .pit (true: it may plan / be told stops: ctx.pit = the game's pit state),
//                .stop(compound) a stop at the next pit entry, .hold = {until: game s, kmh} drive no faster than kmh (a
//                slow / parked player), .brakeTest = {at: sample, kmh} (lift and brake hard there once).
//   recorders    contacts (F1.resolveCarCollisions wrapped: every impact on our car / a bot's, per car and phase, events
//                0.5 s apart), each bot's race distance (stuck: no progress for 15 s while racing, not in its box),
//                positions every 0.5 s of game time during the race (overtakes = order changes), the pit lane (cars in it
//                at once, speeding frames, stops), the player's lap / place, the field's states for screenshots.
(function () {
  'use strict';
  if (window.__bots) return 'already';
  var F1 = window.F1, E = window.__e || null;
  var B = window.__bots = {
    on: false, skill: 0.85, seed: 4242, pit: false, hold: null, brakeTest: null,
    me: null, track: null, spec: null, meSkill: -1, entry: {}, ctx: null, views: [], byId: {},
    frames: 0, resets: 0, limiterPresses: 0, input: null,
    contacts: [], hitsBy: {}, rec: null, err: ''
  };
  var STEP = 1 / 120;
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function gameS() { return E ? E.clock / 1000 : performance.now() / 1000; }

  /* ---------- the controller ---------- */
  var pad;
  if (E) pad = E.pad;                         // (solo-page.js's: navigator.getGamepads already returns it)
  else {
    var bs = [];
    for (var i = 0; i < 17; i++) bs.push({ pressed: false, touched: false, value: 0 });
    pad = { index: 0, id: 'Bots E2E Player (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0,
      axes: [0, 0, 0, 0], buttons: bs, vibrationActuator: { type: 'dual-rumble', playEffect: function () { B.rumbles++; return Promise.resolve('complete'); } } };
    var lastPoll = -1;
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () {
      var t = performance.now();
      if (t - lastPoll > 2) { lastPoll = t; try { realTimeStep(); } catch (err) { B.err = String(err && err.stack || err); } }
      pad.timestamp = t;
      return [pad, null, null, null];
    } });
  }
  B.rumbles = 0;
  B.pad = pad;
  function btn(i, v) { pad.buttons[i].value = v; pad.buttons[i].pressed = v > 0.5; }
  // inverse of js/gamepad.js: trigger deadzone 0.04, radial stick deadzone 0.12 + expo 1.6 (+1 = left = stick left)
  function trig(t) { return t > 0.002 ? (t >= 1 ? 1 : 0.04 + 0.96 * t) : 0; }
  function stick(s) {
    var a = Math.abs(s);
    if (a < 0.003) return 0;
    var x = 0.12 + 0.88 * Math.pow(Math.min(1, a), 1 / 1.6);
    return s > 0 ? -x : x;
  }
  function rest() { pad.axes[0] = 0; pad.axes[1] = 0; btn(6, 0); btn(7, 0); btn(5, 0); if (!pressLim) btn(1, 0); if (!pressY) btn(3, 0); }

  /* ---------- the player's driver ---------- */
  function selfSlot() { return F1.net && F1.net.connected ? F1.net.slot || 0 : 0; }
  function ensureDriver() {
    var g = F1.game;
    if (!g || !g.track || !g.raceLine || !g.car || typeof F1.createAIDriver !== 'function') return null;
    if (B.me && B.track === g.track && B.spec === g.car.spec && B.meSkill === B.skill && B.slot === selfSlot()) return B.me;
    B.me = F1.createAIDriver({ track: g.track, raceLine: g.raceLine, car: g.car, skill: B.skill, seed: B.seed, id: F1.gp.selfId,
      slot: selfSlot(), name: 'player' });
    B.track = g.track; B.spec = g.car.spec; B.meSkill = B.skill; B.slot = selfSlot();
    B.ctx = F1.AI.createContext();
    B.me.reset();
    return B.me;
  }
  // our car was placed (track, qualifying start, grid, free practice again): the driver forgets its plans
  F1.gp.on('phase', function (phase) { if (B.me) B.me.reset(); B.phaseAt[phase] = gameS(); });
  B.phaseAt = {};
  // holdAfterGo = s: a stalled start (we stand still for s seconds after lights out)
  F1.gp.on('go', function () { B.goAt = gameS(); if (B.holdAfterGo > 0) B.hold = { until: gameS() + B.holdAfterGo, kmh: 0 }; });
  B.stop = function (compound) { var me = ensureDriver(); if (!me) return false; B.pit = true; me.planStop(compound || 'H'); return true; };

  function view(id) { var v = B.byId[id]; if (!v) v = B.byId[id] = F1.AI.createView(id); return v; }
  function paved(track, idx, d) { var P = track.pit; return !!(P && typeof P.paved === 'function' && P.paved(idx, d)); }
  function remoteProg(id, idx, N) {
    var s = F1.gp.snapshot;
    if (!s || (F1.gp.phase !== 'race' && F1.gp.phase !== 'results')) return NaN;
    for (var i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      if (p.id !== id) continue;
      var f = (idx | 0) / N;
      if (p.rLaps === 0 && f > 0.5 && F1.gp.sinceGo < 20) f -= 1;
      return p.rLaps + f;
    }
    return NaN;
  }
  // every other car as think() wants it: the local bots (ours), the remote cars (other players and other games' bots)
  function fillViews() {
    var g = F1.game, track = g.track, N = track.samples.length, list = B.views, n = 0, i, v, st;
    var bots = g.bots || [];
    for (i = 0; i < bots.length; i++) {
      var b = bots[i]; st = b.car.state; v = view(b.id);
      v.x = st.x; v.z = st.z; v.y = isNum(st.y) ? st.y : NaN; v.heading = st.heading; v.speed = st.speed; v.sampleIndex = st.sampleIndex; v.d = st.d;
      v.ghost = F1.gp.isGhost(b.id) || paved(track, st.sampleIndex, st.d) || !!b.pit.state.service;
      v.prog = b.lap ? b.lap.progress(st.sampleIndex) : NaN; v.pace = b.ai.pace;
      list[n++] = v;
    }
    var net = F1.net, P = net && net.connected ? net.players : [];
    for (i = 0; i < P.length; i++) {
      var p = P[i];
      if (!p.active || !p.state) continue;
      v = view(p.id);
      F1.AI.updateView(v, p.state, track);
      v.ghost = F1.gp.isGhost(p.id) || paved(track, v.sampleIndex, v.d);
      v.prog = remoteProg(p.id, v.sampleIndex, N); v.pace = NaN;
      list[n++] = v;
    }
    list.length = n;
    return list;
  }

  var pressLim = 0, pressY = 0, lastLimF = -1e9, lastYF = -1e9, tapOn = -1;
  // a button tapped for the harness (e.g. X: the next compound): one frame pressed, one released, in order
  B.taps = [];
  B.tap = function (i) { B.taps.push(i); return true; };
  function drive(dt) {
    var g = F1.game;
    B.frames++;
    if (pressLim && --pressLim === 0) btn(1, 0);
    if (pressY && --pressY === 0) btn(3, 0);
    if (tapOn >= 0) { btn(tapOn, 0); tapOn = -1; }
    else if (B.taps.length) { tapOn = B.taps.shift(); btn(tapOn, 1); }
    if (!B.on || !g || !g.running || !g.car || !g.track || !g.raceLine) { rest(); return; }
    var me = ensureDriver();
    if (!me) { rest(); return; }
    var gp = F1.gp, e = gp.entry(gp.selfId, B.entry), c = B.ctx, st = g.car.state;
    c.phase = gp.phase; c.locked = !!gp.inputLocked; c.lap = e.lap; c.laps = e.lapTotal; c.done = e.done === true;
    c.prog = g.lap ? g.lap.progress(st.sampleIndex) : NaN;
    c.pit = B.pit && g.pit ? g.pit.state : null;
    c.wear = gp.snapshot && gp.phase !== 'free' && gp.phase !== 'quali' ? gp.snapshot.wear || 1 : 1;
    var inp = me.think(dt > 0 ? dt : STEP, fillViews(), c);
    B.input = inp;
    var thr = inp.throttle || 0, brk = inp.brake || 0, steer = inp.steerAxis || 0;
    // programmes: holdAt = {at: sample, s, kmh} (from where the car passes `at`: hold for s seconds); a hold that ends
    // resets our driver (it saw its car not moving: it must not go on with a reverse / R it planned meanwhile)
    var ha = B.holdAt;
    if (ha && !ha.on && !c.locked) {
      var Nh = g.track.samples.length, kh = ((st.sampleIndex - ha.at) % Nh + Nh) % Nh;
      if (kh < 8) { ha.on = gameS(); ha.v0 = st.speed; B.hold = { until: gameS() + ha.s, kmh: ha.kmh || 0 }; }
    }
    var h = B.hold;
    if (h && !(gameS() < h.until) && !h.over) { h.over = true; me.reset(); }
    // a slow / parked player (a harness programme): no faster than hold.kmh
    if (h && gameS() < h.until && !c.locked) {
      var v = st.speed, cap = h.kmh / 3.6;
      // (standing: no pedal at all - the brake held at a standstill engages reverse in js/car.js)
      // (steering as our driver steers while it rolls: it stops on its line, not straight on into the run-off)
      // (a car slowing to a stop with a problem: a firm 0.35 of the pedal, ~1 g at speed - not a brake test)
      if (cap < 0.5) { thr = 0; brk = v > 0.3 ? 0.35 : 0; if (v < 1) steer = 0; }
      else if (v > cap + 0.3) { thr = 0; brk = Math.min(1, 0.3 + (v - cap) * 0.15); }
      else if (v > cap - 0.5) thr = Math.min(thr, 0.25);
    }
    // a ram (a harness programme): B.ram = {id, closing (m/s over its speed), s (timeout)}: we drive straight at that bot
    // (pure pursuit of its position) until we touch it - what a careless human does to a computer car
    var rm = B.ram;
    if (rm && !rm.done && !c.locked && !rm.id) {
      // (id 0: the first bot that is 15..45 m ahead of us, moving, with a straight before both of us - no corner in the
      // next 300 m - until then we drive on)
      var Nr = g.track.samples.length, dsr = g.track.length / Nr, blr = g.bots || [], Pr = g.raceLine.points, straight = true;
      for (var mr = 0; mr * dsr < 300 && straight; mr += 2) { var cr = Pr[(st.sampleIndex + mr) % Nr].curvature || 0; if (cr > 0.004 || cr < -0.004) straight = false; }
      for (var qr = 0; straight && qr < blr.length && !rm.id; qr++) {
        var kr = ((blr[qr].car.state.sampleIndex - st.sampleIndex) % Nr + Nr) % Nr;
        if (kr * dsr > 15 && kr * dsr < 45 && blr[qr].car.state.speed > 10 && !blr[qr].pit.state.inLane) { rm.id = blr[qr].id; rm.name = blr[qr].name; rm.ahead = kr * dsr; rm.t0 = gameS(); }
      }
    }
    if (rm && !rm.done && !c.locked && rm.id) {
      var tb = null, bl = g.bots || [];
      for (var q = 0; q < bl.length; q++) if (bl[q].id === rm.id) tb = bl[q];
      if (!rm.t0) rm.t0 = gameS();
      if (!tb || gameS() - rm.t0 > (rm.s || 20)) rm.done = 'timeout';
      else {
        var ts = tb.car.state, dx = ts.x - st.x, dz = ts.z - st.z, d2 = dx * dx + dz * dz;
        var lat = dx * Math.cos(st.heading) - dz * Math.sin(st.heading), kap = d2 > 1e-6 ? 2 * lat / d2 : 0;
        steer = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / 0.35));
        var want = Math.max(0, ts.speed) + (rm.closing || 6);
        thr = st.speed < want ? 1 : 0; brk = st.speed > want + 2 ? 0.5 : 0;
        if (!rm.min || d2 < rm.min) rm.min = d2;
        for (var cq = B.contacts.length - 1; cq >= 0 && cq >= B.contacts.length - 4; cq--) {
          var ce = B.contacts[cq];
          if (ce.t >= rm.t0 && ((ce.self && ce.other && ce.other[0] === rm.id) || (ce.id === rm.id && ce.other && ce.other[0] === gp.selfId))) {
            rm.done = 'hit'; rm.at = gameS(); rm.vUs = st.speed; rm.vIt = ts.speed; break;
          }
        }
      }
      if (rm.done) me.reset();
    }
    // a brake test: at sample `at`, brake hard for `ms` of game time
    var bt = B.brakeTest;
    if (bt && !bt.done && !c.locked) {
      var N = g.track.samples.length, k = ((st.sampleIndex - bt.at) % N + N) % N;
      if (!bt.on && k < 6) { bt.on = gameS(); bt.v0 = st.speed; }
      if (bt.on) { thr = 0; brk = 1; if (gameS() - bt.on > (bt.s || 1.5) || st.speed < (bt.kmh || 40) / 3.6) { bt.done = gameS(); bt.v1 = st.speed; } }
    }
    pad.axes[0] = stick(steer); pad.axes[1] = 0;
    btn(7, trig(thr)); btn(6, trig(brk));
    btn(5, inp.boost && thr > 0.9 ? 1 : 0);
    // the limiter is a toggle (B): pressed when the driver wants it otherwise (a press swallowed by a long wall-clock gap
    // between two polls under the warp is simply repeated)
    if (!!inp.limiter !== !!g.limiter && B.frames - lastLimF > 12 && !pressLim) { btn(1, 1); pressLim = 2; lastLimF = B.frames; B.limiterPresses++; }
    // (not while a programme holds the car: a player parked on purpose does not press R)
    var holding = !!(B.hold && gameS() < B.hold.until);
    if (inp.reset && !holding && B.frames - lastYF > 60 && !pressY) { btn(3, 1); pressY = 2; lastYF = B.frames; B.resets++; }
  }
  function frame(dt) {
    try { drive(dt); record(dt); } catch (err) { if (!B.err) B.err = String(err && err.stack || err); rest(); }
  }
  B.frame = frame;
  if (E) {
    var orig = E.ap.step;
    E.ap.step = function () { if (B.on || B.recOn) { frame(E.dt); if (B.on) return; } return orig.apply(this, arguments); };
    B.start = function () { B.on = true; B.recOn = true; E.ap.on = true; return true; };
  } else {
    var lastT = 0;
    var realTimeStep = function () { var t = performance.now(), dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : STEP; lastT = t; frame(dt); };
    B.start = function () { B.on = true; B.recOn = true; return true; };
  }
  B.stopDriving = function () { B.on = false; rest(); return true; };

  /* ---------- recorders ---------- */
  // whose state is this (our car, one of our bots)? -> id, or 0 (somebody else's: the warm-up's cars)
  function idOf(st) {
    var g = F1.game;
    if (g.car && g.car.state === st) return F1.gp.selfId;
    var bots = g.bots || [];
    for (var i = 0; i < bots.length; i++) if (bots[i].car.state === st) return bots[i].id;
    return 0;
  }
  // the nearest other car (local or remote) to a state: [id, metres, height difference]
  function otherOf(st) {
    var g = F1.game, best = null, bd = 1e9;
    function look(id, o) { if (o === st) return; var d = Math.hypot(o.x - st.x, o.z - st.z); if (d < bd) { bd = d; best = [id, +d.toFixed(2), +((o.y || 0) - (st.y || 0)).toFixed(2)]; } }
    if (g.car) look(F1.gp.selfId, g.car.state);
    (g.bots || []).forEach(function (b) { look(b.id, b.car.state); });
    var P = F1.net && F1.net.connected ? F1.net.players : [];
    for (var i = 0; i < P.length; i++) if (P[i].active && P[i].state) look(P[i].id, P[i].state);
    return best;
  }
  if (typeof F1.resolveCarCollisions === 'function') {
    var resolve = F1.resolveCarCollisions;
    F1.resolveCarCollisions = function (st, list, dt, recs) {
      var h = resolve.apply(this, arguments);
      if (h > 0 && B.recOn) {
        var id = idOf(st);
        if (id) {
          var now = gameS(), o = B.hitsBy[id] || (B.hitsBy[id] = { last: -1e9, ev: null });
          if (now - o.last > 0.5 || !o.ev) {
            var g = F1.game, s0 = g.car.state;
            o.ev = { id: id, t: now, phase: F1.gp.phase, sinceGo: F1.gp.sinceGo, max: h, steps: 0, idx: st.sampleIndex,
              self: id === F1.gp.selfId, nearSelf: Math.hypot(s0.x - st.x, s0.z - st.z) < 8, v: st.speed, y: st.y, other: otherOf(st),
              paved: !!(g.track && g.track.pit && typeof g.track.pit.paved === 'function' && g.track.pit.paved(st.sampleIndex, st.d)) };
            B.contacts.push(o.ev);
          }
          o.last = now;
          o.ev.steps++;
          if (h > o.ev.max) o.ev.max = h;
        }
      }
      return h;
    };
    // (the module's helpers ride on the function - resolveCarCollisions.overlap is js/ai.js's boxClear: without it
    //  every computer car thinks the way past a stopped car is never clear, and crawls / gridlocks)
    for (var rk in resolve) if (Object.prototype.hasOwnProperty.call(resolve, rk)) F1.resolveCarCollisions[rk] = resolve[rk];
  }
  // per frame: the field's progress (stuck cars), the order (overtakes), the pit lane
  B.resetRec = function () {
    B.contacts.length = 0; B.hitsBy = {};
    B.rec = { orders: [], lastOrderT: -1e9, prog: {}, stuck: [], laneMax: 0, laneSamples: [], speeding: {}, maxLaneKmh: {}, stops: {},
      selfPlaces: [], minGap: {}, lapped: [], blue: {}, yieldsAt: {}, sinceT: gameS(), wrong: {}, jumps: {}, voids: {} };
    return true;
  };
  B.resetRec();
  function record(dt) {
    var g = F1.game, gp = F1.gp, R = B.rec;
    if (!B.recOn || !g || !g.track || !g.car) return;
    var now = gameS(), bots = g.bots || [], N = g.track.samples.length, i, b, st;
    var racing = gp.phase === 'race';
    // pit lane: how many of the local cars are in it now, top speed in it, speeding
    var inLane = 0, limit = g.track.pit ? g.track.pit.limitKmh : 0;
    for (i = 0; i < bots.length; i++) {
      b = bots[i]; st = b.car.state;
      var ps = b.pit.state;
      if (ps.inLane) {
        inLane++;
        var kmh = Math.abs(st.speed) * 3.6;
        if (!(R.maxLaneKmh[b.id] >= kmh)) R.maxLaneKmh[b.id] = kmh;
        if (ps.speeding) R.speeding[b.id] = (R.speeding[b.id] || 0) + 1;
      }
      R.stops[b.id] = ps.stops;
      // stuck: racing (or free practice), not in its box, not finished, the race distance not moving
      var e = gp.entry(b.id, B.entry2 || (B.entry2 = {}));
      // (a bot told to park in its box - the harness's lapped car - is not stuck)
      var active = ((racing && e.taking && !e.fin && !e.dnf) || gp.phase === 'free') && b.ai.state.mode !== 'parked';
      var p = R.prog[b.id] || (R.prog[b.id] = { idx: st.sampleIndex, t: now, U: 0, mark: 0, worst: 0, worstAt: -1 });
      var dI = ((st.sampleIndex - p.idx) % N + N) % N; if (dI > N / 2) dI -= N;
      p.U += dI; p.idx = st.sampleIndex;
      // the car's sample jumping (another road at a crossing, an R) and its lap counter's void laps
      if (dI > 40 || dI < -40) (R.jumps[b.id] = R.jumps[b.id] || []).push([st.sampleIndex - dI, st.sampleIndex, gp.phase, +(st.y || 0).toFixed(1)]);
      if (b.lap && b.lap.void) R.voids[b.id] = (R.voids[b.id] || 0) + 1;
      // progress = 3 samples (~6 m) on since the last mark; not taking part / in its box / on the grid is not being stuck
      if (!active || ps.service || b.ctx.locked || p.U - p.mark >= 3 || p.U - p.mark < -40) { p.t = now; p.mark = p.U; }
      var still = now - p.t;
      if (still > p.worst) { p.worst = still; p.worstAt = st.sampleIndex; p.worstPhase = gp.phase; p.worstMode = b.ai.state.mode; }
      if (still > 15 && !p.flagged) { p.flagged = true; R.stuck.push({ id: b.id, name: b.name, t: now, idx: st.sampleIndex, phase: gp.phase, mode: b.ai.state.mode, v: st.speed, d: st.d }); }
      if (still < 1) p.flagged = false;
      if (b.ai.state.mode === 'yield') { R.blue[b.id] = (R.blue[b.id] || 0) + 1; }
      // facing the wrong way at speed (a spun car)
      var s = g.track.samples[st.sampleIndex];
      if (s && Math.abs(st.speed) > 3) {
        var hd = st.heading - Math.atan2(s.tx, s.tz); hd = Math.atan2(Math.sin(hd), Math.cos(hd));
        if (Math.abs(hd) > 1.8) R.wrong[b.id] = (R.wrong[b.id] || 0) + 1;
      }
    }
    if (g.pit && g.pit.state.inLane) inLane++;
    if (inLane > R.laneMax) R.laneMax = inLane;
    // the order every 0.5 s of game time in the race (the session's live standings)
    if (racing && now - R.lastOrderT >= 0.5) {
      R.lastOrderT = now;
      var rows = gp.view().rows, ord = [];
      for (i = 0; i < rows.length; i++) ord.push(rows[i].id);
      R.orders.push({ t: now, sinceGo: gp.sinceGo, ord: ord });
      if (R.orders.length > 4000) R.orders.splice(0, 1000);
    }
  }
  // overtakes between consecutive standings samples: pairs (a, b) with a ahead of b before and behind after
  B.overtakes = function (fromT) {
    var O = B.rec.orders, n = 0, bySelf = 0, onSelf = 0, sid = F1.gp.selfId, i, j, k;
    for (k = 1; k < O.length; k++) {
      if (O[k].t < (fromT || 0)) continue;
      var a = O[k - 1].ord, b = O[k].ord, pa = {}, pb = {};
      for (i = 0; i < a.length; i++) pa[a[i]] = i;
      for (i = 0; i < b.length; i++) pb[b[i]] = i;
      for (i = 0; i < b.length; i++) for (j = i + 1; j < b.length; j++) {
        var x = b[i], y = b[j];                       // x ahead of y now
        if (pa[x] !== undefined && pa[y] !== undefined && pa[x] > pa[y]) { n++; if (x === sid) bySelf++; if (y === sid) onSelf++; }
      }
    }
    return { total: n, bySelf: bySelf, onSelf: onSelf, samples: O.length };
  };
  // the field now (for the harness): ids, names, skills, places, laps, stops, ai stats
  B.field = function () {
    var g = F1.game, out = [];
    (g.bots || []).forEach(function (b) {
      var st = b.car.state, a = b.ai.stats, p = B.rec.prog[b.id] || {};
      out.push({ id: b.id, name: b.name, car: b.spec.id, skill: b.skill, level: F1.AI.levelOf(b.skill).id, slot: b.slot, x: st.x, z: st.z, v: st.speed, i: st.sampleIndex, d: st.d,
        mode: b.ai.state.mode, pace: b.ai.pace, stops: b.pit.state.stops, compound: b.car.tyres ? b.car.tyres.state.compound : null,
        wear: b.car.tyres ? Math.max.apply(null, b.car.tyres.state.wear) : null, puncture: b.car.tyres ? b.car.tyres.state.puncture : null,
        stats: { offs: a.offs, wallHits: a.wallHits, resets: a.resets, reverses: a.reverses, stuck: a.stuck, passes: a.passes, passTries: a.passTries,
          defends: a.defends, yields: a.yields, concedes: a.concedes, pitStops: a.pitStops, mistakes: a.mistakes },
        worstStill: p.worst || 0, worstAt: p.worstAt, worstPhase: p.worstPhase, worstMode: p.worstMode,
        log: b.ai.log.slice(-6) });
    });
    return out;
  };
  // a diagnostic: every think() of one bot for s seconds of game time -> B.watchLog [t, mode, tgt, obs, capBy, cap,
  // targetSpeed, speed, d, heading against the road, throttle, brake, steer, gap to car tgt]
  B.watch = function (id, s) {
    var b = (F1.game.bots || []).filter(function (x) { return x.id === id; })[0];
    if (!b) return false;
    var th = b.ai.think, until = gameS() + s;
    B.watchLog = [];
    b.ai.think = function (dt, others, ctx) {
      var r = th.call(this, dt, others, ctx), st = b.car.state, S = F1.game.track.samples[st.sampleIndex], i = b.ai.state, t = gameS();
      if (t > until) { b.ai.think = th; return r; }
      var hd = st.heading - Math.atan2(S.tx, S.tz); hd = Math.atan2(Math.sin(hd), Math.cos(hd));
      if (B.watchLog.length < 4000) B.watchLog.push([+t.toFixed(3), i.mode, i.tgt, i.obs, i.capBy, i.cap, +(i.targetSpeed || 0).toFixed(2), +st.speed.toFixed(2), +st.d.toFixed(2), +hd.toFixed(3),
        +r.throttle.toFixed(2), +r.brake.toFixed(2), +r.steerAxis.toFixed(2), i.dbg ? JSON.stringify(i.dbg) : '']);
      return r;
    };
    return true;
  };
  B.contactSummary = function (filter) {
    var L = B.contacts.filter(filter || function () { return true; }), max = 0, heavy = 0, selfN = 0, selfMax = 0;
    L.forEach(function (c) { if (c.max > max) max = c.max; if (c.max > 0.25) heavy++; if (c.self) { selfN++; if (c.max > selfMax) selfMax = c.max; } });
    return { n: L.length, max: +max.toFixed(3), heavy: heavy, self: selfN, selfMax: +selfMax.toFixed(3) };
  };
  return 'ok';
})();
