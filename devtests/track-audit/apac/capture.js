// npx electron devtests/track-audit/apac/capture.js <page.html> <out.png> <w> <h> -- offscreen screenshot of a local page
// (MUTED via devtests/electron-userdata.js). Used by imagery.mjs.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'apac-capture');
const a = process.argv.slice(-4), W = +a[2], H = +a[3];
setTimeout(() => { console.log('capture: timeout'); app.exit(2); }, 60000).unref();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, webPreferences: { offscreen: true, webSecurity: false } });
  await win.loadFile(path.resolve(a[0]));
  await new Promise((r) => setTimeout(r, 1500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.resolve(a[1]), img.toPNG());
  console.log('wrote ' + a[1]);
  app.exit(0);
});
