// Robustness of the real app entry (electron-main.js, offscreen, muted) when a platform feature is missing:
//   MODE=nowebgl    Chromium started with --disable-3d-apis (no WebGL at all): a readable overlay is expected
//   MODE=noaudio    window.AudioContext removed before the page's scripts run: the game must run silently
//   MODE=noworklet  AudioContext.prototype.audioWorklet removed: the 'nodes' fallback must be used
//   MODE=lose       WebGL context lost mid-drive (WEBGL_lose_context), restored 2 s later: does the picture come back?
//   npx electron devtests/review-final/perf/robust.js
'use strict';
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const electron = require('electron');
const { app } = electron;
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'review-robust');
const MODE = process.env.MODE || 'noaudio';
if (MODE === 'nowebgl-switch') app.commandLine.appendSwitch('disable-3d-apis');
const PRE = {
  nowebgl: '(function(){ var g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (k) { if (/webgl/i.test(k)) return null; return g.apply(this, arguments); }; })();',
  noaudio: 'delete window.AudioContext; delete window.webkitAudioContext; window.AudioContext = undefined;',
  noworklet: 'Object.defineProperty(BaseAudioContext.prototype, "audioWorklet", { get: function () { return undefined; } }); window.AudioWorkletNode = undefined;'
}[MODE] || '';
const RealBW = electron.BrowserWindow;
let win = null, preReady = Promise.resolve();
class OffscreenWindow extends RealBW {
  constructor(o) {
    o = Object.assign({}, o, { show: false, width: 1280, height: 720, useContentSize: true });
    o.webPreferences = Object.assign({}, o.webPreferences, { offscreen: true });
    super(o);
    win = this;
    if (PRE) {
      const d = this.webContents.debugger;
      d.attach('1.3');
      preReady = Promise.race([
        d.sendCommand('Page.enable').then(() => d.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PRE })).then(r => console.log('pre-script registered', JSON.stringify(r)), e => console.log('pre-script FAILED', e.message)),
        new Promise(r => setTimeout(() => { console.log('pre-script timeout'); r(); }, 20000))
      ]);
    }
  }
  maximize() {}
  setFullScreen() {}
  // loadFile is called right after the constructor: hold it until the pre-script is registered
  loadFile(...a) { if (PRE) super.loadURL('about:blank'); return preReady.then(() => super.loadFile(...a)); }
}
const load = Module._load;
Module._load = function (request) {
  if (request === 'electron') return new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? OffscreenWindow : t[k]) });
  return load.apply(this, arguments);
};
require(path.join(ROOT, 'electron-main.js'));
Module._load = load;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });

app.whenReady().then(async () => {
  const errors = [];
  for (let i = 0; i < 100 && !win; i++) await sleep(50);
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Electron Security Warning') < 0) errors.push(msg.slice(0, 300)); });
  win.webContents.on('render-process-gone', (e, d) => errors.push('RENDER PROCESS GONE ' + d.reason));
  await sleep(500);
  await new Promise(r => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', r); else r(); });
  await sleep(2500);
  const js = c => win.webContents.executeJavaScript(c);
  const shot = async n => fs.writeFileSync(path.join(OUT, n + '.png'), (await win.webContents.capturePage()).toPNG());
  const state = () => js(`({ overlay: document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent.slice(0, 400),
     game: !!(window.F1 && F1.game), running: !!(window.F1 && F1.game && F1.game.running), v: window.F1 && F1.game && F1.game.car ? F1.game.car.state.speed : null,
     audio: window.F1 && F1.audio ? { supported: F1.audio.supported, backend: F1.audio.debug.backend, ready: F1.audio.debug.ready, errors: F1.audio.debug.errors, last: String(F1.audio.debug.lastError || '').slice(0, 200), state: F1.audio.debug.context && F1.audio.debug.context.state } : null,
     menu: !document.getElementById('menu').classList.contains('hidden') })`);
  console.log('MODE', MODE, 'boot:', JSON.stringify(await state()));
  await shot(MODE + '-boot');
  if (MODE !== 'nowebgl' || (await js('!!(window.F1 && F1.game)'))) {
    await js(`(function(){ var i = F1_TRACKS.findIndex(function(t){ return t.id === 'it-1922'; }); var c = document.querySelectorAll('#track-grid .card')[i]; if (c) c.click(); return !!c; })()`).catch(e => console.log('click failed', e.message));
    await sleep(1500);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
    await sleep(3000);
    console.log('driving:', JSON.stringify(await state()));
    await shot(MODE + '-drive');
    if (MODE === 'lose') {
      // lose the context of the game canvas through the extension, restore it 2 s later
      const r = await js(`(function(){ var gl = document.getElementById('game').getContext('webgl2') || document.getElementById('game').getContext('webgl'); if (!gl) return 'no gl'; var ext = gl.getExtension('WEBGL_lose_context'); if (!ext) return 'no ext'; window.__ext = ext; ext.loseContext(); return 'lost'; })()`);
      console.log('lose:', r);
      await sleep(1500);
      console.log('while lost:', JSON.stringify(await state()), 'errors so far', errors.length);
      await shot(MODE + '-lost');
      await js('window.__ext.restoreContext(); true');
      await sleep(3000);
      console.log('after restore:', JSON.stringify(await state()));
      await shot(MODE + '-restored');
      // is the picture live again? compare two captures 300 ms apart while driving
      const a = (await win.webContents.capturePage()).toPNG(); await sleep(300); const b = (await win.webContents.capturePage()).toPNG();
      console.log('picture changes after restore:', !a.equals(b), 'sizes', a.length, b.length);
      // and a track change after the restore
      await js(`(function(){ var i = F1_TRACKS.findIndex(function(t){ return t.id === 'be-1925'; }); document.querySelectorAll('#track-grid .card')[i].click(); return true; })()`);
      await sleep(2000);
      console.log('after track change:', JSON.stringify(await state()));
      await shot(MODE + '-spa');
    }
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  }
  console.log('errors:', errors.length, JSON.stringify(errors.slice(0, 6)));
  app.exit(0);
});
