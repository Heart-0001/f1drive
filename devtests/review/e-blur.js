const { app, BrowserWindow } = require('electron');
require('../electron-userdata')(app, 'review-blur');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  setTimeout(() => { console.log("TIMEOUT (60 s)"); app.exit(2); }, 60000).unref();
  const win = new BrowserWindow({ width: 1200, height: 700, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(require('path').resolve(__dirname, '..', '..', 'index.html'));
  await sleep(800);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // (v6 replaced the HUD's #hud-speed with the telemetry graphic: the car's own speed then)
  const SPEED = `(function () { var e = document.getElementById('hud-speed'); return e ? e.textContent : (window.F1 && F1.game && F1.game.car ? Math.round(F1.game.car.state.speed * 3.6) + ' km/h (car)' : 'n/a'); })()`;
  await js(`(function(){var cards=[...document.querySelectorAll('.card')];var c=cards.find(x=>x.textContent.includes('Monza'));c.click();})()`);
  await sleep(500);
  await js(`window.__frames=0; (function f(){window.__frames++; requestAnimationFrame(f);})(); window.__blurs=0; window.addEventListener('blur',()=>window.__blurs++);`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  for (let i = 0; i < 4; i++) { await sleep(500); console.log('t=' + (i + 1) * 0.5, 'speed', await js(SPEED), 'frames', await js('window.__frames')); }
  // open a second window to steal focus (a realistic alt-tab)
  const other = new BrowserWindow({ width: 300, height: 200, show: true });
  other.focus();
  await sleep(300);
  console.log('blur events in game window:', await js('window.__blurs'), 'focused?', win.isFocused());
  for (let i = 0; i < 4; i++) { await sleep(500); console.log('after focus loss t=' + (i + 1) * 0.5, 'speed', await js(SPEED), 'frames', await js('window.__frames')); }
  other.close();
  // Ctrl+R default accelerator test: does the page reload (losing state)?
  win.focus(); await sleep(300);
  await js(`window.__marker = 1`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
  await sleep(1500);
  console.log('marker after Ctrl+R (undefined => page reloaded):', await js('window.__marker'));
  console.log('menu visible after Ctrl+R:', await js(`!document.getElementById('menu').classList.contains('hidden')`));
  app.quit();
}).catch((e) => { console.log("FAILED " + (e && e.stack || e)); app.exit(1); });
