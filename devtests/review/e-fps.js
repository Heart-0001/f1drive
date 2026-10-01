// Measure rAF rate and physics progression in an Electron window (visible, so rAF runs at display rate).
const { app, BrowserWindow } = require('electron');
require('../electron-userdata')(app, 'review-fps');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 900, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(require('path').resolve(__dirname, '..', '..', 'index.html'));
  await sleep(1000);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js(`(function(){var cards=[...document.querySelectorAll('.card')];var c=cards.find(x=>x.textContent.includes('Monza'));c.click();})()`);
  await sleep(800);
  await js(`window.__frames=0; (function f(){window.__frames++; requestAnimationFrame(f);})();`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  await sleep(4000);
  const frames = await js(`window.__frames`);
  const speed = await js(`document.getElementById('hud-speed').textContent`);
  console.log('frames in 4s:', frames, 'speed km/h after 4s W:', speed);
  // blur test: focus loss should clear input
  win.blur();
  await sleep(1500);
  const s2 = await js(`document.getElementById('hud-speed').textContent`);
  await sleep(1500);
  const s3 = await js(`document.getElementById('hud-speed').textContent`);
  console.log('after blur: speed', s2, '->', s3, '(should be decreasing if W was cleared)');
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, '08-monza.png'), img.toPNG());
  app.quit();
});
