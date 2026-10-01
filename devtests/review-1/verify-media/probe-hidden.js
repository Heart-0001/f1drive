// Verifier probe for "audio-hidden-window-keeps-sounding": a REAL (shown, then minimised / hidden) Electron window with
// the game's webPreferences (backgroundThrottling false) and, as a control, one with backgroundThrottling true.
// What does the page see (document.hidden, visibilitychange, rAF), and does the engine keep sounding?
//   npx electron devtests/review-1/verify-media/probe-hidden.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../../electron-userdata')(app, 'verify-media-hidden');
app.commandLine.appendSwitch('mute-audio');          // nobody has to hear it; the analyser still measures the graph
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(throttle) {
  const w = new BrowserWindow({ width: 400, height: 240, x: 20, y: 20, show: false, focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: throttle } });
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Security Warning') < 0) console.log('[console]', msg); });
  await w.loadFile(path.join(__dirname, 'probe-hidden.html'));
  w.showInactive();
  await sleep(500);
  const js = c => w.webContents.executeJavaScript(c, true);
  const out = { backgroundThrottling: throttle };
  out.start = await js('P.start()');
  await sleep(1200);
  out.visible = await js('P.sample()');
  w.minimize();
  await sleep(1500);
  out.minimised1500ms = await js('P.sample()');
  await sleep(1500);
  out.minimised3000ms = await js('P.sample()');
  w.restore(); w.showInactive();
  await sleep(1000);
  out.restored = await js('P.sample()');
  w.hide();
  await sleep(1500);
  out.hidden1500ms = await js('P.sample()');
  await sleep(1500);
  out.hidden3000ms = await js('P.sample()');
  w.destroy();
  return out;
}

app.on('window-all-closed', () => {});             // keep going after the first window is destroyed
app.whenReady().then(async () => {
  try {
    const only = process.env.ONLY === 'true' ? [true] : process.env.ONLY === 'false' ? [false] : [false, true];
    for (const t of only) {
      const r = await run(t);
      console.log(JSON.stringify(r, null, 1));
    }
  } catch (e) { console.log('ERR', e && e.stack || e); }
  app.exit(0);
});
