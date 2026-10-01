// Lives in the PAGE of the real game (injected by devtests/tunnel-test/run.js with executeJavaScript). Nothing in the
// project is edited. Since v6.2 index.html loads js/tunnels.js and main.js builds it with the track (F1.game.tunnels) and
// dims its lights inside (F1.game.lights): this page then uses the GAME's tunnels (T.gameTun) and, in the cockpit view,
// only reads what main.js did. Without that wiring (an older main.js) it loads js/tunnels.js itself, builds it for the
// current track (F1.game.track / trackData), adds its group to the scene and plays main.js's part (the prototype).
// window.__tn:
//   - renderer: taken from the scene's onBeforeRender (three.js hands it over); renderer.render is wrapped so that right
//     before each main render (main camera, no render target) the tunnel gets update(t, viewIndex) and, in mode 'rec',
//     the scene lights are set the way the report recommends main.js to do it (prototype of the integration);
//   - place(): the car frozen at a sample (no physics), drive(): the real physics with an autopilot that follows the
//     centreline at a set throttle (main.js's own loop moves it);
//   - ext(): an outside camera in world space (from track samples) used for main.js's render instead of the cockpit's;
//   - perf(): GPU-synced render cost with / without the tunnel group, draw calls and triangles from renderer.info.
(function () {
  'use strict';
  if (window.__tn) return 'already';
  var T = window.__tn = { errs: [], renderer: null, scene: null, tun: null, mode: 'off', lights: null, extSpec: null,
    mainRenders: 0, viewIdx: null, applied: null, gameTun: false, maxDev: 0, devN: 0 };
  window.addEventListener('error', function (e) { T.errs.push(String(e && (e.message || e.type))); });
  window.addEventListener('unhandledrejection', function (e) { T.errs.push('rejection: ' + String(e && e.reason)); });

  // ---- frame timing (main.js's whole rAF callback) ----
  var raf = window.requestAnimationFrame;
  T.ft = [];
  window.requestAnimationFrame = function (cb) {
    return raf.call(window, function (t) {
      var s = performance.now();
      cb(t);
      T.ft.push(performance.now() - s);
      if (T.ft.length > 4000) T.ft.splice(0, 2000);
    });
  };
  T.frameStats = function () {
    var f = T.ft.slice().sort(function (a, b) { return a - b; }); T.ft.length = 0;
    var s = 0; for (var i = 0; i < f.length; i++) s += f[i];
    return { n: f.length, mean: f.length ? +(s / f.length).toFixed(3) : 0, p50: +(f[f.length >> 1] || 0).toFixed(3),
             p95: +(f[Math.floor(f.length * 0.95)] || 0).toFixed(3), max: +(f[f.length - 1] || 0).toFixed(3) };
  };

  // ---- renderer capture ----
  T.hook = function () {
    if (T.renderer) return 'hooked';
    var proto = THREE.Scene.prototype, orig = proto.onBeforeRender;
    proto.onBeforeRender = function (r, sc, cam) {
      if (!T.renderer && F1.game && cam === F1.game.camera) { proto.onBeforeRender = orig; T.scene = sc; T.wrap(r); }
    };
    return 'armed';
  };
  T.wrap = function (r) {
    T.renderer = r;
    var real = r.render;
    T.realRender = function (sc, c) { return real.call(r, sc, c); };
    r.render = function (sc, c) {
      var main = sc === T.scene && c === F1.game.camera && r.getRenderTarget() === null;
      if (main) {
        T.mainRenders++;
        T.beforeMain();
        if (T.extSpec) c = T.extCamera();
      }
      return real.call(r, sc, c);
    };
  };

  // ---- loading and building the module ----
  T.load = function (src) {
    // (v6.2: already loaded by index.html and built by main.js: nothing to add)
    if (typeof F1.buildTunnels === 'function' && F1.game && F1.game.tunnels) return Promise.resolve('index');
    return new Promise(function (res) {
      var s = document.createElement('script');
      s.src = src + (src.indexOf('?') < 0 ? '?t=' + Date.now() : '');
      s.onload = function () { res(typeof F1.buildTunnels === 'function' ? 'loaded' : 'no F1.buildTunnels'); };
      s.onerror = function () { res('load error'); };
      document.body.appendChild(s);
    });
  };
  T.build = function (data) {
    var ms;
    if (data === undefined && F1.game && F1.game.tunnels) {
      // main.js's own (built with the track, in the scene, driven every frame)
      if (T.tun && !T.gameTun) T.tun.dispose();
      T.tun = F1.game.tunnels; T.gameTun = true;
      ms = T.tun.stats.ms;
    } else {
      if (T.tun && !T.gameTun) T.tun.dispose();
      var t0 = performance.now();
      T.tun = F1.buildTunnels(F1.game.track, F1.game.trackData, data);
      ms = performance.now() - t0;
      T.gameTun = false;
      T.scene.add(T.tun.group);
    }
    T.findLights();
    return { ms: +ms.toFixed(1), game: T.gameTun, inScene: !!T.tun.group.parent, stats: T.tun.stats, tunnels: T.tun.tunnels, children: T.tun.group.children.map(function (m) {
      return { name: m.name, tris: m.geometry ? m.geometry.attributes.position.count / 3 : 0, order: m.renderOrder, type: m.material && m.material.type };
    }) };
  };
  T.findLights = function () {
    var L = T.lights, gl = F1.game && F1.game.lights;
    if (!L && gl && gl.hemi && gl.sun) {
      // main.js's two lights with their daylight intensities (they may be dimmed right now)
      L = T.lights = { hemi: [{ o: gl.hemi, base: gl.hemi0 }], sun: [{ o: gl.sun, base: gl.sun0 }] };
    }
    if (!L) {
      L = { hemi: [], sun: [] };
      T.scene.traverse(function (o) {
        if (o.isHemisphereLight) L.hemi.push({ o: o, base: o.intensity });
        if (o.isDirectionalLight) L.sun.push({ o: o, base: o.intensity });
      });
      T.lights = L;
    }
    return { hemi: L.hemi.map(function (h) { return h.base; }), sun: L.sun.map(function (h) { return h.base; }) };
  };

  // ---- right before each main render ----
  // The view's sample: the car's (cockpit), or the outside camera's spec (viewIdx; null = outside any tunnel).
  // The game's tunnels in the cockpit view (mode 'rec'): main.js has set the lights and the tunnel's view for this render
  // (tunnelView): only read them, and how far they are from tunnels.sceneLight at the car's sample (T.maxDev). Otherwise
  // (an outside camera, mode 'off', or no wiring in main.js) this page sets them for its view, as main.js would.
  T.beforeMain = function () {
    var tun = T.tun, car = F1.game.car;
    if (!tun || !car) return;
    var idx = T.extSpec ? T.extSpec.viewIdx : car.state.sampleIndex;
    if (idx === undefined) idx = null;
    T.viewIdx = idx;
    var L = T.lights, hemiF = 1, sunF = 1;
    if (T.gameTun && T.mode === 'rec' && !T.extSpec && L && L.hemi.length && L.sun.length) {
      hemiF = L.hemi[0].o.intensity / L.hemi[0].base; sunF = L.sun[0].o.intensity / L.sun[0].base;
      var dev = Math.abs(hemiF - tun.sceneLight(idx, 'hemi')) + Math.abs(sunF - tun.sceneLight(idx, 'sun'));
      if (dev > T.maxDev) T.maxDev = dev;
      T.devN++;
    } else {
      tun.update(performance.now() / 1000, idx, T.mode === 'rec');   // (off: the scene lights stay as they are)
      if (T.mode === 'rec' && idx !== null) {
        // what main.js does: the module says how much of the scene light reaches this sample
        if (typeof tun.sceneLight === 'function') {
          hemiF = tun.sceneLight(idx, 'hemi'); sunF = tun.sceneLight(idx, 'sun');
        } else {
          var l = tun.lightAt(idx); hemiF = l; sunF = l;
        }
      }
      if (L) {
        L.hemi.forEach(function (h) { h.o.intensity = h.base * hemiF; });
        L.sun.forEach(function (h) { h.o.intensity = h.base * sunF; });
      }
    }
    T.applied = { idx: idx, hemi: +hemiF.toFixed(3), sun: +sunF.toFixed(3) };
    if (T.minApplied) { T.minApplied.hemi = Math.min(T.minApplied.hemi, T.applied.hemi); T.minApplied.sun = Math.min(T.minApplied.sun, T.applied.sun); T.minApplied.frames++; }
  };
  T.setMode = function (m) { T.mode = m; return m; };

  // ---- car placement (frozen) and driving ----
  T.freeze = function () {
    var car = F1.game.car;
    if (!car.__orig) car.__orig = car.update;
    car.update = function () {};
  };
  T.place = function (o) {
    var car = F1.game.car, tr = F1.game.track, n = tr.samples.length;
    T.freeze();
    var i = ((o.i % n) + n) % n;
    car.reset(tr, i);
    if (o.d) { var s = tr.samples[i]; car.state.x += s.nx * o.d; car.state.z += s.nz * o.d; }
    if (o.dh) car.state.heading += o.dh;
    car.__orig.call(car, 1e-4, null, tr);
    car.state.speed = o.v || 0; car.state.steer = 0; car.state.hit = 0; car.state.onGrass = false;
    return { i: car.state.sampleIndex, d: +(car.state.d || 0).toFixed(2), y: +(car.state.y || 0).toFixed(2) };
  };
  // autopilot: steer to a point `look` m ahead on the centreline (+ offset d), throttle thr (0..1), brake when above vmax
  T.drive = function (o) {
    var car = F1.game.car, tr = F1.game.track, S = tr.samples, n = S.length;
    if (!car.__orig) car.__orig = car.update;
    var orig = car.__orig;
    T.driveLog = [];
    T.minApplied = { hemi: 9, sun: 9, frames: 0 };     // every main render while driving (polling misses a short underpass)
    car.update = function (dt, input, track) {
      var s = car.state, ds = tr.length / n, ahead = Math.max(6, Math.round((o.look || 22) / ds));
      var j = (s.sampleIndex + ahead) % n, q = S[j], d = o.d || 0;
      var tx = q.x + q.nx * d - s.x, tz = q.z + q.nz * d - s.z;
      var b = Math.atan2(tx, tz), e = b - s.heading;
      while (e > Math.PI) e -= 2 * Math.PI;
      while (e < -Math.PI) e += 2 * Math.PI;
      var steer = Math.max(-1, Math.min(1, e * (o.k || 2.2)));
      var fast = s.speed > (o.vmax || 1e9);
      var inp = { up: !fast, down: fast, left: false, right: false, throttle: fast ? 0 : (o.thr === undefined ? 1 : o.thr),
        brake: fast ? 0.6 : 0, steerAxis: steer };
      return orig.call(car, dt, inp, track);
    };
    var s = car.state;
    return { i: s.sampleIndex, v: +(s.speed * 3.6).toFixed(1) };
  };
  T.state = function () {
    var s = F1.game.car.state, tun = T.tun;
    return { i: s.sampleIndex, d: +(s.d || 0).toFixed(2), v: +(s.speed * 3.6).toFixed(1), hit: s.hit || 0,
      inT: tun ? +tun.inTunnel(s.sampleIndex).toFixed(3) : null, light: tun ? +tun.lightAt(s.sampleIndex).toFixed(3) : null,
      applied: T.applied };
  };

  // ---- outside camera (world space from the track samples) ----
  // spec: {at, d, h, look: {at, d, h}, fov, viewIdx}  (at = sample index; h above the surface there)
  T.ext = function (spec) {
    if (!spec) { T.extSpec = null; return null; }
    var tr = F1.game.track, S = tr.samples, n = S.length;
    function pt(o) {
      var i = ((Math.round(o.at) % n) + n) % n, s = S[i], d = o.d || 0;
      var y = (tr.surfaceY ? tr.surfaceY(i, d) : (s.y || 0)) + (o.h || 0);
      return new THREE.Vector3(s.x + s.nx * d, y, s.z + s.nz * d);
    }
    spec = Object.assign({}, spec);
    spec.pos = spec.p ? new THREE.Vector3(spec.p[0], spec.p[1], spec.p[2]) : pt(spec);
    spec.tgt = spec.t ? new THREE.Vector3(spec.t[0], spec.t[1], spec.t[2]) : pt(spec.look);
    T.extSpec = spec;
    return [spec.pos.x, spec.pos.y, spec.pos.z].map(function (v) { return +v.toFixed(1); });
  };
  T.extCamera = function () {
    var x = T.extSpec, cam = F1.game.camera;
    var ec = T.extCam || (T.extCam = new THREE.PerspectiveCamera(50, cam.aspect, 0.1, 4000));
    ec.fov = x.fov || 50; ec.aspect = cam.aspect; ec.updateProjectionMatrix();
    ec.position.copy(x.pos); ec.up.set(0, 1, 0); ec.lookAt(x.tgt); ec.updateMatrixWorld(true);
    return ec;
  };
  T.hud = function (on) {
    ['hud', 'hud-toast'].forEach(function (id) { var h = document.getElementById(id); if (h) h.style.visibility = on ? '' : 'hidden'; });
    [].forEach.call(document.querySelectorAll('.hud-mirror'), function (e) { e.style.display = on ? '' : 'none'; });
    return on;
  };

  // ---- cost: GPU-synced renders of the main view, tunnel on / off interleaved ----
  T.perf = function (N) {
    var r = T.renderer, gl = r.getContext(), cam = F1.game.camera, px = new Uint8Array(4), g = T.tun.group;
    var keep = T.extSpec; T.extSpec = null;
    var t = { on: [], off: [] }, info = {};
    function one(on) {
      g.visible = on;
      var t0 = performance.now();
      r.render(T.scene, cam);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      var dt = performance.now() - t0;
      info[on ? 'on' : 'off'] = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      return dt;
    }
    for (var w = 0; w < 5; w++) { one(true); one(false); }
    for (var i = 0; i < N; i++) { t.on.push(one(true)); t.off.push(one(false)); }
    g.visible = true; T.extSpec = keep;
    function med(a) { a = a.slice().sort(function (x, y) { return x - y; }); return +a[a.length >> 1].toFixed(3); }
    function mean(a) { var s = 0; a.forEach(function (v) { s += v; }); return +(s / a.length).toFixed(3); }
    return { n: N, onMedian: med(t.on), offMedian: med(t.off), onMean: mean(t.on), offMean: mean(t.off), info: info,
      programs: r.info.programs ? r.info.programs.length : null, textures: r.info.memory.textures, geometries: r.info.memory.geometries };
  };

  // ---- which pixels of the view are covered by the tunnel's interior / exterior meshes (sanity for the shots) ----
  T.meshes = function () {
    return T.tun ? T.tun.group.children.map(function (m) { return m.name + ':' + (m.visible ? 'on' : 'off'); }) : [];
  };
  return 'ok';
})();
