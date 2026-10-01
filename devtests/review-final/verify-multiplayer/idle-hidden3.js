// MP-6 probe: a browser-mode guest (js/net.js without preload) in a HIDDEN, throttled page, against the real
// net/server.js with its default idle drop (60 s). Electron's Chromium is the same engine as Chrome; the window is
// never shown and the app is muted (devtests/electron-userdata.js).
//   npx electron devtests/review-final/verify-multiplayer/idle-hidden.js
// GRACE (s, default 20): shortens Chromium's 5-minute grace before intensive wake-up throttling (feature param).
// MINUTES (default 8): give up after this long.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'verify-idle3');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { performance } = require('perf_hooks');
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
// exact receipt times at the server: every 'message' a server-side socket (it has _ip) emits, per socket
const seenAt = new Map(), srvGaps = [];
const _emit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (ev) {
  if (ev === 'message' && this._ip !== undefined && this._player && this._player.name === 'Player') {
    const now = performance.now(), last = seenAt.get(this);
    if (last !== undefined && now - last > 1500) { srvGaps.push(Math.round(now - last)); console.log(ts(), 'SERVER receipt gap', (now - last).toFixed(1), 'ms (idle limit 60000, checked every 100 ms)'); }
    seenAt.set(this, now);
  }
  return _emit.apply(this, arguments);
};
const PORT = Number(process.env.PORT || 24956);
const GRACE = Number(process.env.GRACE || 20);
const MINUTES = Number(process.env.MINUTES || 8);
if (process.env.NOFEATURE !== '1') {
  app.commandLine.appendSwitch('enable-features',
    'IntensiveWakeUpThrottling:grace_period_seconds/' + GRACE + '/grace_period_seconds_loaded/' + GRACE);
}
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

app.whenReady().then(async () => {
  const srv = await createServer({ port: PORT, host: '127.0.0.1', log: l => { if (!/^(track|year)/.test(l)) console.log(ts(), 'server:', l); } });
  // observer: an unthrottled player in the main process; the snapshots tell when the hidden guest's states arrive
  const obs = new WebSocket('ws://127.0.0.1:' + PORT);
  let obsId = 0, seq = 0, guestId = 0, lastArr = 0;
  const gaps = [];
  obs.on('open', () => obs.send(JSON.stringify({ t: 'hello', v: 1, name: 'observer' })));
  obs.on('message', d => {
    const m = JSON.parse(d.toString());
    if (m.t === 'welcome') obsId = m.id;
    if (m.t === 'players') { const g = m.players.find(p => p.id !== obsId); if (g) guestId = g.id; }
    if (m.t === 'snap') {
      for (const e of m.p) if (e[0] === guestId) {
        const now = Date.now();
        if (lastArr) { const g = now - lastArr; if (g > 1500) { gaps.push(g); console.log(ts(), 'guest state after a gap of', g, 'ms'); } }
        lastArr = now;
      }
    }
  });
  setInterval(() => { if (obs.readyState === 1) obs.send(JSON.stringify({ t: 's', k: seq, c: Date.now() % 1e9, s: [0, 0, 0, 0, 0, 0, 0, 0] })); }, 100);

  // A real (not offscreen-rendered) window, placed far off screen, never focused, no taskbar button, then minimised:
  // what a browser tab behind another window / a minimised browser is. (show:false alone stays 'visible' in Electron.)
  // a guest on the internet: what it sends reaches the server 0..JITTER ms late (in order), like a Wi-Fi / mobile path
  const JITTER = Number(process.env.JITTER || 80), PROXY = PORT + 1;
  await new Promise(r => require('net').createServer(c => {
    const up = require('net').connect(PORT, '127.0.0.1');
    let due = 0;
    c.on('data', d => { const now = Date.now(); due = Math.max(due, now + Math.random() * JITTER); setTimeout(() => up.write(d), due - now); });
    up.on('data', d => c.write(d));
    const end = () => { c.destroy(); up.destroy(); };
    c.on('error', end); up.on('error', end); c.on('close', end); up.on('close', end);
  }).listen(PROXY, '127.0.0.1', r));
  console.log(ts(), 'jitter proxy :' + PROXY + ' -> :' + PORT + ', 0..' + JITTER + ' ms');
  const win = new BrowserWindow({
    x: -32000, y: -32000, width: 400, height: 300, show: false, skipTaskbar: true, focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: true }
  });
  win.webContents.setAudioMuted(true);
  win.webContents.on('console-message', (e, level, msg) => { if (!/Security Warning/.test(msg)) console.log(ts(), 'page:', msg); });
  await win.loadFile(path.join(__dirname, 'idle-page.html'), { hash: String(PROXY) });
  win.showInactive();
  await new Promise(r => setTimeout(r, 300));
  win.hide();                                // (Electron 33: minimize() leaves the page 'visible'; hide() after a show does not)
  await new Promise(r => setTimeout(r, 1000));
  console.log(ts(), 'page visibilityState =', await win.webContents.executeJavaScript('document.visibilityState'),
    '| grace param', process.env.NOFEATURE === '1' ? 'off (Chromium default 5 min)' : GRACE + ' s');

  const end = Date.now() + MINUTES * 60000;
  const timer = setInterval(async () => {
    let gone = false;
    try { gone = await win.webContents.executeJavaScript('window.probe.log.length > 0'); } catch (e) {}
    if (gone || Date.now() > end) {
      clearInterval(timer);
      console.log(ts(), 'RESULT: guest ' + (gone ? 'DROPPED' : 'still in the room') + '; server receipt gaps > 1.5 s: ' + JSON.stringify(srvGaps));
      try { obs.close(); } catch (e) {}
      await srv.close();
      app.exit(0);
    }
  }, 1000);
});
