// npx electron devtests/review-1/world/probe-shot.js   env TRACK=id  SHOTS='<json array>'
// Each shot: { n: name, i: sample, d: lateral, h: height above surface, li: look-at sample, ld: look-at lateral, lh: height,
//              hide: ['scenery-solid', ...] (mesh names to hide for this shot), fov }
// Output: devtests/review-1/world/out/probe-<track>-<name>.png ; prints the names of the scene meshes.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'review1-probe');
const OUT = path.join(__dirname, 'out');
const TRACK = process.env.TRACK || 'ca-1978';
const SHOTS = JSON.parse(process.env.SHOTS || '[]');
const W = +(process.env.W || 1280), H = +(process.env.H || 720);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const LIB = `(function () {
  var p = window.__q = {
    tr: function () { return F1.game.track; },
    wq: function (q) { var n = p.tr().samples.length; return ((q % n) + n) % n; },
    scene: function () { var o = p.tr().group; while (o.parent) o = o.parent; return o; },
    names: function () { var out = []; p.scene().traverse(function (o) { if (o.isMesh) out.push(o.name + ':' + (o.geometry.attributes.position ? o.geometry.attributes.position.count : 0)); }); return out; },
    pt: function (i, d, h) { var s = p.tr().samples[p.wq(i)]; return [s.x + s.nx * d, p.tr().surfaceY(p.wq(i), d) + h, s.z + s.nz * d]; },
    shot: function (q) {
      var cam = F1.game.camera, scene = p.scene();
      if (!p.rig) p.rig = cam.parent;
      scene.children.forEach(function (o) { if (o.name === 'cockpit' || o === p.rig) o.visible = false; });
      scene.add(cam);
      scene.traverse(function (o) { if (o.isMesh && o.name) o.visible = !(q.hide || []).some(function (h) { return o.name.indexOf(h) === 0; }); });
      var a = p.pt(q.i, q.d, q.h), b = p.pt(q.li === undefined ? q.i + 20 : q.li, q.ld || 0, q.lh || 1);
      cam.up.set(0, 1, 0); cam.fov = q.fov || 60; cam.aspect = innerWidth / innerHeight;
      cam.position.set(a[0], a[1], a[2]); cam.lookAt(b[0], b[1], b[2]); cam.far = 4000; cam.updateProjectionMatrix();
      window.dispatchEvent(new Event('resize'));
      return { cam: a, look: b };
    },
    hideError: function () { var e = document.getElementById('error'); if (e) e.classList.add('hidden'); return true; }
  };
  return true;
})()`;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false } });
  w.webContents.setFrameRate(30);
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Electron Security') < 0) console.log('[console]', msg.slice(0, 200)); });
  const js = code => w.webContents.executeJavaScript(code);
  const until = async (code, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js('!!(' + code + ')')) return true; await sleep(50); } return false; };
  const key = async k => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(50); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(200); };
  try {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1000);
    await js(LIB); await js('__q.hideError()');
    const clicked = await js(`(function () { var i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(TRACK)}; });
      var c = document.querySelector('.card[data-i="' + i + '"]'); if (!c) return false; c.click(); return true; })()`);
    const ok = clicked && await until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(TRACK)}`, 20000);
    if (!ok) { console.log('track did not load'); app.exit(1); return; }
    await key('Escape'); await until('!F1.game.running', 3000);
    await js(`document.getElementById('menu').classList.add('hidden'); document.getElementById('hud-toast').classList.add('hidden'); true`);
    console.log('meshes: ' + (await js('__q.names()')).join(' '));
    for (const q of SHOTS) {
      const r = await js(`__q.shot(${J(q)})`);
      await js('__q.hideError()'); await sleep(400);
      fs.writeFileSync(path.join(OUT, 'probe-' + TRACK + '-' + q.n + '.png'), (await w.webContents.capturePage()).toPNG());
      console.log(q.n + ' ' + J(r));
    }
  } catch (e) { console.log('harness error: ' + (e && e.stack || e)); }
  app.exit(0);
});
