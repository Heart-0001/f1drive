// Before / after pictures side by side: out/before/<name>-old.png next to out/after/<name>-<style>.png, written to
// out/compare-<name>.png (half size each). Run shots.js with TAG=before (against cockpit-v5.js in place of js/cockpit.js,
// or the old checkout) and TAG=after first.
//   npx electron devtests/cockpit-test/compare.js        env PAIRS=monza-start:halo18,monaco-corner:halo,...
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
require('../electron-userdata')(app, 'cockpit-compare');
const OUT = path.join(__dirname, 'out');
const PAIRS = (process.env.PAIRS || 'monza-start:halo18,monza-fast:halo18,monaco-corner:halo,spa-eaurouge:modern,look-left:halo18,lock-left:halo18')
  .split(',').map(s => s.split(':'));
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1920, height: 540, show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<body style="margin:0"></body>');
  for (const [name, style] of PAIRS) {
    const a = path.join(OUT, 'before', name + '-old.png'), b = path.join(OUT, 'after', name + '-' + style + '.png');
    if (!fs.existsSync(a) || !fs.existsSync(b)) { console.log('missing', name); continue; }
    const da = 'data:image/png;base64,' + fs.readFileSync(a).toString('base64'), db = 'data:image/png;base64,' + fs.readFileSync(b).toString('base64');
    const png = await w.webContents.executeJavaScript(`(async function () {
      function load(src) { return new Promise(function (r) { var i = new Image(); i.onload = function () { r(i); }; i.src = src; }); }
      var A = await load(${JSON.stringify(da)}), B = await load(${JSON.stringify(db)});
      var c = document.createElement('canvas'); c.width = 1920; c.height = 560; var g = c.getContext('2d');
      g.fillStyle = '#111'; g.fillRect(0, 0, 1920, 560);
      g.drawImage(A, 0, 20, 960, 540); g.drawImage(B, 960, 20, 960, 540);
      g.fillStyle = '#fff'; g.font = '600 16px Arial'; g.fillText('before (v5)  ${name}', 8, 15); g.fillText('after (v6, ${style})', 968, 15);
      g.fillStyle = '#000'; g.fillRect(958, 0, 4, 560);
      return c.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(OUT, 'compare-' + name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
    console.log('compare', name);
  }
  app.exit(0);
});
