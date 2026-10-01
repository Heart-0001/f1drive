// npx electron devtests/review-1/world/shots.js
//   env TRACKS=us-2012,at-1969,... (ids)   VIEWS=cockpit,ext,pit,top   W=1280 H=720   FR=0.03,0.17,...
// The REAL game (index.html, offscreen). The #error overlay (missing seasons-data / cars scripts, other agents' area) is
// hidden for the pictures. Per track:
//   c<k>     cockpit on the centreline at lap fraction FR[k], standing (game running)
//   e<k>     exterior: camera 28 m up, 45 m behind sample FR[k], looking 60 m ahead (game paused, cockpit hidden)
//   lane / approach / exit / garages: cockpit views in the pit lane
//   pittop   straight down over the whole pit complex, scenery shown
//   top      straight down over the whole circuit, scenery shown
// Output: devtests/review-1/world/out/<id>-<view>.png (+ 2x2 contact sheets <id>-sheetN.png)
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'review1-world');
const OUT = path.join(__dirname, 'out');
const TRACKS = (process.env.TRACKS || 'us-2012,at-1969').split(',').filter(Boolean);
const VIEWS = (process.env.VIEWS || 'cockpit,ext,pit,top').split(',').filter(Boolean);
const FR = (process.env.FR || '0.03,0.17,0.31,0.45,0.59,0.73,0.87').split(',').map(Number);
const EFR = (process.env.EFR || '0.1,0.35,0.6,0.85').split(',').map(Number);
const W = +(process.env.W || 1280), H = +(process.env.H || 720);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);

