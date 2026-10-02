// Cockpit screenshots + performance in the REAL game (offscreen Electron): js/cockpit.js and js/carmodel.js.
//   npx electron devtests/cockpit-test/shots.js
//   env TAG=after (output folder devtests/cockpit-test/out/<TAG>/)   ONLY=<group,group>   PERF=0 (skip the timing)
//       MIRRORS=0 (the cockpit's live mirrors off: environment-mapped glass, as before)
//   groups: tracks (3 styles x Monza start / Monza at speed / Monaco corner / Spa Eau Rouge), lock (full lock left / right),
//           look (head look left / right / up / down, 3 styles), light (pit building, bridge, pit lane), livery (5 liveries),
//           display (the wheel display at several states: close-ups + the canvas itself), remote (a remote car with a
//           livery beside us; its halo from the side), mirror (live mirrors: remote cars behind us seen from the seat, the
//           glasses close up, head look towards them, mirrors off / on), ext (outside views of the cockpit model),
//           perf (triangles, draw calls, textures, frame time; the live mirrors' cost per frame -> perf-mirrors.json),
//           shape (v6.2 road-shape cues: Spa's Eau Rouge dip and Raidillon climb, Zandvoort T3, Madring's La Monumental,
//           a flat corner, Monza's straight at speed; the camera's world pitch / roll, the car's, the FOV -> shape.json)
//       APP_ROOT=<folder> (the game to load, default the project: e.g. a `git archive HEAD` copy, so that a before / after
//       pair is not disturbed by other edits of the tree)   FOV=<deg> (cockpit.setFov(deg) after the track loads, if the
//       cockpit has it)   SHAPE_WAIT=<ms> (settling time before each shape shot, default 3000: the head's slow pitch)
//       HUD=1 (keep the HUD on: by default it is hidden)
// The page is a copy of index.html (out/index-ck.html, <base> = the project or APP_ROOT) with one extra script before
// js/main.js (out/ck-hook.js: a file, the page's CSP blocks inline scripts) that keeps the renderer and the cockpit main.js
// creates (window.__renderer, window.__ck): main.js is not changed.
// Works against the old cockpit too: TAG=before COCKPIT=devtests/cockpit-test/cockpit-v5.js loads that file in place of
// js/cockpit.js (what the old one does not have, setCar and the styles, is skipped; its shots are named *-old).
// Also in this folder: api.test.js (node: the API, setCar / dispose, display budget, camera and remote car against v5),
// compare.js (before / after side by side), cockpit-v5.js + carmodel-v5.js (the v5 files, frozen as baselines).
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.resolve(process.env.APP_ROOT || ROOT);
require('../electron-userdata')(app, 'cockpit-test');
const TAG = process.env.TAG || 'after';
const OUT = path.join(__dirname, 'out', TAG);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = g => !ONLY.length || ONLY.indexOf(g) >= 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
fs.mkdirSync(OUT, { recursive: true });

// ---- the page: index.html + a hook script before main.js ----
function pageFile() {
  let html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const mainTag = '<script src="js/main.js"></script>';
  if (html.indexOf(mainTag) < 0) throw new Error('index.html: main.js tag not found');
  // (a file of its own: index.html's Content-Security-Policy blocks inline scripts since the final v6 review)
  const hookFile = path.join(__dirname, 'out', 'ck-hook.js');
  fs.writeFileSync(hookFile, `(function () {
    var R = THREE.WebGLRenderer;
    THREE.WebGLRenderer = function (p) { var r = new R(p); window.__renderer = r; return r; };
    THREE.WebGLRenderer.prototype = R.prototype;
    var C = F1.createCockpit;
    F1.createCockpit = function (cam) { var c = C(cam); window.__ck = c; return c; };
  })();\n`);
  html = html.replace(mainTag, '<script src="' + url.pathToFileURL(hookFile).href + '"></script>\n' + mainTag);
  if (process.env.COCKPIT) {
    const tag = '<script src="js/cockpit.js"></script>';
    if (html.indexOf(tag) < 0) throw new Error('index.html: cockpit.js tag not found');
    html = html.replace(tag, '<script src="' + url.pathToFileURL(path.resolve(process.env.COCKPIT)).href + '"></script>');
  }
  const file = path.join(__dirname, 'out', 'index-ck.html');
  fs.writeFileSync(file, html.replace('<head>', '<head><base href="' + url.pathToFileURL(APP + path.sep).href + '">'));
  return file;
}

