// Autopilot for the end-to-end harnesses: follows the game's racing line (F1.buildRaceLine(track).points) with the
// REAL car, producing controller values (analog steer / throttle / brake + the reset button), nothing else.
// Pure logic: no DOM, no THREE. Loaded two ways from this one file:
//   node   require('./autopilot')            -> createAutopilot   (devtests/gp-e2e/ap-sim.js: the real js/car.js, warp speed)
//   page   the source is injected as text    -> window.createAutopilot   (devtests/gp-e2e/online.js feeds a fake gamepad)
// The control law is the pure pursuit of devtests/raceline-test/test.js (look-ahead 5 + 0.3 v m, clamped 7..35;
// steering = atan(curvature * wheelbase) / lock at that speed), with a speed controller of its own so the pace can be
// scaled: target speed = scale * points[i].speed, followed by feed-forward (the slope of that profile) + feedback.
//
//   var ap = createAutopilot();
//   ap.cfg = { mode, scale, thrCap, vCap, holdUntil, park, ramId, ramSpeed, acc }     (change any time)
//     mode 'idle'  pad at rest
//          'line'  follow the racing line at cfg.scale; with cfg.park = {index, d}: leave the line, stop at that sample
//                  at lateral offset d and stay there until cfg.park is cleared
//          'stop'  brake to a halt on the path and stay
//          'ram'   drive at the car of player cfg.ramId at cfg.ramSpeed m/s (the deliberate nudge)
//     thrCap 0..1 caps the throttle, vCap caps the speed (m/s), holdUntil: pad at rest until env.t reaches it (s)
//     acc: keep a gap to a solid car ahead on our path, pass a parked one on the side with room
//   ap.step(env) -> { steer (-1..1, +1 = left), throttle 0..1, brake 0..1, reset (bool: press the reset button) }
//     env = { t (s), st (car.state), track, line (raceline), locked (input locked: grid), others: [{id, x, z, heading, speed, solid}] }
//   ap.stats: what happened (frames on the grass, wall / car impacts (carAt: when), frames held back by a car ahead
//     (accSteps) / going round a parked one (avoidSteps), steps of a firm pedal to stand still on a slope (holds),
//     reverses, resets, largest distance from the path, ...)
// Recovery: the pursuit steers back from anywhere inside the walls (slowly while off the road or far off the path);
// nose against a wall / no progress -> reverse a little and try again; three failed attempts or facing the wrong way
// -> the game's reset button (R / controller A: back onto the centreline, standing, timing keeps running).
(function (root) {
  'use strict';

  // js/car.js (flat road): what the pedals give, to turn a wanted acceleration into a pedal position
  var TRACTION = 11, DRAG_K = 0.0012, ROLL = 0.5, TOP = 330 / 3.6;
  var POWER = (DRAG_K * TOP * TOP + ROLL) * TOP;
  var BRAKE_BASE = 12, BRAKE_AERO = 0.0032;
  var STEER_LOCK = 0.35, STEER_REF = 22, WHEELBASE = 3.6;

  var KP = 2.2;                // 1/s: speed error -> acceleration
  var LATENCY = 0.07;          // s: the profile is read this far ahead (one controller period + pedal lag)
  var EDGE = 1.3;              // m kept between the car's centre and the white line when we leave the racing line
  var CAR_LEN = 5.4, CAR_WID = 1.9;
  var PASS_GAP = 3.3;          // m between centres when passing a parked car
  var SIDE_RATE = 2.5;         // m/s: how fast the path moves sideways

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

  function createAutopilot() {
    var out = { steer: 0, throttle: 0, brake: 0, reset: false };
    var stats;
    var blend = 0, absD = 0;                 // path offset: d(i) = line d * (1 - blend) + absD * blend
    var lastT = null, stuckT = 0, wrongT = 0, rev = null, revN = 0, revAt = -1e9, resetAt = -1e9;
    var progIdx = -1, progT = 0, hitOn = false, hints = {};
    var parkedAt = null;
    var lastMode = '';

    function freshStats() {
      return { steps: 0, grass: 0, wall: 0, wallMax: 0, car: 0, carMax: 0, carAt: [], resets: 0, reverses: 0, maxDev: 0, accSteps: 0, avoidSteps: 0,
        holds: 0, parked: false, events: [] };
    }
    stats = freshStats();

    function note(t, what) { if (stats.events.length < 60) stats.events.push([Math.round(t * 10) / 10, what]); }

    function step(env) {
      var cfg = ap.cfg, st = env.st, track = env.track, P = env.line.points, S = track.samples, N = S.length, ds = track.length / N;
      var t = env.t, dt = lastT === null ? 0 : clamp(t - lastT, 0, 0.25);
      lastT = t;
      out.steer = out.throttle = out.brake = 0; out.reset = false;
      var v = st.speed, av = Math.abs(v), idx = ((st.sampleIndex | 0) % N + N) % N, s0 = S[idx];
      var others = env.others || [], i, o;
      stats.steps++;
      if (cfg.mode !== lastMode) { lastMode = cfg.mode; stuckT = 0; rev = null; progIdx = idx; progT = t; }
      if (parkedAt !== null && !(cfg.mode === 'line' && cfg.park)) { parkedAt = null; stats.parked = false; note(t, 'left the parking place'); }

      // ---- what the game did to the car since the last step
      if (st.onGrass) stats.grass++;
      if (st.hit > 0.005) {
        var nearCar = false;
        for (i = 0; i < others.length; i++) {
          o = others[i];
          if (o.solid && (o.x - st.x) * (o.x - st.x) + (o.z - st.z) * (o.z - st.z) < 64) nearCar = true;
        }
        if (nearCar) { if (!hitOn) { stats.car++; stats.carAt.push(Math.round(t * 100) / 100); } if (st.hit > stats.carMax) stats.carMax = st.hit; }
        else { if (!hitOn) { stats.wall++; note(t, 'wall ' + st.hit.toFixed(2) + ' @' + idx); } if (st.hit > stats.wallMax) stats.wallMax = st.hit; }
        hitOn = true;
      } else hitOn = false;

      if (cfg.mode === 'idle' || t < (cfg.holdUntil || 0)) { stuckT = 0; progIdx = idx; progT = t; return out; }

      // ---- ram: straight at the other car
      if (cfg.mode === 'ram') {
        o = null;
        for (i = 0; i < others.length; i++) if (others[i].id === cfg.ramId) o = others[i];
        if (!o) return out;
        out.steer = pursue(st, o.x, o.z, av);
        var rs = cfg.ramSpeed || 12;
        if (v < rs) out.throttle = clamp((rs - v) * 0.6, 0.15, 1); else if (v > rs + 2) out.brake = 0.4;
        return out;
      }

      // ---- the path: the racing line, or a line moved sideways (parking, passing a parked car)
      var hw = (s0.halfW || track.halfWidth), sideLim = hw - EDGE;
      var wantBlend = 0, vLim = Infinity, accLim = Infinity, parking = false, holding = false;
      if (cfg.mode === 'line' && cfg.park) {
        var gap = ((cfg.park.index - idx) % N + N) % N, dist = gap * ds;
        if (parkedAt !== null || dist < 160 || gap > N - 12) {
          parking = true;
          absD = cfg.park.d; wantBlend = 1;
          if (parkedAt !== null || dist < 2.5 || gap > N - 12) { holding = true; if (parkedAt === null && av < 0.3) { parkedAt = idx; stats.parked = true; note(t, 'parked @' + idx + ' d ' + st.d.toFixed(1)); } }
          else vLim = Math.sqrt(2 * 3.5 * Math.max(0, dist - 2)) + 1.5;
        }
      }
      if (cfg.mode === 'stop') holding = true;

      // solid cars ahead on our path: keep a gap to a moving one, pass a parked one where there is room
      if (cfg.acc !== false && !holding) {
        for (i = 0; i < others.length; i++) {
          o = others[i];
          if (!o.solid) continue;
          var hint = hints[o.id], loc = track.locate(o.x, o.z, hint == null ? -1 : hint);
          var so = S[loc.index];
          if ((o.x - so.x) * (o.x - so.x) + (o.z - so.z) * (o.z - so.z) > 400) loc = track.locate(o.x, o.z, -1);
          hints[o.id] = loc.index;
          var ahead = ((loc.index - idx) % N + N) % N, gm = ahead * ds;
          if (ahead === 0) {                                  // same sample: by the along-track offset
            gm = (o.x - st.x) * s0.tx + (o.z - st.z) * s0.tz;
            if (gm < 0) continue;
          }
          if (gm > Math.max(50, av * 3.5) || ahead > N / 2) continue;
          var myD = pathD(loc.index), side = loc.d - myD;
          // where we really are counts too while we are not on the path yet
          var mySide = loc.d - st.d, near = Math.min(Math.abs(side), gm < 25 ? Math.abs(mySide) : 1e9);
          if (near > CAR_WID + 0.9) continue;                 // it is not in our way
          var ov = Math.max(0, o.speed || 0);
          if (ov < 2.5 && !parking) {
            // parked: go round it on the side with more room
            var hwo = (so.halfW || track.halfWidth) - EDGE;
            var left = loc.d + PASS_GAP, right = loc.d - PASS_GAP, pick = null;
            if (left <= hwo && (right < -hwo || P[loc.index].d >= loc.d)) pick = left;
            else if (right >= -hwo) pick = right;
            else if (left <= hwo) pick = left;
            if (pick !== null) {
              absD = pick; wantBlend = 1; stats.avoidSteps++;
              // not across yet: slow enough to be across before we get there
              if (Math.abs(st.d - pick) > 1.2) vLim = Math.min(vLim, Math.max(6, (gm - CAR_LEN - 4) / Math.max(0.6, Math.abs(st.d - pick) / SIDE_RATE)));
              continue;
            }
          }
          // follow: time gap 0.5 s + 4 m behind its tail
          var want = CAR_LEN + 4 + 0.5 * av, lim = Math.max(0, ov + 0.8 * (gm - want));
          if (lim < vLim) { vLim = lim; accLim = lim; }
        }
      }
      if (parking || wantBlend > 0) {
        var span = Math.abs(absD - P[idx].d), rate = span > 0.5 ? Math.min(1.5, SIDE_RATE / span) : 1.5;
        blend = Math.min(1, blend + rate * dt);
      } else if (blend > 0) {
        var span2 = Math.abs(absD - P[idx].d);
        blend = Math.max(0, blend - (span2 > 0.5 ? Math.min(1.5, SIDE_RATE / span2) : 1.5) * dt);
      }
      function pathD(k) {
        var d = P[k].d;
        if (blend > 0) { var lim2 = (S[k].halfW || track.halfWidth) - EDGE; d = d * (1 - blend) + clamp(absD, -lim2, lim2) * blend; }
        return d;
      }
      function pathX(k) { return S[k].x + S[k].nx * pathD(k); }
      function pathZ(k) { return S[k].z + S[k].nz * pathD(k); }

      // ---- steering: pure pursuit of a point L metres on
      var L = clamp(5 + 0.3 * av, 7, 35), k = (idx + Math.round(L / ds)) % N;
      out.steer = pursue(st, pathX(k), pathZ(k), av);
      var dev = Math.abs(st.d - pathD(idx));
      if (dev > stats.maxDev && blend === 0 && !rev) stats.maxDev = dev;
      var head = wrapPi(st.heading - Math.atan2(s0.tx, s0.tz));       // against the road's direction

      // ---- recovery
      if (rev) {                                                     // backing away from whatever stopped us
        if (t < rev.until) { out.steer = -rev.steer; out.brake = v > 0.5 ? 0 : 1; out.throttle = 0; return out; }
        rev = null; stuckT = 0;
      }
      if (Math.abs(head) > 2.0 && !env.locked) wrongT += dt; else wrongT = 0;
      if (wrongT > 0.6) {                                            // facing the wrong way: stop, then the reset button
        if (av > 1) { out.brake = v > 0 ? 1 : 0; out.throttle = v < 0 ? 1 : 0; return out; }
        return pressReset(t, 'wrong way @' + idx);
      }

      if (holding) {                                                 // stand still (the brake alone would reverse the car)
        if (v > 0.6) out.brake = v > 2 ? 1 : 0.4;
        else if (v < -0.6) out.throttle = 0.4;
        // js/car.js holds a car only below 0.3 m/s with no pedal pressed: in between, a car on a slope (Monaco falls
        // 7.4 % from the line towards Mirabeau) would creep on, so a firm half pedal against the roll
        else if (v >= 0.3) { out.brake = 0.5; stats.holds++; }
        else if (v <= -0.3) { out.throttle = 0.5; stats.holds++; }
        stuckT = 0; progIdx = idx; progT = t;
        return out;
      }

      // ---- speed: scale * the line's target speed, feed-forward + feedback
      var scale = cfg.scale > 0 ? cfg.scale : 1;
      var la = Math.round(av * LATENCY / ds), a = (idx + la) % N, b = (a + 2) % N;
      var vt = scale * P[a].speed, vb = scale * P[b].speed;
      var aff = (vb * vb - vt * vt) / (4 * ds);
      // never above what the profile allows anywhere within braking reach
      var reach = Math.min(N >> 2, Math.ceil((av * av / 20 + 10) / ds)), need = 0, m, vk;
      for (m = 3; m <= reach; m += 2) {
        vk = scale * P[(idx + m) % N].speed;
        if (av > vk) { var nd = (av * av - vk * vk) / (2 * m * ds); if (nd > need) need = nd; }
      }
      var slow = 1;
      if (st.onGrass) slow = 0.5;
      else if (dev > 2.5 && blend === 0) slow = 0.75;                  // far off the path: get back first
      if (Math.abs(head) > 0.7) vLim = Math.min(vLim, 10);
      if (blend > 0 && blend < 1 || (blend === 1 && Math.abs(absD - P[idx].d) > 1)) slow = Math.min(slow, 0.8);   // off the ideal line: margin
      var target = Math.min(vt * slow, cfg.vCap > 0 ? cfg.vCap : Infinity, vLim);
      if (target === accLim) stats.accSteps++;                          // the car ahead is what holds us back
      var acc = (target < vt ? 0 : aff) + KP * (target - v);
      if (need > 0 && -need < acc && target >= vt * slow) acc = Math.min(acc, -need + KP * (vt - v) * 0.5);
      var resist = ROLL + DRAG_K * av * av;
      if (v < 0.5 && target > 0.5) { out.throttle = 1; }               // pulling away
      else if (acc > -resist) out.throttle = clamp((acc + resist) / Math.min(TRACTION, POWER / Math.max(av, 1)), 0, 1);
      else if (v > 0.6) out.brake = clamp((-acc - resist) / (BRAKE_BASE + BRAKE_AERO * av * av), 0, 1);
      if (out.throttle > (cfg.thrCap >= 0 ? cfg.thrCap : 1)) out.throttle = cfg.thrCap;

      // ---- stuck?
      if (env.locked) { stuckT = 0; progIdx = idx; progT = t; return out; }
      if (out.throttle > 0.3 && av < 0.8) stuckT += dt; else stuckT = 0;
      var moved = ((idx - progIdx) % N + N) % N;
      if (moved >= 5 && moved < N / 2) { progIdx = idx; progT = t; }
      if (target < 1) progT = t;                                     // waiting behind a car: that is not being stuck
      if (stuckT > 1.2 || t - progT > 8) {
        if (t - revAt > 15) revN = 0;
        if (revN >= 3) { revN = 0; return pressReset(t, 'stuck @' + idx); }
        revN++; revAt = t; stats.reverses++;
        rev = { until: t + 1.4, steer: out.steer };
        note(t, 'reverse @' + idx + ' d ' + st.d.toFixed(1));
        stuckT = 0; progIdx = idx; progT = t;
        out.throttle = 0; out.brake = 1;
      }
      return out;
    }

    function pursue(st, x, z, av) {
      var dx = x - st.x, dz = z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
      var lat = dx * ch - dz * sh, d2 = dx * dx + dz * dz;
      if (d2 < 1e-6) return 0;
      var lock = STEER_LOCK / (1 + (av / STEER_REF) * (av / STEER_REF));
      return clamp(Math.atan(2 * lat / d2 * WHEELBASE) / lock, -1, 1);
    }

    function pressReset(t, why) {
      out.steer = out.throttle = out.brake = 0;
      if (t - resetAt > 1) { resetAt = t; out.reset = true; stats.resets++; note(t, 'RESET: ' + why); blend = 0; wrongT = 0; stuckT = 0; rev = null; progT = t; }
      return out;
    }

    var ap = {
      cfg: { mode: 'idle', scale: 1, thrCap: 1, vCap: 0, holdUntil: 0, park: null, ramId: 0, ramSpeed: 12, acc: true },
      step: step,
      get stats() { return stats; },
      get blend() { return blend; },
      get parked() { return parkedAt !== null; },
      resetStats: function () { var s = stats; stats = freshStats(); stats.parked = s.parked; return s; }
    };
    return ap;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createAutopilot;
  else root.createAutopilot = createAutopilot;
})(typeof window !== 'undefined' ? window : globalThis);
