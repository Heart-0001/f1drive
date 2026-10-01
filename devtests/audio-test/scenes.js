// devtests/audio-test: scripted scenes for js/audio.js, run in the harness page (page.html).
//   AT.render(job)  renders one scene through an OfflineAudioContext, stepping the graph at 60 Hz with
//                   OfflineAudioContext.suspend / resume and calling F1.audio-style update() at each step, exactly as
//                   the game would, then hands a 16-bit WAV and a JSON timeline to the main process (window.__h.save).
//   AT.robust()     throws every kind of rubbish at update() (offline context) and reports what happened
//   AT.live(opts)   the real AudioContext, update() from requestAnimationFrame (see live.js)
// The drivetrain below is an independent copy of the contract's formula: it is the ground truth the analysis checks
// the rendered pitch against (not what the module reports).
(function () {
  'use strict';
  var SR = 48000, FPS = 60, PI = Math.PI;
  var M = F1.createAudio.masks;
  // engines of the scenes (CarSpec fields). V6: the contract's reference car; V8: a 2012-style 2.4 l V8
  var V6 = { gearKmh: [60, 100, 140, 180, 220, 260, 300], topKmh: 345, rpmIdle: 4000, rpmShift: 11800, rpmMax: 12500, cylinders: 6, aspiration: 'hybrid', shiftTime: 0.05 };
  var V8 = { gearKmh: [100, 140, 175, 210, 245, 285], topKmh: 335, rpmIdle: 4500, rpmShift: 17800, rpmMax: 18000, cylinders: 8, aspiration: 'na', shiftTime: 0.04 };
  var ENG = V6, GEAR_KMH = V6.gearKmh, NG = 8, GEAR8 = 345, IDLE = 4000, SHIFT = 11800, MAXR = 12500;
  function useEngine(e) { ENG = e; GEAR_KMH = e.gearKmh; NG = e.gearKmh.length + 1; GEAR8 = e.topKmh; IDLE = e.rpmIdle; SHIFT = e.rpmShift; MAXR = e.rpmMax; }

  function gearFor(v) { if (v < -0.5) return -1; if (!(v >= 0.5)) return 0; var k = v * 3.6, g = 1; while (g < NG && k >= GEAR_KMH[g - 1]) g++; return g; }
  function gearStep(prev, v) {
    if (v < -0.5) return -1;
    if (!(v >= 0.5)) return 0;
    var k = v * 3.6, g = prev >= 1 ? prev : gearFor(v);
    while (g < NG && k >= GEAR_KMH[g - 1]) g++;
    while (g > 1 && k < GEAR_KMH[g - 2] - 8) g--;
    return g;
  }
  function rpmFor(v, g) {
    if (g === 0) return IDLE;
    var r = SHIFT * Math.abs(v) * 3.6 / (g >= NG ? GEAR8 : GEAR_KMH[Math.max(g, 1) - 1]);
    return Math.min(MAXR, Math.max(IDLE, r));
  }

  // the car: js/car.js's longitudinal numbers + the v6 drivetrain and ERS bookkeeping
  function Sim() { this.v = 0; this.gear = 0; this.shiftT = 9; this.battery = 1; this.z = 0; this.rpm = IDLE; this.thr = 0; this.brk = 0; this.dep = 0; this.har = 0; }
  Sim.prototype.step = function (dt, thr, brk, boost, grass, limitKmh) {
    var v = this.v, P = 970.4, dep = 0, res = 0.5 + 0.0012 * v * v + (grass ? 0.8 + 0.16 * v : 0), drive = 0, g;
    if (boost && thr > 0 && brk === 0 && this.battery > 0) { dep = thr; this.battery = Math.max(0, this.battery - dt / 32); }
    if (thr > 0 && brk < 1) drive = Math.min(grass ? 5.6 : 11, P * (1 + 0.16 * dep) / Math.max(v, 1)) * thr * (1 - brk);
    if (limitKmh && v * 3.6 > limitKmh) drive = 0;                   // the pit limiter cuts the drive above the limit
    v += (drive - res - (12 + 0.0032 * v * v) * brk) * dt;
    if (v < 0) v = 0;
    this.v = v; this.z += v * dt;
    g = gearStep(this.gear, v);
    if (g !== this.gear) { this.gear = g; this.shiftT = 0; } else this.shiftT += dt;
    this.har = brk > 0 ? brk * Math.min(1, v / 70) : (thr === 0 && v > 20 ? 0.12 : 0);
    this.battery = Math.min(1, this.battery + this.har * dt / 20);
    this.dep = dep; this.rpm = rpmFor(v, g); this.thr = thr; this.brk = brk;
  };
  function fullState() {
    return { x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, pitch: 0, roll: 0, sampleIndex: 0, d: 0, onGrass: false, hit: 0,
      throttle: 0, brake: 0, gear: 0, rpm: IDLE, shiftT: 9, battery: 1, deploy: 0, harvest: 0, slip: 0 };
  }
  function fill(st, sim) {
    st.z = sim.z; st.speed = sim.v; st.throttle = sim.thr; st.brake = sim.brk; st.gear = sim.gear; st.rpm = sim.rpm; st.shiftT = sim.shiftT;
    st.battery = sim.battery; st.deploy = sim.dep; st.harvest = sim.har;
    return st;
  }
  // a car state that just sits at a speed (full contract fields)
  function steady(kmh, thr) {
    var st = fullState(), v = kmh / 3.6;
    st.speed = v; st.gear = gearFor(v); st.rpm = rpmFor(v, st.gear); st.throttle = thr;
    return st;
  }
  function head(st, out) { out.x = st.x; out.y = st.y + 0.7; out.z = st.z; out.heading = st.heading; return out; }
  var NONE = [];

  var SCENES = {};

  // (a) standing start, full throttle through all eight gears to top speed, hard braking to a stop
  function launch(minimal, eng) {
    return function (audio) {
      if (eng && audio.setEngine) audio.setEngine(eng);
      var sim = new Sim(), st = minimal ? { x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, pitch: 0, roll: 0, sampleIndex: 0, d: 0, onGrass: false, hit: 0 } : fullState();
      var L = {};
      return { frame: function (i, t, dt) {
        var thr = t >= 1 && t < 25 ? 1 : 0, brk = t >= 25 && sim.v > 0 ? 1 : 0;
        sim.step(dt, thr, brk, false, false);
        if (minimal) { st.z = sim.z; st.speed = sim.v; } else fill(st, sim);
        return { own: st, listener: head(st, L), others: NONE, truth: sim };
      } };
    };
  }
  SCENES.a_launch = { dur: 33, make: launch(false), about: 'standing start, flat out through 8 gears, hard braking to a stop (full v6 car state)' };
  SCENES.a_minimal = { dur: 33, make: launch(true), about: 'the same drive with today\'s car state only (speed, onGrass, hit): everything else is derived' };
  SCENES.a_v8launch = { dur: 30, engine: V8, make: launch(false, V8), about: 'the launch with a 2012-style 2.4 l V8 (setEngine): 7 gears to 18 000 rpm, then braking' };

  // (b) a lap-like mix
  SCENES.b_lap = { dur: 40, about: 'throttle / lift / brake, ERS deploy and harvest, tyre slip, a grass excursion, two impacts, the rev limiter', make: function () {
    var sim = new Sim(), st = fullState(), L = {}, ev = [], hit2 = false;
    ev.push({ type: 'deploy', t0: 0.5, t1: 7 }, { type: 'lift', t0: 7, t1: 8 }, { type: 'brake', t0: 8, t1: 9.6 }, { type: 'slip', t0: 9.6, t1: 12.5 },
      { type: 'grass', t0: 17, t1: 19.5 }, { type: 'hit', t0: 18, t1: 18 + 5 / 60, strength: 0.35 }, { type: 'deploy', t0: 19.5, t1: 24 },
      { type: 'limiter', t0: 24, t1: 25.2 }, { type: 'hit', t0: 29, t1: 29 + 1 / 60, strength: 0.9 }, { type: 'brake', t0: 33, t1: 36 }, { type: 'brake', t0: 38, t1: 40 });
    return { events: ev, frame: function (i, t, dt) {
      var thr = 0, brk = 0, boost = false, grass = false, slip = 0, hit = 0, over = 0;
      if (t < 0.5) thr = 0;
      else if (t < 7) { thr = 1; boost = true; }
      else if (t < 8) thr = 0;
      else if (t < 9.6) brk = 1;
      else if (t < 12.5) { thr = 0.5; slip = 0.75 * Math.pow(Math.sin(PI * (t - 9.6) / 2.9), 2); }
      else if (t < 17) thr = 1;
      else if (t < 19.5) { thr = 0.6; grass = true; if (t >= 18 - 1e-9 && t < 18 + 5 / 60 - 1e-9) hit = 0.35; }
      else if (t < 24) { thr = 1; boost = true; }
      else if (t < 25.2) { thr = 1; over = MAXR; }
      else if (t < 33) { thr = 1; if (!hit2 && t >= 29 - 1e-9) { hit2 = true; hit = 0.9; sim.v *= 0.6; } }
      else if (t < 36) brk = 0.7;
      else if (t < 38) thr = 1;
      else brk = sim.v > 0 ? 1 : 0;
      sim.step(dt, thr, brk, boost, grass);
      fill(st, sim);
      st.onGrass = grass; st.slip = slip; st.hit = hit;
      if (over) { st.rpm = over; sim.rpm = over; }
      sim.slip = slip; sim.grass = grass; sim.hit = hit;
      return { own: st, listener: head(st, L), others: NONE, truth: sim };
    } };
  } };

  // (c) standing at the roadside, looking across the road; a car passes at 300 km/h, 5 m away, from the left to the right
  SCENES.c_passby = { dur: 6, about: 'roadside: a remote car passes at 300 km/h, 5 m in front of the listener, left to right', make: function () {
    var st = steady(0, 0), L = { x: 0, y: 0.7, z: 0, heading: PI / 2 }, V = 300 / 3.6, car = { id: 'r', x: 5, y: 0, z: 0, heading: 0, speed: V }, others = [car];
    st.heading = PI / 2;
    var g = gearFor(V), rpm = rpmFor(V, g);
    return { cols: ['rz', 'dist', 'f0', 'dop'], frame: function (i, t) {
      car.z = -250 + V * t;
      var d = Math.sqrt(25 + 0.49 + car.z * car.z);
      return { own: st, listener: L, others: others, truth: { v: 0, gear: 0, rpm: IDLE, thr: 0, brk: 0 }, x: [car.z, d, rpm / 20, 343 / (343 + V * car.z / d)] };
    } };
  } };

  // (d) 200 km/h in a pack of ten
  SCENES.d_pack = { dur: 14, about: '200 km/h in a pack of 10 remote cars: some overtake, some fall back, one is teleported twice', make: function () {
    var V = 200 / 3.6, st = steady(200, 0.4), L = {}, ev = [];
    // [metres ahead at t = 0, metres to the left, speed relative to us]
    var defs = [[12, 0, 0], [-40, 3.5, 10], [60, -3.5, -6], [-90, -3, 15], [150, 0, -3], [-200, 3, 12], [25, 3.5, 0], [-15, -3.5, 0], [280, 0, -20], [-400, 0, 30]];
    var cars = defs.map(function (d, k) { return { id: 'c' + k, x: d[1], y: 0, z: d[0], heading: 0, speed: V + d[2] }; });
    ev.push({ type: 'teleport', t0: 7, t1: 7, id: 'c6' }, { type: 'teleport', t0: 11, t1: 11, id: 'c6' });
    var tp = 0;
    return { events: ev, cols: ['inRange', 'near'], frame: function (i, t, dt) {
      var k, c, n = 0, near = 1e9, d;
      if (i > 0) st.z += V * dt;
      for (k = 0; k < cars.length; k++) {
        c = cars[k];
        if (i > 0) {
          if (k === 3) c.speed = Math.min(V + 32, c.speed + 2.5 * dt);            // one of them is accelerating
          c.z += c.speed * dt;
        }
      }
      c = cars[6];
      if (tp === 0 && t >= 7 - 1e-9) { tp = 1; c.z = st.z + 500; }                // taken away (pits) ...
      if (tp === 1 && t >= 11 - 1e-9) { tp = 2; c.z = st.z - 15; c.x = -3.5; }    // ... and put back right behind us
      for (k = 0; k < cars.length; k++) { d = Math.hypot(cars[k].x - st.x, cars[k].z - st.z); if (d < 300) n++; if (d < near) near = d; }
      return { own: st, listener: head(st, L), others: cars, truth: { v: V, gear: st.gear, rpm: st.rpm, thr: st.throttle, brk: 0 }, x: [n, near] };
    } };
  } };

  // (d2) one remote car that is teleported while it is loud: approaching -> receding (Doppler factor 1.21 -> 0.85),
  //      then put on the "grid" standing still
  SCENES.d_teleport = { dur: 3.6, about: 'a single remote car teleported twice while loud (approaching -> receding -> standing on the grid)', make: function () {
    var st = steady(0, 0), L = { x: 0, y: 0.7, z: 0, heading: 0 }, V = 60, car = { id: 7, x: 6, y: 0, z: -100, heading: 0, speed: V }, others = [car], ev = [], tp = 0;
    ev.push({ type: 'teleport', t0: 1, t1: 1 }, { type: 'teleport', t0: 2.2, t1: 2.2 });
    return { events: ev, cols: ['rz', 'dist', 'f0', 'dop'], frame: function (i, t, dt) {
      if (i > 0) car.z += car.speed * dt;
      if (tp === 0 && t >= 1 - 1e-9) { tp = 1; car.z = 40; }
      if (tp === 1 && t >= 2.2 - 1e-9) { tp = 2; car.z = -30; car.x = 3; car.speed = 0; }
      var d = Math.sqrt(car.x * car.x + 0.49 + car.z * car.z), g = gearFor(car.speed);
      return { own: st, listener: L, others: others, truth: { v: 0, gear: 0, rpm: IDLE, thr: 0, brk: 0 }, x: [car.z, d, rpmFor(car.speed, g) / 20, 343 / (343 + car.speed * car.z / d)] };
    } };
  } };

  // (e) the start: five lights, lights out, launch
  SCENES.e_lights = { dur: 9, about: 'grid start: beep for each of the five lights, the go beep at lights out, launch', make: function (audio) {
    var sim = new Sim(), st = fullState(), L = {}, ev = [], next = 0, times = [1, 2, 3, 4, 5, 6.4];
    times.forEach(function (t, k) { ev.push({ type: k < 5 ? 'light' : 'go', t0: t, t1: t }); });
    return { events: ev, frame: function (i, t, dt) {
      sim.step(dt, t >= 6.4 ? 1 : 0, 0, false, false);
      fill(st, sim);
      if (next < times.length && t >= times[next] - 1e-9) { audio.beep(next < 5 ? 'light' : 'go'); next++; }
      return { own: st, listener: head(st, L), others: NONE, truth: sim };
    } };
  } };

  // (f) mute / volume / setActive
  SCENES.f_fades = { dur: 8, about: 'steady 200 km/h; mute on 1 s, off 2 s; volume 0.5 at 3 s, 1 at 4 s; setActive(false) at 5 s, (true) at 6.5 s', make: function (audio) {
    var st = steady(200, 0.5), L = {}, V = 200 / 3.6, ev = [], done = 0;
    var acts = [[1, 'mute', function () { audio.setMuted(true); }], [2, 'unmute', function () { audio.setMuted(false); }],
      [3, 'volume0.5', function () { audio.setVolume(0.5); }], [4, 'volume1', function () { audio.setVolume(1); }],
      [5, 'inactive', function () { audio.setActive(false); }], [6.5, 'active', function () { audio.setActive(true); }]];
    acts.forEach(function (a) { ev.push({ type: a[1], t0: a[0], t1: a[0] }); });
    return { events: ev, frame: function (i, t, dt) {
      if (i > 0) st.z += V * dt;
      while (done < acts.length && t >= acts[done][0] - 1e-9) acts[done++][2]();
      return { own: st, listener: head(st, L), others: NONE, truth: { v: V, gear: st.gear, rpm: st.rpm, thr: st.throttle, brk: 0 } };
    } };
  } };

  // (g) steady stems for the loudness balance
  function steadyScene(kmh, thr, withCar, about, eng) {
    return { dur: 3.2, about: about, engine: eng, make: function (audio) {
      if (eng && audio.setEngine) audio.setEngine(eng);
      var st = steady(kmh, thr), L = {}, V = kmh / 3.6, car = { id: 'a', x: -10, y: 0, z: 0, heading: 0, speed: V }, others = withCar ? [car] : NONE;
      return { frame: function (i, t, dt) {
        if (i > 0) st.z += V * dt;
        car.z = st.z;
        return { own: st, listener: head(st, L), others: others, truth: { v: V, gear: st.gear, rpm: st.rpm, thr: thr, brk: 0 } };
      } };
    } };
  }
  SCENES.g_top = steadyScene(330, 1, true, '330 km/h flat out, a remote car 10 m to the right at the same speed (stems: engine / wind+road / remote)');
  SCENES.g_mid = steadyScene(150, 1, false, '150 km/h flat out (4th gear)');
  SCENES.g_overrun = steadyScene(250, 0, false, '250 km/h, throttle closed');
  SCENES.g_idle = steadyScene(0, 0, false, 'standing, idle');
  SCENES.g_v8 = steadyScene(300, 1, false, '300 km/h flat out, 2.4 l V8', V8);
  SCENES.g_v8over = steadyScene(250, 0, false, '250 km/h throttle closed, 2.4 l V8', V8);

  // (k) level balance: own car flat out at 100 / 200 / 330 km/h, a remote car at 5 / 20 / 60 / 150 m (same speed, ahead)
  SCENES.k_balance = { dur: 19.2, about: 'own car flat out at 100, 200, 330 km/h; a remote car 5, 20, 60, 150 m ahead at the same speed (1.6 s each)', make: function () {
    var segs = [], ev = [], st = fullState(), L = {}, car = { id: 'k', x: 0, y: 0, z: 0, heading: 0, speed: 0 }, others = [car], k = 0;
    [100, 200, 330].forEach(function (kmh) { [5, 20, 60, 150].forEach(function (d) { segs.push({ kmh: kmh, d: d, t0: k * 1.6, t1: (k + 1) * 1.6 }); ev.push({ type: 'segment', t0: k * 1.6, t1: (k + 1) * 1.6, kmh: kmh, dist: d }); k++; }); });
    return { events: ev, cols: ['seg'], frame: function (i, t, dt) {
      var s = segs[Math.min(segs.length - 1, Math.floor(t / 1.6 + 1e-9))], V = s.kmh / 3.6;
      st.speed = V; st.gear = gearFor(V); st.rpm = rpmFor(V, st.gear); st.throttle = 1;
      if (i > 0) st.z += V * dt;
      car.speed = V; car.x = s.d > 3 ? 3 : 0; car.z = st.z + Math.sqrt(Math.max(0, s.d * s.d - car.x * car.x));
      return { own: st, listener: head(st, L), others: others, truth: { v: V, gear: st.gear, rpm: st.rpm, thr: 1, brk: 0 }, x: [segs.indexOf(s)] };
    } };
  } };

  // (d3) 16 cars at once around a car at 200 km/h: passes both ways, the voices keep being handed around
  SCENES.d_pack16 = { dur: 16, about: '200 km/h among 16 remote cars spread over 400 m, relative speeds -14 .. +14 m/s (voices handed around)', make: function () {
    var V = 200 / 3.6, st = steady(200, 0.5), L = {}, cars = [], k;
    for (k = 0; k < 16; k++) cars.push({ id: 'p' + k, x: [-3.5, 0, 3.5][k % 3], y: 0, z: -180 + k * 26 + (k % 2) * 7, heading: 0, speed: V + (((k * 7) % 15) - 7) * 2 });
    return { cols: ['inRange', 'near'], frame: function (i, t, dt) {
      var n = 0, near = 1e9, d, c;
      if (i > 0) { st.z += V * dt; for (k = 0; k < cars.length; k++) cars[k].z += cars[k].speed * dt; }
      for (k = 0; k < cars.length; k++) { c = cars[k]; d = Math.hypot(c.x - st.x, c.z - st.z); if (d < 300) n++; if (d < near) near = d; }
      return { own: st, listener: head(st, L), others: cars, truth: { v: V, gear: st.gear, rpm: st.rpm, thr: 0.5, brk: 0 }, x: [n, near] };
    } };
  } };

  // (l) the network: a remote car accelerating 25 -> 85 m/s on a circle of 60 m around the standing listener (its
  //     distance never changes, so the Doppler factor is exactly 1 and the pitch follows its speed alone). Its position
  //     is interpolated every frame, 100 ms behind (like js/net.js, plus its 0.1 s lead along the heading); its speed /
  //     heading come from 20 Hz snapshots: held between them (l_net20: what dead reckoning between late snapshots
  //     does), interpolated (l_netlin: what net.js does), or exact every frame (l_netexact: the control)
  function netScene(hold, exact) {
    return { dur: 7, about: 'a remote car accelerating 25 -> 85 m/s on a 60 m circle around the listener; speed / heading from 20 Hz snapshots, ' + (exact ? 'CONTROL: exact every frame' : hold ? 'held between them' : 'interpolated'), make: function () {
      var st = steady(0, 0), L = { x: 0, y: 0.7, z: 0, heading: 0 }, R = 60, snaps = [], car = { id: 'n', x: 0, y: 0, z: 0, heading: 0, speed: 0 }, others = [car];
      function truthAt(t) {
        var tt = Math.max(0, t), sp = Math.min(85, 25 + 12 * tt), s = t < 0 ? 25 * t : (tt < 5 ? 25 * tt + 6 * tt * tt : 25 * 5 + 150 + 85 * (tt - 5)), phi = s / R;
        return { x: R * Math.sin(phi), z: R * Math.cos(phi), heading: Math.atan2(Math.cos(phi), -Math.sin(phi)), speed: sp };
      }
      function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
      return { cols: ['f0', 'dop', 'rgear'], frame: function (i, t) {
        var k, a, b, u, tr = t - 0.1, h, sp, x, z, ts, q;
        while (snaps.length === 0 || snaps[snaps.length - 1].t + 0.05 <= t + 1e-9) { ts = snaps.length ? snaps[snaps.length - 1].t + 0.05 : t - 0.2; q = truthAt(ts); q.t = ts; snaps.push(q); }
        for (k = snaps.length - 1; k > 0 && snaps[k - 1].t > tr; k--);
        a = snaps[Math.max(0, k - 1)]; b = snaps[k]; u = b.t > a.t ? Math.min(1, Math.max(0, (tr - a.t) / (b.t - a.t))) : 0;
        x = a.x + (b.x - a.x) * u; z = a.z + (b.z - a.z) * u;
        if (hold) { h = a.heading; sp = a.speed; } else { h = a.heading + wrap(b.heading - a.heading) * u; sp = a.speed + (b.speed - a.speed) * u; }
        if (exact) { q = truthAt(tr); x = q.x; z = q.z; h = q.heading; sp = q.speed; }
        car.x = x + Math.sin(h) * sp * 0.1; car.z = z + Math.cos(h) * sp * 0.1; car.heading = h; car.speed = sp;
        var q2 = truthAt(tr), g = gearFor(q2.speed);
        return { own: st, listener: L, others: others, truth: { v: 0, gear: 0, rpm: IDLE, thr: 0, brk: 0 }, x: [rpmFor(q2.speed, g) * 6 / 120, 1, g] };
      } };
    } };
  }
  SCENES.l_net20 = netScene(true);
  SCENES.l_netlin = netScene(false);
  SCENES.l_netexact = netScene(false, true);         // control: exact values every frame (what the analysis measures without any 20 Hz steps)

  // (m) the pit lane: limiter on, up to 80 km/h and held there flat out, limiter off, away
  SCENES.m_pit = { dur: 10, about: 'pit limiter: play(limiterOn) at 0.5 s, flat out to 80 km/h and held there (state.limiter), play(limiterOff) at 6 s, away', make: function (audio) {
    var sim = new Sim(), st = fullState(), L = {}, ev = [], held = -1, on = false;
    ev.push({ type: 'play:limiterOn', t0: 0.5, t1: 0.5 }, { type: 'play:limiterOff', t0: 6, t1: 6 });
    return { events: ev, frame: function (i, t, dt) {
      var lim = t >= 0.5 - 1e-9 && t < 6 - 1e-9;
      if (lim && !on) { on = true; if (audio.play) audio.play('limiterOn'); }
      if (!lim && on) { on = false; if (audio.play) audio.play('limiterOff'); }
      sim.step(dt, t >= 0.8 ? 1 : 0, 0, false, false, lim ? 80 : 0);
      fill(st, sim); st.limiter = lim;
      if (held < 0 && lim && sim.v * 3.6 > 79) { held = t; ev.push({ type: 'pitlimiter', t0: t + 0.3, t1: 6 }); }
      return { own: st, listener: head(st, L), others: NONE, truth: sim };
    } };
  } };

  // (n) the pit box: jack, four wheel guns, jack down, limiter button; then a flat spot at 150 km/h
  SCENES.n_oneshots = { dur: 10.5, about: 'standing: play(jack), 4 x play(pitgun), play(jack), play(limiterOn / Off); then 150 km/h with state.vib = 0.8 (flat spot)', make: function (audio) {
    var st = steady(0, 0), L = {}, ev = [], plan = [[0.6, 'jack'], [1.2, 'pitgun'], [1.8, 'pitgun'], [2.4, 'pitgun'], [3.0, 'pitgun'], [3.8, 'jack'], [4.6, 'limiterOn'], [5.4, 'limiterOff']], next = 0;
    plan.forEach(function (p) { ev.push({ type: 'play:' + p[1], t0: p[0], t1: p[0] }); });
    ev.push({ type: 'vib', t0: 6.5, t1: 10.5, kmh: 150 });
    return { events: ev, frame: function (i, t, dt) {
      while (next < plan.length && t >= plan[next][0] - 1e-9) { if (audio.play) audio.play(plan[next][1], 1); next++; }
      if (t >= 6.5 - 1e-9) { var V = 150 / 3.6; st.speed = V; st.gear = gearFor(V); st.rpm = rpmFor(V, st.gear); st.throttle = 0.4; st.vib = 0.8; st.z += V * dt; }
      return { own: st, listener: head(st, L), others: NONE, truth: { v: st.speed, gear: st.gear, rpm: st.rpm, thr: st.throttle, brk: 0 } };
    } };
  } };


  // (h) level against distance: a remote car spirals away from the standing listener at a constant 55 m/s
  SCENES.h_distance = { dur: 29, about: 'a remote car circles the standing listener at 55 m/s while the radius grows from 4 m to 350 m', make: function () {
    var st = steady(0, 0), L = { x: 0, y: 0, z: 0, heading: 0 }, car = { id: 'h', x: 0, y: 0, z: 4, heading: 0, speed: 55 }, others = [car], ang = 0, RS = 12;
    return { cols: ['dist'], frame: function (i, t, dt) {
      var r = 4 + RS * t, vt = Math.sqrt(55 * 55 - RS * RS);
      if (i > 0) ang += vt / r * dt;
      car.x = r * Math.sin(ang); car.z = r * Math.cos(ang);
      // velocity = radial RS + tangential vt
      car.heading = Math.atan2(RS * Math.sin(ang) + vt * Math.cos(ang), RS * Math.cos(ang) - vt * Math.sin(ang));
      return { own: st, listener: L, others: others, truth: { v: 0, gear: 0, rpm: IDLE, thr: 0, brk: 0 }, x: [r] };
    } };
  } };

  // (i) wind and road roar against speed: 0 to 340 km/h in 24 s
  SCENES.i_wind = { dur: 25, about: 'wind and road roar while the speed rises steadily from 0 to 340 km/h', make: function () {
    var st = steady(0, 0.5), L = {};
    return { frame: function (i, t, dt) {
      var v = Math.min(340, t / 24 * 340) / 3.6;
      st.speed = v; st.gear = gearFor(v); st.rpm = rpmFor(v, st.gear);
      if (i > 0) st.z += v * dt;
      return { own: st, listener: head(st, L), others: NONE, truth: { v: v, gear: st.gear, rpm: st.rpm, thr: 0.5, brk: 0 } };
    } };
  } };

  // ---------------------------------------------------------------------------------------------
  function wav16(chs, sr) {
    var n = chs[0].length, nc = chs.length, buf = new ArrayBuffer(44 + n * nc * 2), dv = new DataView(buf), i, c, o = 44, x;
    function str(p, s) { for (var k = 0; k < s.length; k++) dv.setUint8(p + k, s.charCodeAt(k)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 2, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, nc, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * nc * 2, true); dv.setUint16(32, nc * 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * nc * 2, true);
    for (i = 0; i < n; i++) for (c = 0; c < nc; c++) {
      x = Math.round(chs[c][i] * 32767);
      dv.setInt16(o, x > 32767 ? 32767 : (x < -32768 ? -32768 : x), true); o += 2;
    }
    return buf;
  }

  var AT = window.AT = { scenes: SCENES, masks: M };

  AT.list = function () { return Object.keys(SCENES).map(function (k) { return { name: k, dur: SCENES[k].dur, about: SCENES[k].about }; }); };

  // job = { scene, backend: 'worklet' | 'nodes', mask, file }  ->  summary; writes file + '.wav' and file + '.json'
  AT.render = async function (job) {
    var def = SCENES[job.scene];
    if (!def) throw new Error('no scene ' + job.scene);
    var sr = job.sampleRate || SR, fps = job.fps || FPS, n = Math.ceil(def.dur * sr), ctx = new OfflineAudioContext(2, n, sr);
    var audio = F1.createAudio({ context: ctx, worklet: job.backend !== 'nodes', mask: job.mask == null ? M.ALL : job.mask });
    var ok = await audio.init();
    if (!ok) throw new Error('init() failed');
    if (audio.debug.backend !== (job.backend === 'nodes' ? 'nodes' : 'worklet')) throw new Error('wanted the ' + job.backend + ' back end, got ' + audio.debug.backend);
    useEngine(def.engine || V6);
    var sc = def.make(audio), frames = Math.floor(def.dur * fps), rows = [], dbg = audio.debug, maxVoices = 0, i, cyl = ENG.cylinders;
    var cols = ['t', 'rpm', 'gear', 'thr', 'brk', 'speed', 'dep', 'har', 'slip', 'grass', 'hit', 'm_rpm', 'm_gear', 'm_thr', 'm_brk', 'm_cut', 'm_blip', 'm_lim', 'm_voices', 'm_thumps', 'm_har', 'm_slip', 'm_red', 'cyl', 'm_starts', 'm_steals']
      .concat(sc.cols || []);
    function frame(k) {
      var r = sc.frame(k, k / fps, 1 / fps), tr = r.truth;
      audio.update(1 / fps, r.own, r.listener, r.others);
      if (dbg.voices > maxVoices) maxVoices = dbg.voices;
      rows.push([ctx.currentTime, tr.rpm, tr.gear, tr.thr, tr.brk, tr.v, tr.dep || 0, tr.har || 0, tr.slip || 0, tr.grass ? 1 : 0, tr.hit || 0,
        dbg.rpm, dbg.gear, dbg.throttle, dbg.brake, dbg.cut, dbg.blip, dbg.limiter, dbg.voices, dbg.thumps, dbg.harvest, dbg.slip, dbg.compressor ? dbg.compressor.reduction : 0, cyl, dbg.voiceStarts, dbg.steals].concat(r.x || []));
    }
    audio.setActive(true);
    frame(0);
    for (i = 1; i < frames; i++) (function (k) { ctx.suspend(k / fps).then(function () { frame(k); return ctx.resume(); }); })(i);
    var t0 = performance.now(), buf = await ctx.startRendering(), ms = performance.now() - t0;
    var Lc = buf.getChannelData(0), Rc = buf.getChannelData(1), peak = 0, bad = 0, x;
    for (i = 0; i < n; i++) { x = Math.abs(Lc[i]); if (x > peak) peak = x; x = Math.abs(Rc[i]); if (x > peak) peak = x; if (Lc[i] !== Lc[i] || Rc[i] !== Rc[i]) bad++; }
    var meta = {
      scene: job.scene, about: def.about, backend: dbg.backend, mask: job.mask == null ? M.ALL : job.mask, sampleRate: sr, fps: fps, dur: def.dur,
      cols: cols, rows: rows, events: sc.events || [], floatPeak: peak, nan: bad, renderMs: Math.round(ms), errors: dbg.errors, lastError: dbg.lastError ? String(dbg.lastError) : null,
      thumps: dbg.thumps, beeps: dbg.beeps, shots: dbg.shots, maxVoices: maxVoices, engine: ENG,
      info: { MAX_VOICES: audio.MAX_VOICES, C_SOUND: audio.C_SOUND, D_REF: audio.D_REF, D_EXP: audio.D_EXP, D_FADE: audio.D_FADE, D_MAX: audio.D_MAX, tuning: audio.tuning }
    };
    await window.__h.save(job.file + '.wav', wav16([Lc, Rc], sr));
    await window.__h.save(job.file + '.json', new TextEncoder().encode(JSON.stringify(meta)).buffer);
    audio.dispose();
    useEngine(V6);
    return { file: job.file, backend: meta.backend, frames: frames, seconds: def.dur, renderMs: Math.round(ms), floatPeak: peak, nan: bad, errors: meta.errors, lastError: meta.lastError, thumps: meta.thumps, maxVoices: maxVoices };
  };

  // What the compressor's built-in make-up gain is for the master bus settings: a -40 dBFS sine in, level out.
  AT.compMakeup = async function () {
    var ctx = new OfflineAudioContext(1, SR * 2, SR), a = F1.createAudio({ context: ctx }), T = a.tuning;
    var o = ctx.createOscillator(), g = ctx.createGain(), c = ctx.createDynamicsCompressor();
    c.threshold.value = T.compThreshold; c.knee.value = T.compKnee; c.ratio.value = T.compRatio; c.attack.value = T.compAttack; c.release.value = T.compRelease;
    o.frequency.value = 500; g.gain.value = 0.01; o.connect(g); g.connect(c); c.connect(ctx.destination); o.start();
    var d = (await ctx.startRendering()).getChannelData(0), s = 0, i;
    for (i = SR; i < 2 * SR; i++) s += d[i] * d[i];
    return { makeup: Math.sqrt(s / SR) / (0.01 / Math.SQRT2), trimInModule: T.compTrim };
  };
})();
