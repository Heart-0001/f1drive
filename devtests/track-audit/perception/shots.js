// Perception harness: the REAL game (a snapshot of it in ./snap, so concurrent edits of the project do not disturb a
// before / after pair), offscreen, MUTED (devtests/electron-userdata.js). The car is driven on the racing line by the
// e2e autopilot (devtests/gp-e2e/autopilot.js, read, not modified) and frozen when it reaches a target point; then the
// cockpit view is captured and the geometry measured (road grade / bank, car pitch / roll, the camera's world pitch /
// roll / FOV, where the true horizon and the road ahead fall on the screen).
//
//   npx electron devtests/track-audit/perception/shots.js
//   env TRACK=<id>  PLAN=<json file | inline json array>  TAG=<suffix>  W=1280 H=720
//       PATCH=<snap-relative file>=<replacement>[,...]   e.g. PATCH=js/cockpit.js=devtests/track-audit/perception/patched/cockpit.js
//       CFG=<json>  window.PERC_CFG for patched/cockpit.js (see patched/make.js), e.g. CFG={"fovMin":50,"fovMax":54}
//       SCN=<json>  window.PERC_SCN for patched/scenery.js (set before the track loads), e.g. SCN={"bankFence":8}
//       DUMP=1   also write out/<track>-samples.json (s, y, grade, bank, curvature, lat, lon per sample)
// Shot: { n: name, at: [lat, lon] | i: sample | s: metres along the lap | f: lap fraction,
//         lead: metres driven before the target (default 450; 0 = standing still at the target),
//         scale: pace on the racing line (default 1), ext: optional free camera {up, side, behind, ahead, fov} }
// Output: out/<track>-<n><TAG>.png, one JSON line per shot on stdout and in out/<track><TAG>.jsonl.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const HERE = __dirname, ROOT = path.resolve(HERE, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'perception');
const SNAP = path.join(HERE, 'snap'), OUT = path.join(HERE, 'out');
const TRACK = process.env.TRACK || 'be-1925';
let PLAN = [];
try { const p = process.env.PLAN || '[]'; PLAN = JSON.parse((fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : p).replace(/^﻿/, '')); }
catch (e) { console.log('PLAN: ' + e.message); process.exit(1); }
setTimeout(() => { console.log('watchdog: harness took too long'); app.exit(2); }, +(process.env.LIMIT || 600000)).unref();
const TAG = process.env.TAG || '';
const W = +(process.env.W || 1280), H = +(process.env.H || 720);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);

// ---- the page: the snapshot's index.html, its script tags pointing at replacements where PATCH says so
function pageFile() {
  let html = fs.readFileSync(path.join(SNAP, 'index.html'), 'utf8');
  (process.env.PATCH || '').split(',').map(s => s.trim()).filter(Boolean).forEach(spec => {
    const k = spec.indexOf('='), rel = spec.slice(0, k).replace(/\\/g, '/'), file = path.resolve(ROOT, spec.slice(k + 1));
    const tag = '<script src="' + rel + '"></script>';
    if (html.indexOf(tag) < 0) throw new Error('PATCH: no script tag for ' + rel);
    if (!fs.existsSync(file)) throw new Error('PATCH: replacement not found: ' + file);
    html = html.replace(tag, '<script src="' + url.pathToFileURL(file).href + '"></script>');
  });
  const f = path.join(OUT, 'page-' + process.pid + '.html');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(f, html.replace('<head>', '<head><base href="' + url.pathToFileURL(SNAP + path.sep).href + '">'));
  process.on('exit', () => { try { fs.unlinkSync(f); } catch (e) {} });
  return f;
}