// ---- helpers living in the page ----
const PAGE_LIB = `(function () {
  var cx = window.__cx = {};
  function T() { return F1.game.track; }
  cx.scene = function () { return F1.game.camera.parent.parent; };
  // main.js calls cockpit.setLook(pad) every frame: take that over so the test decides where the driver looks
  cx.hookLook = function () {
    var ck = window.__ck; if (!ck || ck.__look) return;
    ck.__look = ck.setLook; ck.setLook = function () {};
  };
  cx.look = function (x, y) { cx.hookLook(); window.__ck.__look(x, y); };
  // the car stays where the test puts it: no physics
  cx.freeze = function () { var car = F1.game.car; if (!car.__orig) { car.__orig = car.update; car.update = function () {}; } };
  cx.find = function (at) {
    var tr = T(), S = tr.samples, n = S.length, i, best = -1, bv = -Infinity;
    if (typeof at === 'number') return ((at % n) + n) % n;
    if (at === 'start') return n - 10;
    if (at === 'corner') {           // tightest corner of the lap
      for (i = 0; i < n; i++) {
        var a = S[(i - 4 + n) % n], b = S[(i + 4) % n];
        var k = Math.abs(Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz));
        if (k > bv) { bv = k; best = i; }
      }
      return best;
    }
    if (at === 'dip') {              // Spa: bottom of Eau Rouge, the lowest point in the first 1.6 km
      var ds = tr.length / n; bv = Infinity;
      for (i = Math.round(300 / ds); i < Math.round(1600 / ds); i++) if ((S[i].y || 0) < bv) { bv = S[i].y || 0; best = i; }
      return best;
    }
    if (at === 'maxbank') {          // the first sample of the steepest banking (Zandvoort T3, Madring La Monumental)
      for (i = 0; i < n; i++) if (Math.abs(S[i].bank || 0) > bv + 1e-9) { bv = Math.abs(S[i].bank || 0); best = i; }
      return best;
    }
    if (at === 'bridge') {           // a bridge deck over the road (scenery data), else the start gantry
      var sc = window.F1_SCENERY && window.F1_SCENERY[F1.game.trackData.id], bd = Infinity;
      (sc ? sc.buildings : []).forEach(function (b) {
        if (b.k !== 'bridge') return;
        var x = 0, z = 0; b.p.forEach(function (p) { x += p[0]; z += p[1]; }); x /= b.p.length; z /= b.p.length;
        var q = tr.nearest(x, z); if (q && q.dist < bd) { bd = q.dist; best = q.index; }
      });
      return bd < 12 ? best : 0;
    }
    if (at === 'pit') {              // pit lane entry (v6 track.pit) or else the start straight by the pit building
      if (tr.pit && tr.pit.entry != null) return tr.pit.entry;
      return 0;
    }
    return 0;
  };
  // o: {at, back, d, v, steer, state: {...}}
  cx.place = function (o) {
    var car = F1.game.car, tr = T(), n = tr.samples.length;
    cx.freeze();
    var i = ((cx.find(o.at) - (o.back || 0)) % n + n) % n;
    car.reset(tr, i);
    var d = o.d;
    if (o.lane && tr.pit && tr.pit.laneD) { var ld = tr.pit.laneD(i); if (ld === ld) d = ld; }
    if (d) { var s = tr.samples[i]; car.state.x += s.nx * d; car.state.z += s.nz * d; }
    // v6 fields the test may have set before: start from a v5-like state
    ['gear', 'rpm', 'battery', 'deploy', 'harvest', 'limiter', 'inPit', 'vib', 'tyres', 'lapTime', 'lapDelta'].forEach(function (k) { delete car.state[k]; });
    if (o.dh) car.state.heading += o.dh;
    car.__orig.call(car, 1e-4, null, tr);
    car.state.speed = o.v || 0; car.state.steer = o.steer || 0; car.state.hit = 0; car.state.onGrass = false;
    var st = o.state || {}; for (var k in st) car.state[k] = st[k];
    if (window.__ck) { cx.hookLook(); window.__ck.__look(o.look ? o.look[0] : 0, o.look ? o.look[1] : 0); }
    return { i: i, n: n, y: car.state.y, pitch: car.state.pitch };
  };
  cx.hud = function (on) { var h = document.getElementById('hud'); if (h) h.style.visibility = on ? '' : 'hidden';
    var t = document.getElementById('hud-toast'); if (t) t.style.visibility = on ? '' : 'hidden'; };
  // outside / close-up camera: main.js keeps rendering, the renderer draws with this camera instead
  // (placed in the cockpit group's frame at every render, so it follows the car)
  cx.ext = function (e) {
    var r = window.__renderer;
    if (!r.__render) {
      r.__render = r.render;
      r.render = function (s, c) {
        var x = cx.extSpec;
        if (x && c === F1.game.camera) {           // (not the cockpit's own passes: the mirrors' cameras)
          var cam = F1.game.camera, grp = cam.parent, ec = cx.extCam || (cx.extCam = new THREE.PerspectiveCamera(40, cam.aspect, 0.02, 4000));
          ec.fov = x.fov || 40; ec.aspect = cam.aspect; ec.updateProjectionMatrix();
          grp.updateMatrixWorld(true);
          ec.position.set(x.p[0], x.p[1], x.p[2]); grp.localToWorld(ec.position);
          var tgt = new THREE.Vector3(x.t[0], x.t[1], x.t[2]); grp.localToWorld(tgt);
          ec.up.set(0, 1, 0); ec.lookAt(tgt); ec.updateMatrixWorld(true);
          c = ec;
        }
        r.__render.call(r, s, c);
      };
    }
    cx.extSpec = e || null;
  };
  // remote car models near us (o: {colour, colour2, accent, name, d (to the left), ahead (< 0: behind), halo}, or a list
  // of them; null removes them)
  cx.remote = function (o) {
    (cx.rms || []).forEach(function (rm) { cx.scene().remove(rm.group); rm.dispose(); });
    cx.rms = []; cx.rm = null;
    if (!o) return null;
    (Array.isArray(o) ? o : [o]).forEach(function (o) {
      var rm = cx.rm = F1.createCarModel(o.colour, o.name || '對手');
      cx.rms.push(rm);
      if (rm.setLivery) rm.setLivery(o.colour, o.colour2, o.accent);
      if (rm.setHalo && o.halo === false) rm.setHalo(false);
      cx.scene().add(rm.group);
      var s = F1.game.car.state, h = s.heading, lx = Math.cos(h), lz = -Math.sin(h), fx = Math.sin(h), fz = Math.cos(h);
      var st = { x: s.x + lx * (o.d || 0) + fx * (o.ahead || 0), z: s.z + lz * (o.d || 0) + fz * (o.ahead || 0), heading: h + (o.dh || 0), speed: 0, steer: o.steer || 0 };
      if (o.samples) {             // along the track instead: that many samples behind us, d across the road
        var S = F1.game.track.samples, n = S.length, si = ((s.sampleIndex - o.samples) % n + n) % n, sm = S[si];
        var sa = S[(si + n - 1) % n], sb = S[(si + 1) % n];
        st.x = sm.x + sm.nx * (o.d || 0); st.z = sm.z + sm.nz * (o.d || 0); st.heading = Math.atan2(sm.tx, sm.tz);
        st.pitch = Math.atan2((sb.y || 0) - (sa.y || 0), Math.hypot(sb.x - sa.x, sb.z - sa.z)); st.roll = sm.bank || 0;
      }
      var q = F1.game.track.nearest(st.x, st.z); st.y = F1.game.track.surfaceY ? F1.game.track.surfaceY(q.index, q.d) : 0;
      rm.update(st, 0, { x: s.x, y: (s.y || 0) + 0.8, z: s.z });
    });
    return true;
  };
  // triangles / draw calls / textures of the cockpit, and the frame time with and without it
  cx.stats = function () {
    var g = window.__ck.group, tris = 0, meshes = 0, mats = {}, texs = {}, bytes = 0;
    g.traverse(function (o) {
      if (!o.isMesh || !o.visible) return;
      var vis = true, p = o; while (p && p !== g) { if (!p.visible) vis = false; p = p.parent; }
      if (!vis) return;
      meshes++;
      var geo = o.geometry, c = geo.index ? geo.index.count : geo.attributes.position.count;
      if (geo.drawRange && geo.drawRange.count !== Infinity) c = Math.min(c, geo.drawRange.count);
      tris += c / 3;
      var ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach(function (m) {
        mats[m.uuid] = m.type;
        ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'normalMap', 'bumpMap', 'envMap', 'alphaMap', 'aoMap', 'specularMap'].forEach(function (k) {
          var t = m[k]; if (!t || texs[t.uuid]) return;
          var im = t.image, w = 0, h = 0, faces = 1;
          if (Array.isArray(im)) { faces = im.length; im = im[0]; }
          if (im) { w = im.width || 0; h = im.height || 0; }
          var b = w * h * 4 * faces * (t.generateMipmaps !== false && t.minFilter !== THREE.LinearFilter && t.minFilter !== THREE.NearestFilter ? 4 / 3 : 1);
          texs[t.uuid] = { k: k, w: w, h: h, faces: faces, kb: Math.round(b / 1024), name: t.name || '' };
          bytes += b;
        });
      });
    });
    return { meshes: meshes, triangles: Math.round(tris), materials: Object.keys(mats).length,
      textures: Object.keys(texs).map(function (k) { return texs[k]; }), textureKB: Math.round(bytes / 1024) };
  };
  // frame time: render the scene synchronously N times with / without the cockpit (interleaved), readPixels after each
  // render to wait for the GPU. cpuUpdate: cost of cockpit.update per frame.
  cx.perf = function (N) {
    var r = window.__renderer, gl = r.getContext(), cam = F1.game.camera, scene = cx.scene(), ck = window.__ck, px = new Uint8Array(4);
    cx.ext(null);
    var t = { on: [], off: [] }, info = {};
    function one(on) {
      ck.group.visible = on;
      var t0 = performance.now();
      r.render(scene, cam);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      var dt = performance.now() - t0;
      info[on ? 'on' : 'off'] = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      return dt;
    }
    for (var w = 0; w < 10; w++) { one(true); one(false); }
    for (var i = 0; i < N; i++) { var a = i % 2 === 0; t[a ? 'on' : 'off'].push(one(a)); t[a ? 'off' : 'on'].push(one(!a)); }
    // worst case: the wheel display (and the livery, as after a setCar) re-uploaded in the same frame
    var disp = null; ck.group.traverse(function (o) { if (o.isMesh && o.material && o.material.map && o.material.map.name === 'wheel-display') disp = o.material.map; });
    t.upload = [];
    for (i = 0; i < N; i++) { if (disp) disp.needsUpdate = true; t.upload.push(one(true)); }
    // live mirrors: frames with the glasses (one glass's pass each) against frames without them (glass mesh hidden: no
    // pass), and with the scenery's trees drawn in the mirrors too (renamed so that the cockpit does not leave them out)
    var mir = null; ck.group.traverse(function (o) { if (o.isMesh && o.name === 'mirror') mir = o; });
    var trees = []; scene.traverse(function (o) { if (/^scenery-trees/.test(o.name)) trees.push(o); });
    function treesInMirror(on) { trees.forEach(function (o) { o.name = on ? 'in-mirror-' + o.name : o.name.replace(/^in-mirror-/, ''); }); }
    t.mirOn = []; t.mirOff = []; t.mirScen = [];
    var infoOn = info.on;
    if (mir && ck.setMirrors) {
      for (i = 0; i < N; i++) {
        mir.visible = false; t.mirOff.push(one(true));
        info.mirOff = { calls: r.info.render.calls, triangles: r.info.render.triangles };
        mir.visible = true; t.mirOn.push(one(true));
        info.mirOn = { calls: r.info.render.calls, triangles: r.info.render.triangles };
        if (trees.length) { treesInMirror(true); t.mirScen.push(one(true)); treesInMirror(false); info.mirScen = { calls: r.info.render.calls, triangles: r.info.render.triangles }; }
      }
    }
    info.on = infoOn;
    var infoMain = JSON.parse(JSON.stringify(info));   // (the renders below are of another car)
    // setCar: a style change (rebuild) and a colour change (livery redraw only)
    var s0 = performance.now(), sStyle = null, sColour = null;
    if (ck.setCar) {
      ck.setCar({ cockpit: 'modern', year: 2012, colour: '#aa0000' }, '#00ffaa'); sStyle = performance.now() - s0;
      s0 = performance.now(); ck.setCar({ cockpit: 'modern', year: 2012, colour: '#00aa00' }, '#00ffaa'); sColour = performance.now() - s0;
    }
    s0 = performance.now(); one(true); var firstRender = performance.now() - s0;
    ck.group.visible = true;
    function med(a) { a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; }
    function mean(a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; }
    // cockpit.update CPU cost (display redraw included: dt = 1/60, the display redraws at <= 15 Hz)
    var st = {}; var s0 = F1.game.car.state; for (var k in s0) st[k] = s0[k];
    var u0 = performance.now(), U = 2000;
    for (var j = 0; j < U; j++) { st.speed = 40 + (j % 400) * 0.1; st.steer = Math.sin(j / 50); st.rpm = 8000 + (j % 400) * 10; ck.update(st, 1 / 60); }
    var upd = (performance.now() - u0) / U;
    // one display redraw (forced: every call moves the clock by 0.1 s and changes the speed)
    u0 = performance.now();
    for (j = 0; j < 200; j++) { st.speed = 20 + j * 0.3; ck.update(st, 0.1); }
    var redraw = (performance.now() - u0) / 200;
    ck.update(s0, 0);
    return { medianOn: med(t.on), medianOff: med(t.off), meanOn: mean(t.on), meanOff: mean(t.off), meanUpload: mean(t.upload), n: N, info: infoMain, updateMs: upd, redrawMs: redraw,
      setCarStyleMs: sStyle, setCarColourMs: sColour, renderAfterSetCarMs: firstRender,
      mirror: t.mirOn.length ? { medianOn: med(t.mirOn), medianOff: med(t.mirOff), meanOn: mean(t.mirOn), meanOff: mean(t.mirOff),
        p90On: t.mirOn.slice().sort(function (x, y) { return x - y; })[Math.floor(t.mirOn.length * 0.9)],
        medianScenery: t.mirScen.length ? med(t.mirScen) : null, meanScenery: t.mirScen.length ? mean(t.mirScen) : null } : null };
  };
  // the view against the world and against the car: pitch = elevation of the line of sight (deg, + up), roll = how far
  // the view's right edge is raised (deg); the car's (the cockpit group's) the same way; the eye's height above the seat
  // frame's origin; the FOV
  cx.pose = function () {
    var cam = F1.game.camera, g = window.__ck.group, D = 180 / Math.PI;
    g.updateMatrixWorld(true);
    function att(m, fwdSign) {
      var e = m.elements, fx = -e[8] * fwdSign, fy = -e[9] * fwdSign, fz = -e[10] * fwdSign;
      var rx = e[0], ry = e[1], rz = e[2], ux = e[4], uy = e[5], uz = e[6];
      if (fwdSign < 0) { rx = -rx; ry = -ry; rz = -rz; }     // the car's +X is its LEFT: its right is -X
      return { pitch: Math.asin(Math.max(-1, Math.min(1, fy / Math.hypot(fx, fy, fz)))) * D, roll: Math.atan2(ry, uy) * D };
    }
    var c = att(cam.matrixWorld, 1), k = att(g.matrixWorld, -1), s = F1.game.car.state;
    return { camPitch: +c.pitch.toFixed(2), camRoll: +c.roll.toFixed(2), carPitch: +k.pitch.toFixed(2), carRoll: +k.roll.toFixed(2),
      viewVsCarPitch: +(c.pitch - k.pitch).toFixed(2), viewVsCarRoll: +(c.roll - k.roll).toFixed(2),
      eyeY: +cam.position.y.toFixed(4), fov: +cam.fov.toFixed(2), kmh: +(s.speed * 3.6).toFixed(0), compress: s.compress };
  };
  // the steering-wheel display canvas as a data URL (if the cockpit exposes one)
  cx.displayPng = function () {
    var found = null;
    window.__ck.group.traverse(function (o) { if (o.isMesh && o.material && o.material.map && o.material.map.name === 'wheel-display') found = o.material.map.image; });
    return found && found.toDataURL ? found.toDataURL('image/png') : null;
  };
  return true;
})()`;

