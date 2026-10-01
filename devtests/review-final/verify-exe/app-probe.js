// Verifier probe (MUTED via devtests/electron-userdata.js, offscreen window) that boots the REAL electron-main.js
// (or a scratch copy of the app: env APPROOT) and runs one of:
//   MODE=load   PKG-5: synchronous cost of clicking a track card and the longest frame gap around it
//   MODE=crash  PKG-6: host a room, crash the renderer, see whether anything reloads / tells the player; room dropped?
//   MODE=csp    PKG-4: boot a copy whose index.html carries a CSP meta: CSP violations, inline-script overlay helper,
//               audio worklet backend, a track loads and drives, room create / ipify fetch not blocked
//   npx electron devtests/review-final/verify-exe/app-probe.js      (env MODE, APPROOT)
'use strict';
const path = require('path'), Module = require('module'), net = require('net');
const ROOT = path.resolve(process.env.APPROOT || path.join(__dirname, '..', '..', '..'));
const MODE = process.env.MODE || 'load';
const electron = require('electron');
const { app } = electron;
require(path.join(__dirname, '..', '..', 'electron-userdata'))(app, 'verify-exe-' + MODE);   // mutes
const RealBW = electron.BrowserWindow;
let win = null;
class OffscreenWindow extends RealBW {
  constructor(o) {
    o = Object.assign({}, o, { show: false });
    o.webPreferences = Object.assign({}, o.webPreferences, { offscreen: true });
    super(o);
    win = this;
  }
  maximize() {}
  setFullScreen() {}
}
const load = Module._load;
Module._load = function (request) {
  if (request === 'electron') return new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? OffscreenWindow : t[k]) });
  return load.apply(this, arguments);
};
require(path.join(ROOT, 'electron-main.js'));
Module._load = load;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { mode: MODE, root: ROOT };
const portOpen = port => new Promise(res => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); setTimeout(() => { s.destroy(); res(false); }, 1500); });

app.whenReady().then(async () => {
  for (let i = 0; i < 50 && !win; i++) await sleep(100);
  const consoleMsgs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) consoleMsgs.push(msg.slice(0, 300)); });
  await new Promise(r => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', r); else r(); });
  await sleep(1200);
  const js = c => win.webContents.executeJavaScript(c);
  out.boot = await js(`({ overlay: document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent,
    showError: typeof (window.F1 && F1.showError), host: !!window.f1host, audio: F1.audio && F1.audio.debug ? F1.audio.debug.backend + '/' + (F1.audio.debug.context && F1.audio.debug.context.state) : 'none' })`);
  const pick = id => js(`(function(){ var i = F1_TRACKS.findIndex(function(t){ return t.id === ${JSON.stringify(id)}; });
      var gaps = window.__gaps = { max: 0, last: performance.now(), on: true };
      (function tick(t){ var n = performance.now(); if (n - gaps.last > gaps.max) gaps.max = n - gaps.last; gaps.last = n; if (gaps.on) requestAnimationFrame(tick); })();
      return new Promise(function(res){ setTimeout(function(){ var t0 = performance.now(); document.querySelectorAll('#track-grid .card')[i].click(); res(performance.now() - t0); }, 300); }); })()`);
  const gapAfter = async () => { await sleep(1500); return js('(function(){ window.__gaps.on = false; return Math.round(window.__gaps.max); })()'); };

  if (MODE === 'load') {
    out.loads = [];
    for (const id of ['it-1922', 'be-1925', 'mc-1929', 'jp-1962', 'it-1922']) {
      const clickMs = await pick(id);
      const maxGapMs = await gapAfter();
      out.loads.push({ id, clickMs: Math.round(clickMs), maxGapMs, running: await js('F1.game.running') });
      await js('(function(){ document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true })); return true; })()');
      await sleep(400);
    }
  } else if (MODE === 'crash') {
    const port = 24000 + Math.floor(Math.random() * 400);
    out.room = await js(`F1.net && F1.net.create ? Promise.resolve(F1.net.create(${port})).then(function(){ return new Promise(function(r){ setTimeout(function(){ r({ connected: F1.net.connected, isHost: F1.net.isHost }); }, 1500); }); }) : window.f1host.startServer(${port})`);
    out.portOpenBefore = await portOpen(port);
    await pick('it-1922'); await gapAfter();
    out.runningBefore = await js('F1.game.running');
    let loads = 0, gone = null;
    win.webContents.on('did-start-loading', () => loads++);
    win.webContents.on('render-process-gone', (e, d) => { gone = d; });
    out.listeners = { renderProcessGone: win.webContents.listenerCount('render-process-gone'), unresponsive: win.listenerCount('unresponsive') + win.webContents.listenerCount('unresponsive') };
    win.webContents.forcefullyCrashRenderer();
    await sleep(5000);
    out.after5s = { gone, isCrashed: win.webContents.isCrashed(), reloadsStarted: loads, windowAlive: !win.isDestroyed(), url: win.webContents.getURL().replace(/^.*[\\/]/, '') };
    out.portOpenAfter = await portOpen(port);
    out.dialogsShown = 'none hooked (electron-main.js has no dialog import)';
  } else if (MODE === 'csp') {
    out.cspMeta = await js(`(function(){ var m = document.querySelector('meta[http-equiv="Content-Security-Policy"]'); return m ? m.content : null; })()`);
    await pick('it-1922'); await gapAfter();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
    await sleep(2500);
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
    out.drive = await js(`({ running: F1.game.running, v: F1.game.car.state.speed, audio: F1.audio.debug.backend + '/' + F1.audio.debug.context.state, frames: F1.audio.debug.frames,
       overlay: document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent })`);
    // what the page would have to do in a room / for the public IP: is it allowed by the policy?
    out.ws = await js(`new Promise(function(res){ try { var w = new WebSocket('ws://127.0.0.1:1/'); w.onerror = function(){ res('error event (allowed by CSP, port closed)'); }; } catch (e) { res('threw: ' + e.message); } setTimeout(function(){ res('timeout'); }, 3000); })`);
    out.fetchIpify = await js(`fetch('https://api.ipify.org?format=json', { cache: 'no-store' }).then(function(r){ return 'http ' + r.status; }, function(e){ return 'rejected: ' + e.message; })`);
    out.evalBlocked = await js(`(function(){ try { return 'eval ran: ' + eval('1+1'); } catch (e) { return 'eval blocked: ' + e.name; } })()`);
    out.inlineHandler = await js(`(function(){ var d = document.createElement('div'); d.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="window.__xss=1" onload="window.__xss=1">'; document.body.appendChild(d); return new Promise(function(r){ setTimeout(function(){ d.remove(); r(window.__xss ? 'inline handler RAN' : 'inline handler blocked'); }, 800); }); })()`);
  }
  out.consoleErrors = consoleMsgs.filter(m => m.indexOf('Electron Security Warning') < 0).slice(0, 12);
  out.securityWarnings = consoleMsgs.filter(m => m.indexOf('Electron Security Warning') >= 0).map(m => m.slice(0, 120));
  console.log(JSON.stringify(out, null, 1));
  require('fs').writeFileSync(path.join(__dirname, 'app-probe-' + MODE + (process.env.TAG ? '-' + process.env.TAG : '') + '.json'), JSON.stringify(out, null, 1));
  app.exit(0);
});
