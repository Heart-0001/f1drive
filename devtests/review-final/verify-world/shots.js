// Copy of devtests/track-fix/shots.js for the W2 verification (output in ./out), plus an abs camera: {abs:1, i, d, j, dj, up, lookUp}.
// npx electron devtests/track-fix/shots.js      env TRACK=<id>  SHOTS='<json array>'  W=1280 H=720
// The real game (index.html, offscreen), the car standing on the track, the view from the cockpit (game running).
// Shot: { n: name, at: [lat, lon] | f: lap fraction | i: sample index, back: metres before that point (default 0),
//         d: lateral offset (+ = left), ext: optional {up, side, behind, ahead} = a free camera instead of the cockpit
//         (metres above / to the left / behind the point, looking at the point `ahead` metres further on) }
// Output: devtests/track-fix/out/<track>-<n>.png, and one line of JSON per shot (sample, s, y, bank, grade).
// env DATA=<another tracks-data.js>: that file's entry for TRACK replaces the loaded one before the track is chosen
// (before / after pictures without touching the project's tracks-data.js); TAG=<suffix> is added to the file names.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'verify-world');
const OUT = path.join(__dirname, 'out');
const TRACK = process.env.TRACK || 'nl-1948';
const SHOTS = JSON.parse(process.env.SHOTS || '[]');
const DATA = process.env.DATA || '', TAG = process.env.TAG || '';
const W = +(process.env.W || 1280), H = +(process.env.H || 720);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const LIB = `(function () {
  var hidden = [];
  var p = window.__t = {
    tr: function () { return F1.game.track; },
    wq: function (q) { var n = p.tr().samples.length; return ((q % n) + n) % n; },
    hideError: function () { var e = document.getElementById('error'); if (e) e.classList.add('hidden'); return true; },
    index: function (q) {
      var tr = p.tr(), n = tr.samples.length, ds = tr.length / n, i;
      if (q.at) { var g = F1.game.trackData.geo; i = tr.nearest((q.at[1] - g.lon0) * g.kx, (q.at[0] - g.lat0) * g.kz).index; }
      else if (q.f !== undefined) i = Math.round(q.f * n);
      else i = q.i || 0;
      return p.wq(i - Math.round((q.back || 0) / ds));
    },
    info: function (i, d) {
      var s = p.tr().samples[i];
      return { i: i, s: Math.round(s.s), y: +s.y.toFixed(2), bankDeg: +(s.bank * 180 / Math.PI).toFixed(2), gradePct: +(s.grade * 100).toFixed(1), d: d || 0 };
    },
    cockpit: function (q) {
      var tr = p.tr(), car = F1.game.car, i = p.index(q), s = tr.samples[i];
      p.restore();
      car.reset(tr, i);
      if (q.d) { car.state.x = s.x + s.nx * q.d; car.state.z = s.z + s.nz * q.d; car.update(1e-4, null, tr); car.state.speed = 0; }
      var r = p.info(i, q.d); r.roll = +(car.state.roll * 180 / Math.PI).toFixed(2); r.pitch = +(car.state.pitch * 180 / Math.PI).toFixed(2);
      return r;
    },
    scene: function () { var o = p.tr().group; while (o.parent) o = o.parent; return o; },
    ext: function (q) {
      var tr = p.tr(), S = tr.samples, n = S.length, ds = tr.length / n, i = p.index(q), s = S[i], e = q.ext, cam = F1.game.camera, scene = p.scene();
      if (!p.rig) p.rig = cam.parent;
      scene.children.forEach(function (o) { if ((o.name === 'cockpit' || o === p.rig) && o.visible) { o.visible = false; hidden.push(o); } });
      scene.add(cam);
      var b = S[p.wq(i - Math.round((e.behind || 0) / ds))], a = S[p.wq(i + Math.round((e.ahead || 0) / ds))];
      cam.up.set(0, 1, 0); cam.fov = e.fov || 60; cam.aspect = innerWidth / innerHeight;
      cam.position.set(b.x + b.nx * (e.side || 0), tr.surfaceY(p.wq(i - Math.round((e.behind || 0) / ds)), e.side || 0) + (e.up || 2), b.z + b.nz * (e.side || 0));
      cam.lookAt(a.x + a.nx * (e.lookSide || 0), a.y + (e.lookUp || 0), a.z + a.nz * (e.lookSide || 0));
      cam.far = 4000; cam.updateProjectionMatrix();
      window.dispatchEvent(new Event('resize'));
      return p.info(i, 0);
    },
    abs: function (q) {
      var tr = p.tr(), S = tr.samples, cam = F1.game.camera, scene = p.scene(), a = S[q.i], b = S[q.j];
      if (!p.rig) p.rig = cam.parent;
      scene.children.forEach(function (o) { if ((o.name === 'cockpit' || o === p.rig) && o.visible) { o.visible = false; hidden.push(o); } });
      scene.add(cam);
      if (q.hide) scene.traverse(function (o) { if (q.hide.indexOf(o.name) >= 0 && o.visible) { o.visible = false; hidden.push(o); } });
      var cx = a.x + a.nx * (q.d || 0), cz = a.z + a.nz * (q.d || 0), tx = b.x + b.nx * (q.dj || 0), tz = b.z + b.nz * (q.dj || 0);
      cam.up.set(0, 1, 0); cam.fov = q.fov || 70; cam.aspect = innerWidth / innerHeight;
      cam.position.set(cx, tr.groundY(cx, cz) + (q.up || 1), cz);
      cam.lookAt(tx, tr.groundY(tx, tz) + (q.lookUp || 0), tz);
      cam.far = 4000; cam.updateProjectionMatrix(); window.dispatchEvent(new Event('resize'));
      return { cam: [cx, cam.position.y, cz].map(function (v) { return +v.toFixed(1); }), look: [tx, tz].map(function (v) { return +v.toFixed(1); }) };
    },
    restore: function () {
      hidden.forEach(function (o) { o.visible = true; }); hidden = [];
      var cam = F1.game.camera;
      if (p.rig && cam.parent !== p.rig) { p.rig.add(cam); cam.up.set(0, 1, 0); cam.position.set(0, 0, 0); cam.rotation.set(0, 0, 0); cam.fov = 70; cam.updateProjectionMatrix(); }
      return true;
    }
  };
  return true;
})()`;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false } });
  w.webContents.setFrameRate(30);
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Electron Security') < 0) console.log('[console]', String(msg).slice(0, 200)); });
  const js = code => w.webContents.executeJavaScript(code);
  const until = async (code, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js('!!(' + code + ')')) return true; await sleep(50); } return false; };
  const key = async k => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(50); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(200); };
  try {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1000);
    await js(LIB); await js('__t.hideError()');
    if (DATA) {
      const src = fs.readFileSync(DATA, 'utf8');
      const swapped = await js(`(function () { var w = {}; (new Function('window', ${J(src)}))(w);
        var o = w.F1_TRACKS.filter(function (t) { return t.id === ${J(TRACK)}; })[0], i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(TRACK)}; });
        if (!o || i < 0) return false; F1_TRACKS[i] = o; return true; })()`);
      console.log('data swapped from ' + DATA + ': ' + swapped);
    }
    const clicked = await js(`(function () { var i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(TRACK)}; });
      var c = document.querySelector('.card[data-i="' + i + '"]');
      if (!c) { var cs = [].slice.call(document.querySelectorAll('.card')); c = cs.filter(function (n) { return n.textContent.indexOf(F1_TRACKS[i].name) >= 0; })[0]; }
      if (!c) return false; c.click(); return true; })()`);
    const ok = clicked && await until(`F1.game && F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(TRACK)}`, 30000);
    if (!ok) { console.log('track did not load'); app.exit(1); return; }
    await js(`F1.ui && F1.ui.toast && F1.ui.toast(''); true`);
    for (const q of SHOTS) {
      let r;
      if (q.abs) {
        if (await js('F1.game.running')) { await key('Escape'); await until('!F1.game.running', 3000); }
        await js("document.getElementById('menu').classList.add('hidden'); var t = document.getElementById('hud-toast'); if (t) t.classList.add('hidden'); true");
        r = await js('__t.abs(' + J(q) + ')');
      } else if (q.ext) {
        if (await js('F1.game.running')) { await key('Escape'); await until('!F1.game.running', 3000); }
        await js(`document.getElementById('menu').classList.add('hidden'); var t = document.getElementById('hud-toast'); if (t) t.classList.add('hidden'); true`);
        r = await js(`__t.ext(${J(q)})`);
      } else {
        if (!(await js('F1.game.running'))) { await js(`__t.restore()`); await key('Escape'); await until('F1.game.running', 3000); }
        r = await js(`__t.cockpit(${J(q)})`);
      }
      await js('__t.hideError()'); await sleep(700);
      fs.writeFileSync(path.join(OUT, TRACK + '-' + q.n + TAG + '.png'), (await w.webContents.capturePage()).toPNG());
      console.log(TRACK + '-' + q.n + TAG + ' ' + J(r));
    }
  } catch (e) { console.log('harness error: ' + (e && e.stack || e)); }
  app.exit(0);
});