const PAGE_LIB = `(function () {
  var hidden = [];
  var p = window.__p = {
    tr: function () { return F1.game.track; },
    wq: function (q) { var n = p.tr().samples.length; return ((q % n) + n) % n; },
    hideError: function () { var e = document.getElementById('error'); if (e) e.classList.add('hidden'); return true; },
    place: function (q) {
      var car = F1.game.car, tr = p.tr();
      car.reset(tr, tr.locate(q.x, q.z, -1).index);
      car.state.x = q.x; car.state.z = q.z; car.state.heading = q.heading;
      car.update(1e-4, null, tr);
      car.state.speed = 0;
      return { i: car.state.sampleIndex, d: +car.state.d.toFixed(2), hit: car.state.hit, y: +car.state.y.toFixed(2) };
    },
    at: function (f) { var tr = p.tr(), i = p.wq(Math.round(f * tr.samples.length)); F1.game.car.reset(tr, i); return { i: i, y: +tr.samples[i].y.toFixed(1) }; },
    lane: function (k, dOff, turn) {
      var tr = p.tr(), S = tr.samples, pit = tr.pit, i = p.wq(pit.from + k), s = S[i];
      var d = pit.laneD(i) + pit.side * (dOff || 0);
      var a = S[p.wq(i - 1)], b = S[p.wq(i + 1)], da = pit.laneD(p.wq(i - 1)), db = pit.laneD(p.wq(i + 1));
      if (!isFinite(da)) da = d; if (!isFinite(db)) db = d;
      var hx = (b.x + b.nx * db) - (a.x + a.nx * da), hz = (b.z + b.nz * db) - (a.z + a.nz * da);
      return { x: s.x + s.nx * d, z: s.z + s.nz * d, heading: Math.atan2(hx, hz) + (turn || 0) * pit.side };
    },
    k: function (i) { return p.wq(i - p.tr().pit.from); },
    info: function () {
      var tr = p.tr(), pit = tr.pit, n = tr.samples.length, ds = tr.length / n;
      if (!pit) return null;
      var rel = function (i) { return Math.round((i > n / 2 ? i - n : i) * ds); };
      return { side: pit.side, limit: pit.limitKmh, from: rel(pit.from), entry: rel(pit.entry), exit: rel(pit.exit), to: rel(pit.to),
        K: p.k(pit.to), kEn: p.k(pit.entry), kEx: p.k(pit.exit) };
    },
    scene: function () { var o = p.tr().group; while (o.parent) o = o.parent; return o; },
    detach: function () {
      var cam = F1.game.camera, scene = p.scene();
      if (scene.fog && !p.fog) { p.fog = scene.fog; } scene.fog = null;
      if (!p.rig) p.rig = cam.parent;
      scene.children.forEach(function (o) { if (o.name === 'cockpit' || o === p.rig) { if (o.visible) { o.visible = false; hidden.push(o); } } });
      if (p.rig && p.rig.visible) { p.rig.visible = false; hidden.push(p.rig); }
      scene.add(cam);
      cam.up.set(0, 1, 0);
      return true;
    },
    render: function () { window.dispatchEvent(new Event('resize')); return true; },
    ext: function (f) {
      var tr = p.tr(), S = tr.samples, n = S.length, i = p.wq(Math.round(f * n)), s = S[i];
      var b = S[p.wq(i - 22)], a = S[p.wq(i + 30)], cam = F1.game.camera;
      p.detach();
      cam.fov = 60; cam.aspect = innerWidth / innerHeight;
      cam.position.set(b.x, s.y + 28, b.z);
      cam.lookAt(a.x, a.y + 2, a.z);
      cam.far = 4000; cam.updateProjectionMatrix();
      p.render();
      return { i: i, y: +s.y.toFixed(1) };
    },
    top: function () {
      var tr = p.tr(), S = tr.samples, cam = F1.game.camera;
      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y = -Infinity;
      S.forEach(function (s) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z); y = Math.max(y, s.y); });
      p.detach();
      var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, w = (maxX - minX) / 2 + 60, h = (maxZ - minZ) / 2 + 60;
      cam.fov = 40; cam.aspect = innerWidth / innerHeight;
      var t = Math.tan(cam.fov * Math.PI / 360), hgt = Math.max(w / (t * cam.aspect), h / t);
      cam.position.set(cx, y + hgt, cz);
      cam.up.set(0, 0, -1);
      cam.lookAt(cx, y, cz);
      cam.far = Math.max(4000, hgt * 2); cam.updateProjectionMatrix();
      p.render();
      return { height: Math.round(hgt) };
    },
    pittop: function () {
      var tr = p.tr(), S = tr.samples, pit = tr.pit, cam = F1.game.camera, K = p.k(pit.to);
      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y = -Infinity;
      for (var k = -10; k <= K + 10; k++) {
        var i = p.wq(pit.from + k), s = S[i];
        [-s.wallNegDist, s.wallPosDist].forEach(function (d) {
          var x = s.x + s.nx * d, z = s.z + s.nz * d;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        });
        y = Math.max(y, s.y || 0);
      }
      p.detach();
      var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      var a = S[p.wq(pit.from - 10)], b = S[p.wq(pit.from + K + 10)], ang = Math.atan2(b.z - a.z, b.x - a.x);
      var ux = Math.cos(ang), uz = Math.sin(ang), along = 0, across = 0;
      for (k = -10; k <= K + 10; k++) {
        s = S[p.wq(pit.from + k)];
        [-s.wallNegDist, s.wallPosDist].forEach(function (d) {
          var x = s.x + s.nx * d - cx, z = s.z + s.nz * d - cz;
          along = Math.max(along, Math.abs(x * ux + z * uz)); across = Math.max(across, Math.abs(-x * uz + z * ux));
        });
      }
      along += 8; across += 8;
      cam.fov = 40; cam.aspect = innerWidth / innerHeight;
      var t = Math.tan(cam.fov * Math.PI / 360), hgt = Math.max(along / (t * cam.aspect), across / t);
      cam.position.set(cx, y + hgt, cz);
      cam.up.set(-uz, 0, ux);
      cam.lookAt(cx, y, cz);
      cam.far = Math.max(4000, hgt * 2); cam.updateProjectionMatrix();
      p.render();
      return { height: Math.round(hgt) };
    },
    restore: function () {
      if (p.fog) { p.scene().fog = p.fog; }
      hidden.forEach(function (o) { o.visible = true; }); hidden = [];
      var cam = F1.game.camera;
      if (p.rig) p.rig.add(cam);
      cam.up.set(0, 1, 0); cam.position.set(0, 0, 0); cam.rotation.set(0, 0, 0); cam.fov = 70; cam.updateProjectionMatrix();
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
  const errors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    errors.push(msg); console.log('[console ' + level + ']', msg.slice(0, 300), (src || '').split('/').pop() + ':' + line);
  });
  const js = code => w.webContents.executeJavaScript(code);
  const shot = async n => { await js('__p.hideError()'); await sleep(400); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  const until = async (code, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js('!!(' + code + ')')) return true; await sleep(50); } return false; };
  const key = async k => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(50); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(200); };
  try {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1000);
    await js(PAGE_LIB);
    await js('__p.hideError()');
    for (const id of TRACKS) {
      const clicked = await js(`(function () {
        var i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; });
        var c = document.querySelector('.card[data-i="' + i + '"]');
        if (!c) { var cs = [].slice.call(document.querySelectorAll('.card')); c = cs.filter(function (n) { return n.textContent.indexOf(F1_TRACKS[i].name) >= 0; })[0]; }
        if (!c) return false; c.click(); return true; })()`);
      const ok = clicked && await until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)}`, 20000);
      if (!ok) { console.log('FAIL ' + id + ': the track did not load'); await key('Escape'); continue; }
      await js(`F1.ui.toast && F1.ui.toast(''); true`);
      const info = await js('__p.info()');
      console.log(id + ' pit ' + J(info));
      if (VIEWS.includes('cockpit')) {
        for (let k = 0; k < FR.length; k++) {
          const r = await js(`__p.at(${FR[k]})`);
          await sleep(250);
          await shot(id + '-c' + k);
          console.log('  c' + k + ' f=' + FR[k] + ' ' + J(r));
        }
      }
      if (VIEWS.includes('pit') && info) {
        const views = {
          approach: `__p.lane(${info.kEn} - 25, 0)`,
          entry: `__p.lane(${info.kEn} - 7, 0, 0.12)`,
          lane: `(function () { var b = F1.game.track.pit.boxes[9]; return __p.lane(__p.k(b.index) - 6, 0, 0.45); })()`,
          exit: `__p.lane(${info.kEx} - 20, 0)`,
          garages: `(function () { var b = F1.game.track.pit.boxes[3]; return __p.lane(__p.k(b.index) + 4, 0, 0.9); })()`
        };
        for (const v in views) {
          const r = await js(`__p.place(${views[v]})`);
          await sleep(250);
          await shot(id + '-' + v);
          console.log('  ' + v + ' ' + J(r));
        }
      }
      await key('Escape');
      await until('!F1.game.running', 3000);
      await js(`document.getElementById('menu').classList.add('hidden'); document.getElementById('hud-toast').classList.add('hidden'); true`);
      if (VIEWS.includes('ext')) {
        for (let k = 0; k < EFR.length; k++) {
          const r = await js(`__p.ext(${EFR[k]})`);
          await shot(id + '-e' + k);
          console.log('  e' + k + ' f=' + EFR[k] + ' ' + J(r));
        }
      }
      if (VIEWS.includes('top')) {
        if (info) { const r = await js('__p.pittop()'); await shot(id + '-pittop'); console.log('  pittop ' + J(r)); }
        const r2 = await js('__p.top()'); await shot(id + '-top'); console.log('  top ' + J(r2));
      }
      await js('__p.restore()');
      await js(`document.getElementById('menu').classList.remove('hidden'); true`);
    }
  } catch (e) {
    console.log('harness error: ' + (e && e.stack || e));
  }
  console.log('done; console errors: ' + errors.length);
  app.exit(0);
});
