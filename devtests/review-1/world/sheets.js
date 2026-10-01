// npx electron devtests/review-1/world/sheets.js   env GROUP=<track ids, comma separated>
// 2x2 contact sheets (960x540 each) of every out/<id>-*.png in name order -> out/<id>-sheetN.png
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '..', '..', 'electron-userdata'))(app, 'review1-sheets');
const OUT = path.join(__dirname, 'out');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jobs = [];
for (const id of (process.env.GROUP || '').split(',').filter(Boolean)) {
  const files = fs.readdirSync(OUT).filter(f => f.startsWith(id + '-') && f.endsWith('.png') && f.indexOf('sheet') < 0).sort();
  for (let i = 0; i < files.length; i += 4) jobs.push({ files: files.slice(i, i + 4), out: id + '-sheet' + (i / 4 + 1) });
}
const PAGE = path.join(OUT, '_sheet.html');
fs.writeFileSync(PAGE, '<!doctype html><html><body style="margin:0;background:#222"><canvas id="c" width="1920" height="1080"></canvas></body></html>');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1920, height: 1080, show: false, useContentSize: true, webPreferences: { offscreen: true, webSecurity: false } });
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2) console.log('[console]', msg); });
  await w.loadFile(PAGE);
  await sleep(300);
  for (const job of jobs) {
    const urls = job.files.map(f => 'file:///' + path.join(OUT, f).replace(/\\/g, '/'));
    const ok = await w.webContents.executeJavaScript(`(function () {
      return new Promise(function (done) {
        var c = document.getElementById('c'), g = c.getContext('2d'); g.fillStyle = '#222'; g.fillRect(0, 0, 1920, 1080);
        var urls = ${JSON.stringify(urls)}, names = ${JSON.stringify(job.files)}, left = urls.length;
        urls.forEach(function (u, i) {
          var im = new Image();
          im.onload = function () {
            var x = (i % 2) * 960, y = Math.floor(i / 2) * 540; g.drawImage(im, x, y, 960, 540);
            g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, 320, 22); g.fillStyle = '#fff'; g.font = '16px sans-serif'; g.fillText(names[i], x + 4, y + 16);
            if (--left === 0) done(true);
          };
          im.onerror = function () { if (--left === 0) done(false); };
          im.src = u;
        });
        setTimeout(function () { done('timeout'); }, 8000);
      });
    })()`);
    await sleep(150);
    fs.writeFileSync(path.join(OUT, job.out + '.png'), (await w.webContents.capturePage()).toPNG());
    console.log(job.out + ' [' + ok + ']: ' + job.files.join(' '));
  }
  app.exit(0);
});
