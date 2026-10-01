// npx electron devtests/review-final/world/shots.js      env TRACKS=id,id,...  W=1280 H=720
// Final-review visual spot check: the real game (index.html, offscreen, muted) on every listed track; 15 views per track
// saved as devtests/review-final/world/out/<id>-<view>.png and one contact sheet <id>-sheet.png (3 x 5 tiles).
// Views: start (30 m before the line, racing line on), c1..c6 (cockpit on the centreline at lap fractions), far / approach /
// lane / box1 / exit / across (the pit lane), pittop (pit complex from above, scenery on), top (the whole track from above).
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'review-final-world');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const OUT = path.join(__dirname, 'out');
const ALL = ['pt-1972', 'it-1953', 'pt-2008', 'br-1977', 'it-1914', 'ar-1952', 'az-2016', 'es-1991', 'fr-1960', 'ca-1978', 'fr-1969',
  'es-2026', 'de-1932', 'hu-1986', 'us-1909', 'tr-2005', 'sa-2021', 'za-1961', 'qa-2004', 'us-2022', 'de-1927', 'at-1969', 'my-1999',
  'cn-2004', 'ru-2014', 'us-1956', 'ae-2009'];
const TRACKS = (process.env.TRACKS || ALL.join(',')).split(',').filter(Boolean);
const W = +(process.env.W || 1280), H = +(process.env.H || 720);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);

