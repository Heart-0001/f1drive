// Measure rAF rate and physics progression in an Electron window (visible, so rAF runs at display rate).
const { app, BrowserWindow } = require('electron');
require('../electron-userdata')(app, 'review-fps');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  setTimeout(() => { console.log("TIMEOUT (60 s)"); app.exit(2); }, 60000).unref();
  const win = new BrowserWindow({ width: 1600, height: 900, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(require('path').resolve(__dirname, '..', '..', 'index.html'));
  await sleep(1000);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // (v6 replaced the HUD's #hud-speed with the telemetry graphic: the car's own speed then)
  const SPEED = `(function () { var e = document.getElementById('hud-speed'); return e ? e.textContent : (window.F1 && F1.game && F1.game.car ? Math.round(F1.game.car.state.speed * 3.6) + ' km/h (car)' : 'n/a'); })()`;
  await js(`(function(){var cards=[...document.querySelectorAll('.card')];var c=cards.find(x=>x.textContent.includes('Monza'));c.click();var __g=document.getElementById('setup-go'); if(__g) __g.click(); })()`);
  await sleep(800);
  await js(`window.__frames=0; (function f(){window.__frames++; requestAnimationFrame(f);})();`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  await sleep(4000);
  const frames = await js(`window.__frames`);
  const speed = await js(SPEED);
  console.log('frames in 4s:', frames, 'speed km/h after 4s W:', speed);
  // blur test: focus loss should clear input
  win.blur();
  await sleep(1500);
  const s2 = await js(SPEED);
  await sleep(1500);
  const s3 = await js(SPEED);
  console.log('after blur: speed', s2, '->', s3, '(should be decreasing if W was cleared)');
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, '08-monza.png'), img.toPNG());
  app.quit();
}).catch((e) => { console.log("FAILED " + (e && e.stack || e)); app.exit(1); });
