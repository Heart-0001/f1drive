// npx electron devtests/review-final/world/sheets.js   env TRACKS=id,...   -- contact sheets from the PNGs of shots.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'review-final-sheets');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const OUT = path.join(__dirname, 'out');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const names = ['start', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'far', 'approach', 'lane', 'box1', 'exit', 'across', 'pittop', 'top'];
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const ids = process.env.TRACKS ? process.env.TRACKS.split(',') :
    [...new Set(fs.readdirSync(OUT).filter(f => /-top\.png$/.test(f)).map(f => f.replace(/-top\.png$/, '')))];
  const sheet = new BrowserWindow({ width: 1920, height: 1800, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  for (const id of ids) {
    const tiles = names.map(n => `<div class="t"><img src="${id}-${n}.png"><span>${id} ${n}</span></div>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;overflow:hidden;background:#222;width:1920px;height:1800px;display:grid;grid-template-columns:repeat(3,640px);grid-auto-rows:360px}
      .t{position:relative;width:640px;height:360px}.t img{width:640px;height:360px;display:block}.t span{position:absolute;left:4px;top:2px;color:#ff0;font:bold 16px monospace;text-shadow:0 0 3px #000}</style></head><body>${tiles}</body></html>`;
    const f = path.join(OUT, '_sheet.html');
    fs.writeFileSync(f, html);
    await sheet.loadFile(f);
    await sleep(1200);
    fs.writeFileSync(path.join(OUT, id + '-sheet.png'), (await sheet.webContents.capturePage()).toPNG());
    console.log('sheet ' + id);
  }
  app.exit(0);
});