const LIB = `(function () {
  var hidden = [], fog = null;
  var p = window.__r = {
    tr: function () { return F1.game.track; },
    wq: function (q) { var n = p.tr().samples.length; return ((q % n) + n) % n; },
    hideError: function () { var e = document.getElementById('error'); if (e) e.classList.add('hidden'); return true; },
    info: function (i, d) {
      var s = p.tr().samples[i], car = F1.game.car;
      return { i: i, s: Math.round(s.s), y: +s.y.toFixed(2), bankDeg: +(s.bank * 180 / Math.PI).toFixed(1), gradePct: +(s.grade * 100).toFixed(1),
        d: +(d || 0).toFixed(2), hit: car.state.hit, halfW: +s.halfW.toFixed(1), wP: +s.wallPosDist.toFixed(1), wN: +s.wallNegDist.toFixed(1), grass: car.state.onGrass };
    },
    place: function (x, z, heading) {
      var car = F1.game.car, tr = p.tr();
      car.reset(tr, tr.locate(x, z, -1).index);
      car.state.x = x; car.state.z = z; car.state.heading = heading;
      car.update(1e-4, null, tr);
      car.state.speed = 0;
      return p.info(car.state.sampleIndex, car.state.d);
    },
    atSample: function (i, d) {
      var tr = p.tr(), s = tr.samples[i];
      return p.place(s.x + s.nx * (d || 0), s.z + s.nz * (d || 0), Math.atan2(s.tx, s.tz));
    },
    k: function (i) { return p.wq(i - p.tr().pit.from); },
    lane: function (k, dOff, turn) {
      var tr = p.tr(), S = tr.samples, pit = tr.pit, i = p.wq(pit.from + k), s = S[i];
      var d = pit.laneD(i) + pit.side * (dOff || 0);
      var a = S[p.wq(i - 1)], b = S[p.wq(i + 1)], da = pit.laneD(p.wq(i - 1)), db = pit.laneD(p.wq(i + 1));
      if (!isFinite(da)) da = d; if (!isFinite(db)) db = d;
      var hx = (b.x + b.nx * db) - (a.x + a.nx * da), hz = (b.z + b.nz * db) - (a.z + a.nz * da);
      return p.place(s.x + s.nx * d, s.z + s.nz * d, Math.atan2(hx, hz) + (turn || 0) * pit.side);
    },
    pitInfo: function () {
      var tr = p.tr(), pit = tr.pit, n = tr.samples.length, ds = tr.length / n;
      if (!pit) return null;
      var rel = function (i) { return Math.round((i > n / 2 ? i - n : i) * ds); };
      var bx = pit.boxes.map(function (b) { return Math.round(b.index > n / 2 ? (b.index - n) * ds : b.index * ds); });
      return { side: pit.side, limit: pit.limitKmh, from: rel(pit.from), entry: rel(pit.entry), exit: rel(pit.exit), to: rel(pit.to),
        K: p.k(pit.to), kEn: p.k(pit.entry), kEx: p.k(pit.exit), box1: bx[0], box16: bx[15], lh: pit.laneHalfW };
    },
    scene: function () { var o = p.tr().group; while (o.parent) o = o.parent; return o; },
    lineOn: function (on) { var rl = F1.game.raceLine; if (rl && rl.group.visible !== on) { var e = new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', bubbles: true }); window.dispatchEvent(e); } return rl ? rl.group.visible : null; },
    // a free camera straight down (game stopped: menu open, hidden)
    above: function (cx, cz, halfAlong, halfAcross, ux, uz, yTop) {
      var cam = F1.game.camera, scene = p.scene();
      if (!p.rig) p.rig = cam.parent;
      scene.children.forEach(function (o) { if ((o.name === 'cockpit' || o === p.rig) && o.visible) { o.visible = false; hidden.push(o); } });
      scene.add(cam);
      if (scene.fog) { fog = scene.fog; scene.fog = null; }
      cam.fov = 40; cam.aspect = innerWidth / innerHeight;
      var t = Math.tan(cam.fov * Math.PI / 360), hgt = Math.max(halfAlong / (t * cam.aspect), halfAcross / t) * 1.05;
      cam.position.set(cx, yTop + hgt, cz);
      cam.up.set(-uz, 0, ux);
      cam.lookAt(cx, yTop, cz);
      cam.near = 1; cam.far = Math.max(4000, hgt * 3);
      cam.updateProjectionMatrix();
      window.dispatchEvent(new Event('resize'));
      return { height: Math.round(hgt) };
    },
    abovePit: function () {
      var tr = p.tr(), S = tr.samples, pit = tr.pit, k0 = -10, k1 = p.k(pit.to) + 10;
      var a = S[p.wq(pit.from + k0)], b = S[p.wq(pit.from + k1)], ang = Math.atan2(b.z - a.z, b.x - a.x);
      var ux = Math.cos(ang), uz = Math.sin(ang), minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y = -Infinity;
      for (var k = k0; k <= k1; k++) {
        var s = S[p.wq(pit.from + k)];
        [-s.wallNegDist, s.wallPosDist].forEach(function (d) {
          var x = s.x + s.nx * d, z = s.z + s.nz * d;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        });
        y = Math.max(y, s.y || 0);
      }
      var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, along = 0, across = 0;
      for (k = k0; k <= k1; k++) {
        s = S[p.wq(pit.from + k)];
        [-s.wallNegDist, s.wallPosDist].forEach(function (d) {
          var x = s.x + s.nx * d - cx, z = s.z + s.nz * d - cz;
          along = Math.max(along, Math.abs(x * ux + z * uz)); across = Math.max(across, Math.abs(-x * uz + z * ux));
        });
      }
      return p.above(cx, cz, along + 10, across + 10, ux, uz, y);
    },
    aboveAll: function () {
      var S = p.tr().samples, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y = -Infinity;
      for (var i = 0; i < S.length; i++) { minX = Math.min(minX, S[i].x); maxX = Math.max(maxX, S[i].x); minZ = Math.min(minZ, S[i].z); maxZ = Math.max(maxZ, S[i].z); y = Math.max(y, S[i].y); }
      var w = (maxX - minX) / 2 + 60, h = (maxZ - minZ) / 2 + 60;
      if (w >= h) return p.above((minX + maxX) / 2, (minZ + maxZ) / 2, w, h, 1, 0, y);
      return p.above((minX + maxX) / 2, (minZ + maxZ) / 2, h, w, 0, 1, y);
    },
    restore: function () {
      hidden.forEach(function (o) { o.visible = true; }); hidden = [];
      var cam = F1.game.camera, scene = p.scene();
      if (fog) { scene.fog = fog; fog = null; }
      if (p.rig && cam.parent !== p.rig) { p.rig.add(cam); cam.up.set(0, 1, 0); cam.position.set(0, 0, 0); cam.rotation.set(0, 0, 0); cam.fov = 70; cam.near = 0.1; cam.far = 4000; cam.updateProjectionMatrix(); }
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
    if (level < 2 || msg.indexOf('Electron Security') >= 0) return;
    errors.push(msg); console.log('[console]', String(msg).slice(0, 300), (src || '').split('/').pop() + ':' + line);
  });
  const js = code => w.webContents.executeJavaScript(code);
  const until = async (code, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js('!!(' + code + ')')) return true; await sleep(50); } return false; };
  const key = async k => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(50); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(200); };
  const shot = async (n) => { await sleep(500); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  const report = {};
  try {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1000);
    await js(LIB); await js('__r.hideError()');
    for (const id of TRACKS) {
      const t0 = Date.now();
      const clicked = await js(`(function () { var i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; });
        var c = document.querySelector('.card[data-i="' + i + '"]');
        if (!c) { var cs = [].slice.call(document.querySelectorAll('.card')); c = cs.filter(function (n) { return n.textContent.indexOf(F1_TRACKS[i].name) >= 0; })[0]; }
        if (!c) return false; c.click(); return true; })()`);
      const ok = clicked && await until(`F1.game && F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)}`, 30000);
      if (!ok) { console.log('FAIL ' + id + ': the track did not load'); report[id] = { fail: 'load' }; await key('Escape'); continue; }
      await js(`F1.ui && F1.ui.toast && F1.ui.toast(''); true`);
      const pit = await js('__r.pitInfo()');
      const N = await js('F1.game.track.samples.length');
      const rep = { pit, N, views: {} };
      const views = [];
      views.push(['start', `__r.atSample(__r.wq(-15), 0)`, true]);
      [0.08, 0.25, 0.42, 0.58, 0.75, 0.92].forEach((f, q) => views.push(['c' + (q + 1), `__r.atSample(Math.round(${f} * ${N}), 0)`, true]));
      if (pit) {
        const kEn = pit.kEn, kEx = pit.kEx;
        views.push(['far', kEn - 110 >= 0 ? `__r.lane(${kEn} - 110, 0)` : `__r.atSample(__r.wq(F1.game.track.pit.entry - 110), 0)`, false]);
        views.push(['approach', `__r.lane(${kEn} - 25, 0)`, false]);
        views.push(['lane', `(function () { var b = F1.game.track.pit.boxes[9]; return __r.lane(__r.k(b.index) - 6, 0, 0.45); })()`, false]);
        views.push(['box1', `(function () { var b = F1.game.track.pit.boxes[0]; return __r.place(b.x, b.z, b.heading); })()`, false]);
        views.push(['exit', `__r.lane(${kEx} - 20, 0)`, false]);
        views.push(['across', `(function () { var tr = F1.game.track, pit = tr.pit, i = pit.exit, s = tr.samples[i], d = -pit.side * (s.halfW - 1);
                 return __r.place(s.x + s.nx * d, s.z + s.nz * d, Math.atan2(s.nx * pit.side, s.nz * pit.side) - pit.side * 0.35); })()`, false]);
      }
      for (const [n, code, line] of views) {
        await js(`__r.lineOn(${line})`);
        const r = await js(code);
        await js('__r.hideError()');
        await shot(id + '-' + n);
        rep.views[n] = r;
      }
      // from above: game stopped (menu), menu hidden, free camera, the window's resize render
      await key('Escape');
      await until('!F1.game.running', 3000);
      await js(`document.getElementById('menu').classList.add('hidden'); var t = document.getElementById('hud-toast'); if (t) t.classList.add('hidden'); true`);
      if (pit) { rep.views.pittop = await js('__r.abovePit()'); await shot(id + '-pittop'); await js('__r.restore()'); await sleep(100); }
      rep.views.top = await js('__r.aboveAll()'); await shot(id + '-top'); await js('__r.restore()');
      await js(`document.getElementById('menu').classList.remove('hidden'); true`);
      report[id] = rep;
      console.log(id + ' ' + Math.round((Date.now() - t0) / 1000) + ' s  pit ' + J(pit));
      for (const n of Object.keys(rep.views)) console.log('   ' + n.padEnd(9) + J(rep.views[n]));
    }
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
    // contact sheets
    const sheet = new BrowserWindow({ width: 1920, height: 1800, show: false, useContentSize: true, webPreferences: { offscreen: true } });
    const names = ['start', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'far', 'approach', 'lane', 'box1', 'exit', 'across', 'pittop', 'top'];
    for (const id of TRACKS) {
      if (!report[id] || report[id].fail) continue;
      const tiles = names.map(n => {
        const f = path.join(OUT, id + '-' + n + '.png');
        const b64 = fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : '';
        return `<div class="t"><img src="data:image/png;base64,${b64}"><span>${id} ${n}</span></div>`;
      }).join('');
      const html = `<!doctype html><html><head><style>body{margin:0;overflow:hidden;background:#222;width:1920px;height:1800px;display:grid;grid-template-columns:repeat(3,640px);grid-auto-rows:360px}
        .t{position:relative;width:640px;height:360px}.t img{width:640px;height:360px;display:block}.t span{position:absolute;left:4px;top:2px;color:#ff0;font:bold 16px monospace;text-shadow:0 0 3px #000}</style></head><body>${tiles}</body></html>`;
      await sheet.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      await sleep(900);
      fs.writeFileSync(path.join(OUT, id + '-sheet.png'), (await sheet.webContents.capturePage()).toPNG());
    }
    sheet.destroy();
  } catch (e) { console.log('harness error: ' + (e && e.stack || e)); }
  if (errors.length) console.log('console errors: ' + errors.length);
  console.log('done, pictures in ' + OUT);
  app.exit(0);
});