const AUTOPILOT = fs.readFileSync(path.join(ROOT, 'devtests', 'gp-e2e', 'autopilot.js'), 'utf8');
const LIB = `(function () {
  var D = 180 / Math.PI;
  var P = window.__p = { hold: false, armed: false, drive: false, target: -1, t: 0, ap: null, at: null, steps: 0 };
  function tr() { return F1.game.track; }
  function wq(q) { var n = tr().samples.length; return ((q % n) + n) % n; }
  P.index = function (q) {
    var T = tr(), n = T.samples.length, ds = T.length / n, i;
    if (q.at) { var g = F1.game.trackData.geo; i = T.nearest((q.at[1] - g.lon0) * g.kx, (q.at[0] - g.lat0) * g.kz).index; }
    else if (q.s !== undefined) i = Math.round(q.s / ds);
    else if (q.f !== undefined) i = Math.round(q.f * n);
    else i = q.i || 0;
    return wq(i);
  };
  P.hook = function () {
    var car = F1.game.car;
    if (car.__p) return true;
    car.__p = true;
    var orig = car.update;
    car.update = function (dt, input, track) {
      if (!input) return orig.call(car, dt, input, track);
      if (P.hold) return;
      if (P.drive && P.ap) {
        P.t += dt;
        var o = P.ap.step({ t: P.t, st: car.state, track: track, line: F1.game.raceLine, locked: false, others: [] });
        input = { up: false, down: false, left: false, right: false, throttle: o.throttle, brake: o.brake, steerAxis: o.steer, boost: false, limiter: false };
      }
      orig.call(car, dt, input, track);
      P.steps++;
      if (P.armed) {
        var n = track.samples.length, gap = ((P.target - car.state.sampleIndex) % n + n) % n;
        if (gap === 0 || gap > n / 2) { P.hold = true; P.armed = false; }
      }
    };
    return true;
  };
  // drive from lead metres before the target at the racing line's speed there; freeze on arrival
  P.go = function (q) {
    P.q = q;
    var T = tr(), S = T.samples, n = S.length, ds = T.length / n, car = F1.game.car, L = F1.game.raceLine;
    var tgt = P.index(q), lead = q.lead === undefined ? 450 : q.lead, i0 = wq(tgt - Math.round(lead / ds));
    P.hold = false; P.armed = false; P.drive = false;
    car.reset(T, i0);
    if (lead > 0) {
      var lp = L.points[i0];
      if (lp && typeof lp.d === 'number') { car.state.x = S[i0].x + S[i0].nx * lp.d; car.state.z = S[i0].z + S[i0].nz * lp.d; car.update(1e-4, null, T); }
      car.state.speed = (q.scale || 1) * (lp && lp.speed ? lp.speed : 30);
      P.ap = window.createAutopilot(); P.ap.cfg = { mode: 'line', scale: q.scale || 1 }; P.t = 0;
      P.target = tgt; P.armed = true; P.drive = true;
    } else { P.target = tgt; P.hold = false; }
    return { from: i0, target: tgt };
  };
  // what is on the screen now: the car on its sample, the camera in the world, the road ahead projected
  P.measure = function () {
    var T = tr(), S = T.samples, n = S.length, ds = T.length / n, car = F1.game.car, st = car.state, cam = F1.game.camera, i = st.sampleIndex, s = S[i];
    cam.updateMatrixWorld(true);
    var THREE = window.THREE, pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    cam.matrixWorld.decompose(pos, q, sc);
    var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q), right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    var viewPitch = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * D;
    var viewRoll = Math.atan2(right.y, up.y) * D;     // + = the image is rotated clockwise (right side of the view lower)
    function scr(x, y, z) { var v = new THREE.Vector3(x, y, z).project(cam); return { x: Math.round((v.x + 1) / 2 * innerWidth), y: Math.round((1 - v.y) / 2 * innerHeight), front: v.z < 1 && v.z > -1 }; }
    var hz = Math.hypot(fwd.x, fwd.z) || 1, hx = fwd.x / hz, hzz = fwd.z / hz;
    var horizon = scr(pos.x + hx * 3000, pos.y, pos.z + hzz * 3000);
    var ahead = [], groundY = T.groundY ? T.groundY(pos.x, pos.z) : s.y;
    [10, 25, 50, 75, 100, 150, 200, 300].forEach(function (d) {
      var k = (i + Math.round(d / ds)) % n, a = S[k], p = scr(a.x, a.y, a.z);
      ahead.push({ d: d, dy: +(a.y - pos.y).toFixed(2), grade: +(a.grade * 100).toFixed(1), bank: +(a.bank * D).toFixed(1), sx: p.x, sy: p.y, front: p.front });
    });
    // q.marks: absolute lap positions (m) projected on the screen (centreline and both edges): apparent size of a hill
    var marks = (P.q && P.q.marks || []).map(function (sm) {
      var k = Math.round(sm / ds) % n, a = S[k], hw = a.halfW || 6, c = scr(a.x, a.y, a.z);
      var l = scr(a.x + a.nx * hw, T.surfaceY ? T.surfaceY(k, hw) : a.y, a.z + a.nz * hw), r = scr(a.x - a.nx * hw, T.surfaceY ? T.surfaceY(k, -hw) : a.y, a.z - a.nz * hw);
      return { s: sm, dy: +(a.y - pos.y).toFixed(2), dist: Math.round(Math.hypot(a.x - pos.x, a.z - pos.z)), sx: c.x, sy: c.y, front: c.front, edgeA: [l.x, l.y], edgeB: [r.x, r.y] };
    });
    var gmax = -1e9, gmin = 1e9, bmax = 0;
    for (var k = -50; k <= 150; k++) { var a = S[(i + k + n) % n]; if (a.grade > gmax) gmax = a.grade; if (a.grade < gmin) gmin = a.grade; if (Math.abs(a.bank) > Math.abs(bmax)) bmax = a.bank; }
    return { i: i, s: Math.round(s.s), y: +s.y.toFixed(2), gradePct: +(s.grade * 100).toFixed(1), bankDeg: +(s.bank * D).toFixed(2), d: +st.d.toFixed(2),
      kmh: Math.round(st.speed * 3.6), carPitch: +(st.pitch * D).toFixed(2), carRoll: +(st.roll * D).toFixed(2),
      camFov: +cam.fov.toFixed(1), camHFov: +(2 * Math.atan(Math.tan(cam.fov / 2 / D) * cam.aspect) * D).toFixed(1),
      camH: +(pos.y - groundY).toFixed(2), viewPitch: +viewPitch.toFixed(2), viewRoll: +viewRoll.toFixed(2),
      horizonY: horizon.y, horizonFront: horizon.front, H: innerHeight, pxPerDegCentre: +((innerHeight / 2) / Math.tan(cam.fov / 2 / D) / D).toFixed(2),
      win: { gradeMinPct: +(gmin * 100).toFixed(1), gradeMaxPct: +(gmax * 100).toFixed(1), bankMaxDeg: +(bmax * D).toFixed(1) },
      ahead: ahead, perc: window.__perc || null, cfg: window.PERC_CFG || null, marks: marks };
  };
  P.dump = function () {
    var T = tr(), S = T.samples, g = F1.game.trackData.geo, out = { length: T.length, n: S.length, s: [], y: [], grade: [], bank: [], curv: [], lat: [], lon: [], halfW: [] };
    for (var k = 0; k < S.length; k++) {
      var a = S[k], b = S[(k + 1) % S.length], c = S[(k - 1 + S.length) % S.length];
      var h1 = Math.atan2(b.tx, b.tz), h0 = Math.atan2(c.tx, c.tz), dh = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
      out.s.push(Math.round(a.s)); out.y.push(+a.y.toFixed(2)); out.grade.push(+(a.grade * 100).toFixed(2)); out.bank.push(+(a.bank * D).toFixed(2));
      out.curv.push(+(dh / Math.max(0.1, Math.hypot(b.x - c.x, b.z - c.z))).toFixed(5));
      out.lat.push(+(g.lat0 + a.z / g.kz).toFixed(6)); out.lon.push(+(g.lon0 + a.x / g.kx).toFixed(6)); out.halfW.push(+(a.halfW || 0).toFixed(2));
    }
    return out;
  };
  // free camera (scene overview) - the cockpit rig hidden
  var hidden = [];
  P.ext = function (q) {
    var T = tr(), S = T.samples, n = S.length, ds = T.length / n, i = P.index(q), e = q.ext, cam = F1.game.camera, sc = T.group;
    while (sc.parent) sc = sc.parent;
    if (!P.rig) P.rig = cam.parent;
    sc.children.forEach(function (o) { if ((o.name === 'cockpit' || o === P.rig) && o.visible) { o.visible = false; hidden.push(o); } });
    sc.add(cam);
    var ib = wq(i - Math.round((e.behind || 0) / ds)), b = S[ib], a = S[wq(i + Math.round((e.ahead || 0) / ds))];
    cam.up.set(0, 1, 0); cam.fov = e.fov || 60; cam.aspect = innerWidth / innerHeight;
    var cx = b.x + b.nx * (e.side || 0), cz = b.z + b.nz * (e.side || 0);
    cam.position.set(cx, Math.max(T.surfaceY(ib, e.side || 0), T.groundY(cx, cz)) + (e.up || 2), cz);
    cam.lookAt(a.x + a.nx * (e.lookSide || 0), a.y + (e.lookUp || 0), a.z + a.nz * (e.lookSide || 0));
    cam.far = 4000; cam.updateProjectionMatrix();
    window.dispatchEvent(new Event('resize'));       // main.js renders once on resize while paused
    return { i: i };
  };
  P.restore = function () {
    hidden.forEach(function (o) { o.visible = true; }); hidden = [];
    var cam = F1.game.camera;
    if (P.rig && cam.parent !== P.rig) { P.rig.add(cam); cam.up.set(0, 1, 0); cam.position.set(0, 0.8, -0.35); cam.rotation.set(0, Math.PI, 0); cam.fov = 70; cam.updateProjectionMatrix(); }
    return true;
  };
  return true;
})()`;

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && String(msg).indexOf('Electron Security') < 0) console.log('[console]', String(msg).slice(0, 300)); });
  const js = code => w.webContents.executeJavaScript(code);
  const until = async (code, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js('!!(' + code + ')')) return true; await sleep(40); } return false; };
  const key = async k => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(50); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(200); };
  const log = path.join(OUT, TRACK + TAG + '.jsonl');
  try {
    await w.loadFile(pageFile());
    await sleep(1000);
    const err = await js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
    if (err) console.log('error overlay: ' + err.slice(0, 400));
    await js(AUTOPILOT + '\n;true');
    await js(LIB);
    if (process.env.SCN) await js('window.PERC_SCN = ' + process.env.SCN + '; true');
    const clicked = await js(`(function () { var i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(TRACK)}; });
      var c = document.querySelector('.card[data-i="' + i + '"]');
      if (!c) { var cs = [].slice.call(document.querySelectorAll('.card')); c = cs.filter(function (n) { return n.textContent.indexOf(F1_TRACKS[i].name) >= 0; })[0]; }
      if (!c) return false; c.click(); return true; })()`);
    const ok = clicked && await until(`F1.game && F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(TRACK)} && F1.game.raceLine`, 40000);
    if (!ok) { console.log('track did not load'); app.exit(1); return; }
    await js('__p.hook()');
    if (process.env.CFG) await js('window.PERC_CFG = ' + process.env.CFG + '; true');
    if (process.env.DUMP) {
      fs.writeFileSync(path.join(OUT, TRACK + '-samples.json'), J(await js('__p.dump()')));
      console.log('dumped samples');
    }
    for (const q of PLAN) {
      let r;
      if (q.ext) {
        if (await js('F1.game.running')) { await key('Escape'); await until('!F1.game.running', 3000); }
        await js(`document.getElementById('menu').classList.add('hidden'); true`);
        r = await js(`__p.ext(${J(q)})`);
        await sleep(400);
      } else {
        if (!(await js('F1.game.running'))) { await js('__p.restore()'); await key('Escape'); await until('F1.game.running', 3000); }
        const g = await js(`__p.go(${J(q)})`);
        if (q.lead === 0) { await sleep(900); }
        else {
          const arrived = await until('__p.hold', 60000);
          if (!arrived) { console.log(q.n + ': did not arrive ' + J(g)); continue; }
          await sleep(160);            // two frames of the frozen state on the screen
        }
        r = await js('__p.measure()');
      }
      const file = path.join(OUT, TRACK + '-' + q.n + TAG + '.png');
      fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
      const line = J(Object.assign({ track: TRACK, n: q.n, tag: TAG }, r));
      console.log(line);
      fs.appendFileSync(log, line + '\n');
    }
  } catch (e) { console.log('harness error: ' + (e && e.stack || e)); }
  app.exit(0);
});
