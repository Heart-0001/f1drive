// Which way of hiding a window makes Electron 33 report document.visibilityState = 'hidden'? (muted, off screen)
const { app, BrowserWindow } = require('electron');
const path = require('path');
require(path.join(__dirname, '..', '..', 'electron-userdata'))(app, 'verify-vis');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: -32000, y: -32000, width: 400, height: 300, show: false, skipTaskbar: true,
    webPreferences: { backgroundThrottling: true }
  });
  win.webContents.setAudioMuted(true);
  await win.loadURL('data:text/html,<title>v</title>');
  const vis = async tag => console.log(tag.padEnd(28), await win.webContents.executeJavaScript('document.visibilityState'),
    'minimized=' + win.isMinimized(), 'visible=' + win.isVisible());
  await vis('loaded (show:false)');
  win.showInactive(); await sleep(500); await vis('showInactive');
  win.minimize(); await sleep(800); await vis('minimize');
  win.restore(); await sleep(300); win.hide(); await sleep(800); await vis('hide');
  app.exit(0);
});