// ---- scenarios ----
const STYLES = ['modern', 'halo', 'halo18'];
const SPECS = {   // livery + style; accent = the player's colour
  modern: { id: '2013-test', year: 2013, cockpit: 'modern', colour: '#C8102E', colour2: '#F2F2F2', number: 7 },
  halo: { id: '2019-test', year: 2019, cockpit: 'halo', colour: '#1E3A8A', colour2: '#E8E8E8', number: 33 },
  halo18: { id: '2025-test', year: 2025, cockpit: 'halo18', colour: '#F4872C', colour2: '#141212', number: 4 }
};
const LIVERIES = [
  ['dark', { colour: '#0F100F', colour2: '#BDBCBA', number: 63 }, '#00D7B6'],
  ['white', { colour: '#F2F2F2', colour2: '#1A1C22', number: 31 }, '#E8002D'],
  ['red', { colour: '#BB1320', colour2: '#DDDDDC', number: 16 }, '#FFD21E'],
  ['papaya', { colour: '#F4872C', colour2: '#141212', number: 81 }, '#19C8E6'],
  ['twotone', { colour: '#1E41FF', colour2: '#FFD21E', number: 22 }, '#FF2B6A']
];

async function main() {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true } });
  w.webContents.setFrameRate(60);
  const errors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    errors.push(msg); console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  const js = code => w.webContents.executeJavaScript(code);
  const shot = async n => { await sleep(120); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); console.log('shot', n); };
  await w.loadFile(pageFile());
  await sleep(900);
  await js(PAGE_LIB);
  const err = await js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  if (err) { console.log('ERROR OVERLAY', err); return; }
  let curTrack = '';
  async function track(name) {
    if (curTrack === name) return;
    if (await js(`F1.game.running`)) { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await sleep(60); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await sleep(300); }
    const picked = await js(`(function () { var c = [].slice.call(document.querySelectorAll('.card')).filter(function (n) { return n.textContent.toLowerCase().indexOf(${J(name)}) >= 0; })[0];
      if (!c) return null; c.click(); var __g=document.getElementById('setup-go'); if(__g) __g.click(); return c.querySelector('.card-name').textContent; })()`);
    for (let k = 0; k < 150; k++) { if (await js(`!!(F1.game.running && F1.game.track && window.__ck)`)) break; await sleep(100); }
    await sleep(500);
    console.log('track', picked);
    curTrack = name;
    await js(`__cx.hookLook(); __cx.hud(${process.env.HUD === "1"}); true`);
    if (process.env.MIRRORS === '0') await js(`window.__ck && window.__ck.setMirrors && window.__ck.setMirrors(false), true`);
    if (process.env.FOV) console.log('setFov', await js(`window.__ck && window.__ck.setFov ? window.__ck.setFov(${+process.env.FOV}) : 'n/a'`));
  }
  const canSetCar = async () => js(`!!(window.__ck && window.__ck.setCar)`);
  async function setCar(spec, accent) { if (await canSetCar()) return js(`window.__ck.setCar(${J(spec)}, ${J(accent)}), true`); return false; }
  async function view(name, o, waitMs) {
    const p = await js(`__cx.place(${J(o)})`);
    await js(`__cx.ext(${J(o.ext || null)}), true`);
    await sleep(waitMs || 900);
    await shot(name);
    return p;
  }

  // ---------- tracks ----------
  if (want('tracks')) {
    for (const st of (await setCarAvailable()) ? STYLES : ['old']) {
      await track('monza');
      if (st !== 'old') await setCar(SPECS[st], '#19C8E6');
      await view('monza-start-' + st, { at: 'start', v: 0 });
      await view('monza-fast-' + st, { at: 'start', back: -40, v: 85 }, 1600);
      await track('monaco');
      if (st !== 'old') await setCar(SPECS[st], '#19C8E6');
      const sign = await js(`(function () { var S = F1.game.track.samples, n = S.length, i = __cx.find('corner'), a = S[(i - 4 + n) % n], b = S[(i + 4) % n]; return Math.sign(a.tx * b.tz - a.tz * b.tx); })()`);
      // positive cross (tx,tz)x(tx',tz') = turning ... decided from the screenshot: steer towards the corner
      await view('monaco-corner-' + st, { at: 'corner', back: 7, v: 14, steer: -sign * 0.55 }, 1200);
      await track('spa');
      if (st !== 'old') await setCar(SPECS[st], '#19C8E6');
      await view('spa-eaurouge-' + st, { at: 'dip', back: 45, v: 70 }, 1400);
    }
  }
  async function setCarAvailable() { await track('monza'); return canSetCar(); }

  // ---------- full lock ----------
  if (want('lock')) {
    await track('monza');
    for (const st of (await canSetCar()) ? ['halo18', 'modern'] : ['old']) {
      if (st !== 'old') await setCar(SPECS[st], '#19C8E6');
      await view('lock-left-' + st, { at: 'start', v: 3, steer: 1 }, 900);
      await view('lock-right-' + st, { at: 'start', v: 3, steer: -1 }, 900);
    }
  }
  // ---------- head look ----------
  if (want('look')) {
    await track('monza');
    for (const st of (await canSetCar()) ? STYLES : ['old']) {
      if (st !== 'old') await setCar(SPECS[st], '#19C8E6');
      await view('look-left-' + st, { at: 'start', back: 20, v: 0, look: [1, 0] }, 900);
      await view('look-right-' + st, { at: 'start', back: 20, v: 0, look: [-1, 0] }, 900);
      await view('look-up-' + st, { at: 'start', back: 20, v: 0, look: [0, 1] }, 900);
      await view('look-downleft-' + st, { at: 'start', back: 20, v: 0, look: [1, -1] }, 900);
    }
  }
  // ---------- light: pit building, bridge, pit lane ----------
  if (want('light')) {
    await track('monza');
    if (await canSetCar()) await setCar(SPECS.halo18, '#19C8E6');
    await view('light-monza-pitside', { at: 'start', back: 30, v: 0, d: -4.5 }, 900);
    await view('light-monza-pitlane', { at: 'pit', back: -8, lane: true, v: 20, state: { limiter: true, inPit: true } }, 1200);
    await view('light-monza-pitcurtain', { at: 'pit', back: 12, v: 20 }, 1200);
    await view('light-monza-gantry', { at: 0, back: 8, v: 30 }, 1200);
    await track('silverstone');
    if (await canSetCar()) await setCar(SPECS.halo, '#19C8E6');
    await view('light-silverstone-bridge', { at: 'bridge', back: 12, v: 30 }, 1200);
    await view('light-silverstone-underbridge', { at: 'bridge', back: 3, v: 30, look: [0.3, 1] }, 1200);
  }
  // ---------- liveries ----------
  if (want('livery') && (await setCarAvailable())) {
    for (let i = 0; i < LIVERIES.length; i++) {
      const [n, liv, acc] = LIVERIES[i];
      const st = STYLES[i % 3];
      await setCar(Object.assign({ id: '2020-' + n, year: 2020, cockpit: st }, liv), acc);
      await view('livery-' + n + '-' + st, { at: 'start', back: 25, v: 0 }, 900);
      await view('livery-' + n + '-' + st + '-ext', { at: 'start', back: 25, v: 0, ext: { p: [2.2, 1.6, 4.4], t: [0, 0.4, 1.0], fov: 45 } }, 700);
    }
  }
  // ---------- steering-wheel display ----------
  if (want('display')) {
    await track('monza');
    const states = [
      ['standing', { v: 0, state: { gear: 0, rpm: 4000, battery: 1, limiter: false } }],
      ['pitlimiter', { v: 22, state: { gear: 2, rpm: 7600, battery: 0.62, limiter: true, inPit: true } }],
      ['mid', { v: 45, state: { gear: 4, rpm: 9200, battery: 0.48, deploy: 0, harvest: 0.6 } }],
      ['shift', { v: 83, state: { gear: 7, rpm: 11750, battery: 0.21, deploy: 1 } }],
      ['derived', { v: 60, state: {} }]
    ];
    for (const st of (await canSetCar()) ? ['halo18', 'modern'] : ['old']) {
      if (st !== 'old') await setCar(SPECS[st], '#19C8E6');
      for (const [n, o] of states) {
        const close = { p: [0, 0.80, -0.35], t: [0, 0.50, 0.30], fov: 26 };
        await view('display-' + st + '-' + n, Object.assign({ at: 'start', back: 30, ext: close }, o), 900);
        const png = await js(`__cx.displayPng()`);
        if (png) fs.writeFileSync(path.join(OUT, 'display-canvas-' + st + '-' + n + '.png'), Buffer.from(png.split(',')[1], 'base64'));
      }
    }
    await js(`__cx.ext(null), true`);
  }
  // ---------- remote car with a livery ----------
  if (want('remote')) {
    await track('monza');
    if (await canSetCar()) await setCar(SPECS.halo18, '#19C8E6');
    await js(`__cx.place({ at: 'start', back: 30, v: 0 })`);
    await js(`__cx.remote({ colour: '#1E41FF', colour2: '#FFD21E', accent: '#FF2B6A', name: '藍色對手', d: 4.2, ahead: 7 })`);
    await sleep(700); await shot('remote-beside');
    await js(`__cx.remote({ colour: '#F2F2F2', colour2: '#C8102E', accent: '#FFD21E', name: '白色對手', d: -3.5, ahead: 12 })`);
    await sleep(700); await shot('remote-white');
    await view('remote-ext', { at: 'start', back: 30, v: 0, ext: { p: [-2.5, 2.2, 12], t: [-3.5, 0.3, 14], fov: 50 } }, 700);
    // its halo against the cockpit's (ext-side-*): side and front three-quarter views of a remote car beside us
    await js(`__cx.remote({ colour: '#F4872C', colour2: '#141212', accent: '#19C8E6', name: '', d: 4.2, ahead: 7 })`);
    await view('remote-side', { at: 'start', back: 30, v: 0, ext: { p: [8.7, 1.0, 7.6], t: [4.2, 0.5, 7.6], fov: 50 } }, 700);
    await view('remote-front34', { at: 'start', back: 30, v: 0, ext: { p: [6.8, 1.5, 12.2], t: [4.2, 0.4, 8.0], fov: 45 } }, 700);
    await js(`__cx.remote(null), __cx.ext(null), true`);
  }
  // ---------- live mirrors: other cars behind us ----------
  if (want('mirror') && (await setCarAvailable())) {
    const behind = [{ colour: '#1E41FF', colour2: '#FFD21E', accent: '#FF2B6A', name: '藍色對手', d: 1.7, ahead: -9 },
                    { colour: '#F2F2F2', colour2: '#C8102E', accent: '#FFD21E', name: '白色對手', d: -2.6, ahead: -17 }];
    const glass = { modern: [0.70, 0.665, 0.415], halo: [0.70, 0.665, 0.415], halo18: [0.66, 0.665, 0.415] };
    for (const [tr, styles] of [['monza', STYLES], ['monaco', ['halo18']]]) {
      await track(tr);
      for (const st of styles) {
        await setCar(SPECS[st], '#19C8E6');
        const at = tr === 'monza' ? { at: 'start', back: 30, v: 0 } : { at: 'corner', back: 30, v: 0 };
        await js(`__cx.place(${J(at)})`);
        // Monaco: along the curving road (samples behind us), Monza's straight: straight back
        await js(`__cx.remote(${J(tr === 'monza' ? behind : behind.map((b, i) => Object.assign({}, b, { samples: i ? 9 : 5 })))})`);
        const p0 = await js(`__ck.info().mirrors.passes`);
        await sleep(700); await shot('mirror-eye-' + tr + '-' + st);
        const p1 = await js(`__ck.info().mirrors.passes`);
        console.log('mirror passes during the shot', p1 - p0, J(await js(`__ck.info().mirrors`)));
        const g = glass[st];
        await view('mirror-left-' + tr + '-' + st, Object.assign({ ext: { p: [0.0, 0.80, -0.35], t: [g[0], g[1], g[2]], fov: 13 } }, at), 700);
        await view('mirror-right-' + tr + '-' + st, Object.assign({ ext: { p: [0.0, 0.80, -0.35], t: [-g[0], g[1], g[2]], fov: 13 } }, at), 700);
        if (tr === 'monza') {
          await view('mirror-lookleft-' + st, Object.assign({ look: [1, 0] }, at), 900);
          await view('mirror-lookright-' + st, Object.assign({ look: [-1, 0] }, at), 900);
        }
        await js(`__cx.ext(null), true`);
      }
    }
    // one car right behind: in both glasses; then the mirrors switched off (environment map again) and on
    await track('monza');
    await setCar(SPECS.halo18, '#19C8E6');
    await js(`__cx.place({ at: 'start', back: 30, v: 0 })`);
    await js(`__cx.remote({ colour: '#BB1320', colour2: '#DDDDDC', accent: '#FFD21E', name: '正後方', d: 0, ahead: -7 })`);
    await sleep(700); await shot('mirror-behind-halo18');
    await view('mirror-behind-left-halo18', { at: 'start', back: 30, v: 0, ext: { p: [0.0, 0.80, -0.35], t: [0.66, 0.665, 0.415], fov: 13 } }, 700);
    await js(`__cx.ext(null), __ck.setMirrors(false), true`);
    await sleep(500); await shot('mirror-off-halo18');
    await view('mirror-off-left-halo18', { at: 'start', back: 30, v: 0, ext: { p: [0.0, 0.80, -0.35], t: [0.66, 0.665, 0.415], fov: 13 } }, 700);
    await js(`__cx.ext(null), __ck.setMirrors(true), true`);
    await sleep(500); await shot('mirror-on-again-halo18');
    await js(`__cx.remote(null), true`);
  }
  // ---------- outside views of the cockpit model ----------
  if (want('ext')) {
    await track('monza');
    for (const st of (await canSetCar()) ? STYLES : ['old']) {
      if (st !== 'old') await setCar(SPECS[st], '#19C8E6');
      await view('ext-front34-' + st, { at: 'start', back: 25, v: 0, ext: { p: [2.6, 1.5, 5.2], t: [0, 0.4, 1.0], fov: 45 } }, 700);
      await view('ext-side-' + st, { at: 'start', back: 25, v: 0, ext: { p: [4.5, 1.0, 0.6], t: [0, 0.5, 0.6], fov: 50 } }, 700);
      await view('ext-top-' + st, { at: 'start', back: 25, v: 0, ext: { p: [0.01, 5.5, 0.7], t: [0, 0, 0.8], fov: 50 } }, 700);
      await view('ext-wheel-' + st, { at: 'start', back: 25, v: 0, ext: { p: [1.6, 0.55, 2.9], t: [0.8, 0.35, 1.9], fov: 40 } }, 700);
      await view('ext-mirror-' + st, { at: 'start', back: 25, v: 0, ext: { p: [0.0, 0.85, -0.25], t: [0.75, 0.66, 0.55], fov: 30 } }, 700);
      await view('eye-nose-' + st, { at: 'start', back: 25, v: 0, ext: { p: [0.0, 0.80, -0.35], t: [0, 0.42, 2.2], fov: 26 } }, 700);
    }
    await js(`__cx.ext(null), true`);
  }
  // ---------- road shape (v6.2): slope and banking as the driver sees them ----------
  // The car is frozen at each spot (no physics), so the road-shape load car.js computes while driving (state.compress, g)
  // is set by hand to what devtests/handling-test/compress.js measured there (0 where nothing was measured). Each shot
  // waits SHAPE_WAIT ms so that the head's slow pitch / roll / compression have settled; shape.json has the poses.
  if (want('shape')) {
    const rows = [], WAIT = +(process.env.SHAPE_WAIT || 3000);
    const SH = [
      // (samples are 2 m apart; positions relative to features so that they survive a rebuild of the track data)
      ['spa-dip', 'francorchamps', { at: 'dip', v: 80 }, 1.57],                 // the bottom of Eau Rouge, the climb ahead
      ['spa-raidillon', 'francorchamps', { at: 'dip', back: -105, v: 80 }, 0.3], // 210 m on: Raidillon
      ['zandvoort-t3', 'zandvoort', { at: 'maxbank', back: -28, v: 37, turn: 0.35 }, 1.81],   // Hugenholtz (19 deg), mid-corner
      ['madring-monumental', 'madring', { at: 'maxbank', back: -99, v: 60, turn: 0.15 }, 1.26], // La Monumental (13.5 deg), 200 m in
      ['monza-corner', 'monza', { at: 'corner', back: 7, v: 14, turn: 0.55 }, 0],  // an ordinary corner on a flat track
      ['monza-straight', 'monza', { at: 'start', back: -40, v: 85 }, 0]  // flat straight at speed
    ];
    for (const [name, card, o, comp] of SH) {
      await track(card);
      if (await canSetCar()) await setCar(SPECS.halo18, '#19C8E6');
      const p = Object.assign({}, o, { state: { compress: comp } });
      if (o.turn) {     // steer towards the corner (the sign as in the 'tracks' group's Monaco corner)
        const sign = await js(`(function () { var S = F1.game.track.samples, n = S.length, i = (__cx.find(${J(o.at)}) - ${o.back || 0} + n) % n, a = S[(i - 4 + n) % n], b = S[(i + 4) % n]; return Math.sign(a.tx * b.tz - a.tz * b.tx); })()`);
        p.steer = -sign * o.turn;
      }
      const pl = await view('shape-' + name, p, WAIT);
      const pose = await js(`__cx.pose()`);
      rows.push(Object.assign({ name, sample: pl.i }, pose));
      console.log('shape', name, J(pose));
    }
    console.table(rows);
    fs.writeFileSync(path.join(OUT, 'shape.json'), J(rows));
  }
  // ---------- performance ----------
  if (want('perf') && process.env.PERF !== '0') {
    const rows = [], mirrorRows = [];
    for (const tr of ['monza', 'monaco']) {
      await track(tr);
      for (const st of (await canSetCar()) ? STYLES : ['old']) {
        if (st !== 'old') await setCar(SPECS[st], '#19C8E6');
        await js(`__cx.place({ at: 'start', back: 20, v: 50 })`);
        await sleep(300);
        const s = await js(`__cx.stats()`);
        const p = await js(`__cx.perf(150)`);
        rows.push({ track: tr, style: st, meshes: s.meshes, triangles: s.triangles, materials: s.materials, textureKB: s.textureKB,
          drawOn: p.info.on.calls, drawOff: p.info.off.calls, triOn: p.info.on.triangles, triOff: p.info.off.triangles,
          msOn: +p.medianOn.toFixed(3), msOff: +p.medianOff.toFixed(3), meanOn: +p.meanOn.toFixed(3), meanOff: +p.meanOff.toFixed(3), meanUpl: +p.meanUpload.toFixed(3),
          updateMs: +p.updateMs.toFixed(4), redrawMs: +p.redrawMs.toFixed(3), setStyle: +(p.setCarStyleMs || 0).toFixed(1), setColour: +(p.setCarColourMs || 0).toFixed(1), render1: +(p.renderAfterSetCarMs || 0).toFixed(1) });
        if (p.mirror) {
          const m = p.mirror, i = p.info;
          mirrorRows.push({ track: tr, style: st, frameNoMirror: +m.meanOff.toFixed(3), frameMirror: +m.meanOn.toFixed(3), mirrorCost: +(m.meanOn - m.meanOff).toFixed(3),
            medianCost: +(m.medianOn - m.medianOff).toFixed(3), p90Mirror: +m.p90On.toFixed(3),
            drawNoMirror: i.mirOff && i.mirOff.calls, drawMirror: i.mirOn && i.mirOn.calls, triNoMirror: i.mirOff && i.mirOff.triangles, triMirror: i.mirOn && i.mirOn.triangles,
            costWithTrees: m.meanScenery != null ? +(m.meanScenery - m.meanOff).toFixed(3) : null, triWithTrees: i.mirScen && i.mirScen.triangles });
        }
        if (tr === 'monza' && st === rows[0].style) console.log('textures', J(s.textures));
      }
    }
    console.table(rows);
    fs.writeFileSync(path.join(OUT, 'perf.json'), J(rows));
    if (mirrorRows.length) {
      console.log('live mirrors (ms per frame; one glass redrawn per frame):');
      console.table(mirrorRows);
      fs.writeFileSync(path.join(OUT, 'perf-mirrors.json'), J(mirrorRows));
    }
  }
  console.log('console errors:', errors.length);
}

app.whenReady().then(async () => {
  const guard = setTimeout(() => { console.log('WATCHDOG: 6 min'); app.exit(2); }, 6 * 60 * 1000);
  try { await main(); } catch (e) { console.log('ERR', e && e.stack || e); }
  clearTimeout(guard);
  app.exit(0);
});
