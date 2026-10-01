// Lives in the PAGE (injected by devtests/v62-critic/critic.js after gp-e2e/solo-page.js and v6-smoke/page.js):
// window.__q = a PLAYER for the v6.2 critic. It drives the car through the game's own input paths only:
//   keys  synthetic KeyboardEvents (by e.code: KeyW / KeyS / KeyA / KeyD) dispatched on window, i.e. js/main.js's own
//         onKeyDown / onKeyUp -> input.up / down / left / right -> car.update (the ramped keyboard steering of js/car.js).
//         The steering is "tapped" like a keyboard player does it: the key is held while the car's steer is short of
//         what the corner needs, released when it has it (the steering then centres at js/car.js's rate).
//   pad   the fake standard controller of gp-e2e/solo-page.js (stick + triggers -> js/gamepad.js).
// The aim (pure pursuit) is the racing line or the centreline at an offset, with the car's OWN steering law
// (car.perf.steerLockAt: v6.2), the speed held at a target with throttle / brake. It runs inside the time warp (the
// solo-page pump): __e.ap.step is wrapped, so the line autopilot drives whenever __q is not.
// Records (window.__q.d.rec): speed range, steer, wall impacts (state.hit), grass, the clearance to the walls, the car's
// pitch / roll and the camera's (world) pitch / roll, the tunnel light / sound values, sample jumps.
(function () {
  'use strict';
  if (window.__q) return 'already';
  var E = window.__e, F1 = window.F1, Q = window.__q = { d: null };
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------- keyboard: main.js's own key handlers ---------- */
  var keys = {};
  Q.keyEvents = 0;
  function key(code, on) {
    on = !!on;
    if (!!keys[code] === on) return;
    keys[code] = on;
    Q.keyEvents++;
    window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code: code, key: code, bubbles: true, cancelable: true }));
  }
  Q.key = function (code, on) { key(code, on); return true; };
  Q.releaseKeys = function () { for (var k in keys) if (keys[k]) key(k, false); return true; };

  /* ---------- the controller: present (solo-page's fake pad) or unplugged (keyboard players) ---------- */
  var padDesc = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
  Q.unplug = function () {
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return [null, null, null, null]; } });
    return true;
  };
  Q.plug = function () { if (padDesc) Object.defineProperty(navigator, 'getGamepads', padDesc); return true; };
  function btn(i, v) { var x = E.pad.buttons[i]; x.value = v; x.pressed = v > 0.5; }
  function setPad(thr, brk, steer) {      // (solo-page's setPad: its deadzones / expo inverted)
    btn(7, thr > 0 ? (thr >= 1 ? 1 : 0.04 + 0.96 * thr) : 0);
    btn(6, brk > 0 ? (brk >= 1 ? 1 : 0.04 + 0.96 * brk) : 0);
    E.pad.axes[0] = steer === 0 ? 0 : -(steer > 0 ? 1 : -1) * (0.12 + 0.88 * Math.pow(Math.min(1, Math.abs(steer)), 1 / 1.6));
    E.pad.axes[1] = 0;
  }
  Q.padNeutral = function () { setPad(0, 0, 0); for (var i = 0; i < 17; i++) btn(i, 0); return true; };

  /* ---------- camera pose in the world ---------- */
  var V3 = null, V4 = null;
  function camPose() {
    var cam = F1.game.camera;
    if (!V3) { V3 = new THREE.Vector3(); V4 = new THREE.Vector3(); }
    cam.updateWorldMatrix(true, false);
    cam.getWorldDirection(V3);
    var e = cam.matrixWorld.elements;      // the camera's up axis (column 1) against the world's
    V4.set(e[4], e[5], e[6]).normalize();
    // roll: the up axis' sideways lean, measured across the view direction
    var sx = V3.z, sz = -V3.x, sl = Math.hypot(sx, sz) || 1;          // horizontal "right-ish" axis
    var roll = Math.asin(clamp((V4.x * sx + V4.z * sz) / sl, -1, 1));
    return { pitch: Math.asin(clamp(V3.y, -1, 1)), roll: roll };
  }
  Q.cam = function () { var p = camPose(); return { pitchDeg: p.pitch * 180 / Math.PI, rollDeg: p.roll * 180 / Math.PI }; };

  /* ---------- the player ---------- */
  // o = { input: 'keys' | 'pad', path: 'line' | 'centre', off: m (centre: offset, + left), vKmh: speed to hold,
  //       hold: [from, to] sample range where vKmh is held (before it: the line's own advice is followed, braking for vKmh
  //       in time), free: after `to` full throttle on the line advice, stopAt: sample index (unwrapped distance in samples
  //       from the start: stopU) where the player hands back (ap 'stop' or 'line'), then: 'stop' | 'line',
  //       rec: [from, to] the samples to record in (default hold) }
  Q.drive = function (o) {
    var g = F1.game, st = g.car.state, N = g.track.samples.length;
    Q.padNeutral(); Q.releaseKeys();
    Q.d = { o: o, U: 0, idx: st.sampleIndex, start: st.sampleIndex, done: false, N: N,
      rec: { frames: 0, recFrames: 0, vmin: 1e9, vmax: 0, vAtMin: null, steerMax: 0, hits: 0, maxHit: 0, grass: 0, wallMin: 99, edgeMax: -99,
        jumps: 0, maxJump: 0, ymin: 1e9, ymax: -1e9, carPitchMax: 0, carRollMax: 0, camPitchMax: 0, camRollMax: 0, steerSum: 0,
        tunnelMax: 0, hemiMin: 9, sunMin: 9, reverbOn: false, wetMax: 0, keyPresses0: Q.keyEvents, path: [] } };
    E.ap.on = true;
    return true;
  };
  function inRange(i, a, b, N) { var k = ((i - a) % N + N) % N; return k <= ((b - a) % N + N) % N; }
  function step() {
    var D = Q.d, o = D.o, g = F1.game, car = g.car, st = car.state, tr = g.track, S = tr.samples, N = S.length, ds = tr.length / N;
    var P = g.raceLine ? g.raceLine.points : null, R = D.rec, v = Math.max(0, st.speed), i = st.sampleIndex;
    var di = i - D.idx; if (di > N / 2) di -= N; if (di < -N / 2) di += N;
    if (Math.abs(di) > 6) { R.jumps++; if (Math.abs(di) > R.maxJump) R.maxJump = Math.abs(di); }
    D.U += di; D.idx = i;
    R.frames++;
    if (st.hit > 0) { R.hits++; if (st.hit > R.maxHit) R.maxHit = st.hit; }
    if (st.onGrass) R.grass++;
    var rr = o.rec || o.hold;
    if (!rr || inRange(i, rr[0], rr[1], N)) {
      var s0 = S[i];
      R.recFrames++;
      if (v < R.vmin) { R.vmin = v; R.vAtMin = { i: i, d: st.d, steer: st.steer }; }
      if (v > R.vmax) R.vmax = v;
      R.steerMax = Math.max(R.steerMax, Math.abs(st.steer)); R.steerSum += Math.abs(st.steer);
      var wall = Math.min(s0.wallPosDist - st.d, s0.wallNegDist + st.d);
      if (wall < R.wallMin) R.wallMin = wall;
      R.edgeMax = Math.max(R.edgeMax, Math.abs(st.d) - (s0.halfW || 7));
      R.ymin = Math.min(R.ymin, st.y); R.ymax = Math.max(R.ymax, st.y);
      R.carPitchMax = Math.max(R.carPitchMax, Math.abs(st.pitch)); R.carRollMax = Math.max(R.carRollMax, Math.abs(st.roll));
      var cp = camPose();
      R.camPitchMax = Math.max(R.camPitchMax, Math.abs(cp.pitch)); R.camRollMax = Math.max(R.camRollMax, Math.abs(cp.roll));
      var tn = g.tunnels, L = g.lights, ad = F1.audio && F1.audio.debug;
      if (tn) R.tunnelMax = Math.max(R.tunnelMax, tn.inTunnel(i));
      if (L && L.hemi) { R.hemiMin = Math.min(R.hemiMin, L.hemi.intensity / L.hemi0); R.sunMin = Math.min(R.sunMin, L.sun.intensity / L.sun0); }
      if (ad) { if (ad.reverb) R.reverbOn = true; if (ad.tunnel > R.wetMax) R.wetMax = ad.tunnel; }
      if ((R.recFrames & 3) === 0 && R.path.length < 400) R.path.push([i, +(v * 3.6).toFixed(1), +st.d.toFixed(2), +st.steer.toFixed(2), +st.y.toFixed(2)]);
    }
    if (o.stopU !== undefined && D.U >= o.stopU) {
      D.done = true; Q.releaseKeys(); Q.padNeutral();
      E.ap.mode = o.then || 'stop';
      return;
    }
    // the aim: pure pursuit, the car's own steering law
    var la = clamp(4 + 0.3 * v, 6, 18), j = (i + Math.round(la / ds)) % N, tx, tz;
    if (o.path === 'line' && P) { tx = P[j].x; tz = P[j].z; }
    else { var sj = S[j], off = o.off || 0; tx = sj.x + sj.nx * off; tz = sj.z + sj.nz * off; }
    var dx = tx - st.x, dz = tz - st.z, lat = dx * Math.cos(st.heading) - dz * Math.sin(st.heading), d2 = dx * dx + dz * dz;
    var kap = d2 > 1e-6 ? 2 * lat / d2 : 0, perf = car.perf || F1.CAR_PERF;
    var lock = typeof perf.steerLockAt === 'function' ? perf.steerLockAt(v, S[i].bank || 0, kap >= 0 ? 1 : -1) : perf.steerLock / (1 + (v / perf.steerSpeedRef) * (v / perf.steerSpeedRef));
    var want = clamp(Math.atan(kap * perf.wheelbase) / lock, -1, 1);
    // the speed: the line's advice outside `hold`, vKmh inside it (braking for it in time), full throttle after it
    var thr = 0, brk = 0, inHold = o.hold && inRange(i, o.hold[0], o.hold[1], N);
    var toHold = o.hold ? ((o.hold[0] - i) % N + N) % N * ds : 1e9;
    var vt = o.vKmh / 3.6;
    if (inHold) { if (v < vt - 0.4) thr = 1; else if (v > vt + 1.0) brk = 1; }
    else {
      if (P) {
        g.raceLine.update({ sampleIndex: i, speed: st.speed });
        var lv = g.raceLine.levels[2];
        thr = lv < 0.45 || v < 5 ? 1 : 0; brk = lv >= 0.6 && v >= 5 ? 1 : 0;
      } else thr = 1;
      if (o.hold && toHold < 400) {                // braking in time for vKmh at the start of hold
        var allow = Math.sqrt(vt * vt + 2 * 9 * Math.max(0, toHold - 8));
        if (v > allow) { brk = 1; thr = 0; } else if (v > allow - 1) thr = 0;
      }
    }
    if (o.input === 'keys') {
      key('KeyW', thr > 0); key('KeyS', brk > 0);
      var s = st.steer;
      if (want > 0.04) { key('KeyD', false); key('KeyA', s < want); }
      else if (want < -0.04) { key('KeyA', false); key('KeyD', s > want); }
      else { key('KeyA', false); key('KeyD', false); }
    } else setPad(thr, brk, want);
  }
  if (E && E.ap) {                          // (a window without the time warp: the menu / camera helpers only)
    var apStep = E.ap.step;
    E.ap.step = function () {
      if (Q.d && !Q.d.done) return step();
      return apStep.apply(this, arguments);
    };
  }
  // the car put somewhere along the track (a practice restart from a chosen spot), standing or rolling at vKmh
  Q.place = function (i, vKmh, d) {
    var g = F1.game, car = g.car, tr = g.track;
    car.reset(tr, i);
    if (d) { var s = tr.samples[i]; car.state.x += s.nx * d; car.state.z += s.nz * d; car.update(1e-4, null, tr); }
    // vKmh 'line': the racing line's own speed there
    car.state.speed = vKmh === 'line' && g.raceLine ? g.raceLine.points[car.state.sampleIndex].speed : (vKmh || 0) / 3.6;
    if (E.truth) { E.truth.idx = car.state.sampleIndex; }
    if (g.lap && g.lap.sync) g.lap.sync(car.state.sampleIndex);   // (as main.js does after its own placements: no "jump")
    return car.state.sampleIndex;
  };
  Q.now = function () {
    var g = F1.game, st = g.car.state, cp = camPose(), tn = g.tunnels, L = g.lights, ad = F1.audio && F1.audio.debug, i = st.sampleIndex;
    return { i: i, kmh: +(st.speed * 3.6).toFixed(1), d: +st.d.toFixed(2), y: +st.y.toFixed(2), steer: +st.steer.toFixed(3),
      carPitchDeg: +(st.pitch * 180 / Math.PI).toFixed(2), carRollDeg: +(st.roll * 180 / Math.PI).toFixed(2),
      camPitchDeg: +(cp.pitch * 180 / Math.PI).toFixed(2), camRollDeg: +(cp.roll * 180 / Math.PI).toFixed(2),
      fov: g.camera.fov, load: st.load, compress: st.compress, hit: st.hit, grass: st.onGrass,
      tunnel: tn ? +tn.inTunnel(i).toFixed(3) : null, covered: tn ? tn.covered(i) : null,
      hemi: L && L.hemi ? +(L.hemi.intensity / L.hemi0).toFixed(3) : null, sun: L && L.sun ? +(L.sun.intensity / L.sun0).toFixed(3) : null,
      audio: ad ? { backend: ad.backend, ready: ad.ready, tunnel: ad.tunnel, reverb: ad.reverb, builds: ad.reverbBuilds,
        wet: ad.tunnelWet ? +ad.tunnelWet.value.toFixed(3) : null, mid: ad.tunnelMid ? +ad.tunnelMid.value.toFixed(3) : null,
        state: ad.context ? ad.context.state : null, frames: ad.frames } : null,
      mirrors: g.hudMirrors ? (function (m) { return { visible: m.visible, passes: m.passes }; })(g.hudMirrors.info()) : null,
      cockpitMirrors: g.cockpit && g.cockpit.info ? g.cockpit.info().mirrors.passes : null,
      next: g.nextCompound, limiter: g.limiter, inPit: st.inPit };
  };
  return 'ok';
})();
