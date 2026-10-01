// Review probe: js/audio.js in a real (offscreen) Electron window with the game's own window settings
// (backgroundThrottling: false, so the loop keeps calling update() while hidden). Does the sound fade out on a hidden
// window as the module's header says?   npx electron devtests/review-1/sound-graphics/probe-audio.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../../electron-userdata')(app, 'review-audio');
app.commandLine.appendSwitch('mute-audio');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 640, height: 360, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Security Warning') < 0) console.log('[console]', msg); });
  await w.loadFile(path.join(__dirname, 'probe-audio.html'));
  try {
    const r = await w.webContents.executeJavaScript('P.run()', false);
    console.log(JSON.stringify(r, null, 1));
  } catch (e) { console.log('ERR', e.message); }
  app.exit(0);
});
