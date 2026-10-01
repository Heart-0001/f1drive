// js/audio.js from inside an asar archive, the way the packaged game (electron-builder, app.asar) loads it: the page is
// file://.../x.asar/index.html, the AudioWorklet module comes from a Blob URL made there.
//   npx electron devtests/audio-test/asar-test.js        (exit code 1 when a check fails)
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');
const asar = require('@electron/asar');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'audio-asar');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('mute-audio');
ipcMain.handle('at-save', () => true);
const results = [];
function check(name, ok, detail) { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '   ' + JSON.stringify(detail) : '')); }

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f1drive-audio-asar-')), src = path.join(tmp, 'app'), pack = path.join(tmp, 'app.asar');
  try {
    fs.mkdirSync(path.join(src, 'js'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'js', 'audio.js'), path.join(src, 'js', 'audio.js'));
    ['scenes.js', 'live-page.js', 'preload.js'].forEach(f => fs.copyFileSync(path.join(__dirname, f), path.join(src, f)));
    fs.writeFileSync(path.join(src, 'index.html'), fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8').replace('../../js/audio.js', 'js/audio.js'));
    await asar.createPackage(src, pack);
    fs.rmSync(src, { recursive: true, force: true });                  // only the archive is left: nothing can come from the plain folder
    const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } });
    const warnings = [];
    w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Electron Security Warning') < 0) warnings.push(msg); });
    await w.loadFile(path.join(pack, 'index.html'));
    const r = await w.webContents.executeJavaScript(`(async function () {
      var out = { href: location.href };
      // offline: render a second of a car at 150 km/h flat out
      var ctx = new OfflineAudioContext(2, 48000, 48000), a = F1.createAudio({ context: ctx });
      out.offlineInit = await a.init(); out.offlineBackend = a.debug.backend;
      a.setActive(true);
      var st = { speed: 150 / 3.6, gear: 4, rpm: 9833.33, throttle: 1 };
      a.update(1 / 60, st, null, []);
      for (var i = 1; i < 60; i++) (function (j) { ctx.suspend(j / 60).then(function () { a.update(1 / 60, st, null, []); ctx.resume(); }); })(i);
      var d = (await ctx.startRendering()).getChannelData(0), s = 0;
      for (i = 24000; i < 48000; i++) s += d[i] * d[i];
      out.offlineRmsDb = 10 * Math.log10(s / 24000);
      a.dispose();
      // the real context
      var b = F1.createAudio();
      out.liveInit = await b.init({ force: true }); out.liveBackend = b.debug.backend; out.liveState = b.debug.context.state;
      b.dispose();
      return out;
    })()`);
    console.log(JSON.stringify(r));
    check('the page runs from inside the archive (' + r.href.slice(-40) + ')', /\.asar\/index\.html$/.test(r.href));
    check('OfflineAudioContext: the AudioWorklet module loads from a Blob URL made inside the asar page (' + r.offlineBackend + ') and sounds (' + r.offlineRmsDb.toFixed(1) + ' dBFS)', r.offlineInit && r.offlineBackend === 'worklet' && r.offlineRmsDb > -30);
    check('AudioContext: the same (' + r.liveBackend + ', ' + r.liveState + ')', r.liveInit && r.liveBackend === 'worklet');
    check('nothing on the console', warnings.length === 0, warnings.slice(0, 3));
  } catch (e) {
    check('harness ran to the end', false, e && e.stack ? e.stack : String(e));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(results.filter(Boolean).length + ' / ' + results.length + ' checks passed');
  app.exit(results.every(Boolean) ? 0 : 1);
});
