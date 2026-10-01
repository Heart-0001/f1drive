const { app, BrowserWindow } = require('electron');
require('../electron-userdata')(app, 'svg2png');
const fs = require('fs'), path = require('path'), url = require('url');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const dir = process.argv[2];
  const ids = process.argv[3].split(',');
  const win = new BrowserWindow({ show: false, width: 1000, height: 1000, useContentSize: true, webPreferences: { offscreen: true } });
  for (const id of ids) {
    try {
      const f = path.join(dir, id + '.svg');
      const m = fs.readFileSync(f, 'utf8').match(/width="(\d+)" height="(\d+)"/);
      const k = 1000 / Math.max(+m[1], +m[2]);
      const W = Math.round(+m[1] * k), H = Math.round(+m[2] * k);
      win.setContentSize(W, H);
      const html = path.join(dir, '_tmp.html');
      fs.writeFileSync(html, `<body style="margin:0;overflow:hidden"><img src="${id}.svg" style="width:${W}px;height:${H}px;display:block">`);
      await win.loadURL(url.pathToFileURL(html).href);
      await new Promise(r => setTimeout(r, 1200));
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
      fs.writeFileSync(path.join(dir, id + '.png'), img.toPNG());
    } catch (e) { console.log(id, 'failed', e.message); }
  }
  try { fs.unlinkSync(path.join(dir, '_tmp.html')); } catch {}
  app.quit();
});
