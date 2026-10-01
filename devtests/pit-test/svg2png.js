// npx electron devtests/pit-test/svg2png.js <name,name,...> [max px = 2400]
// Renders devtests/pit-test/out/<name>.svg to <name>.png (longest side at most `max` px), offscreen.
const { app, BrowserWindow } = require('electron');
require('../electron-userdata')(app, 'pit-svg');
const fs = require('fs'), path = require('path'), url = require('url');
const DIR = path.join(__dirname, 'out');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const names = (process.argv[2] || '').split(',').filter(Boolean), max = +(process.argv[3] || 2400);
  const win = new BrowserWindow({ show: false, width: 1000, height: 1000, useContentSize: true, webPreferences: { offscreen: true } });
  for (const n of names) {
    try {
      const m = fs.readFileSync(path.join(DIR, n + '.svg'), 'utf8').match(/width="(\d+)" height="(\d+)"/);
      const k = Math.min(1, max / Math.max(+m[1], +m[2])), W = Math.round(+m[1] * k), H = Math.round(+m[2] * k);
      win.setContentSize(W, H);
      const html = path.join(DIR, '_tmp.html');
      fs.writeFileSync(html, `<body style="margin:0;overflow:hidden"><img src="${n}.svg" style="width:${W}px;height:${H}px;display:block">`);
      await win.loadURL(url.pathToFileURL(html).href);
      await new Promise(r => setTimeout(r, 600));
      fs.writeFileSync(path.join(DIR, n + '.png'), (await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H })).toPNG());
    } catch (e) { console.log(n, 'failed', e.message); }
  }
  try { fs.unlinkSync(path.join(DIR, '_tmp.html')); } catch (e) {}
  app.exit(0);
});
