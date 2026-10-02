// Electron harness: load the real index.html, screenshot menu + cockpit, exercise keys, capture console errors.
const { app, BrowserWindow } = require('electron');
require('../electron-userdata')(app, 'review-main');
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.disableHardwareAcceleration && 0; // keep GPU for WebGL
app.whenReady().then(async () => {
  setTimeout(() => { console.log("e-main: TIMEOUT (120 s)"); app.exit(2); }, 120000).unref();
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
  const logs = [];
  win.webContents.on('console-message', (e, level, msg, line, src) => logs.push(`[${level}] ${msg} (${path.basename(src || '')}:${line})`));
  win.webContents.setFrameRate(60);
  await win.loadFile(require('path').resolve(__dirname, '..', '..', 'index.html'));
  await sleep(1500);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // (v6 replaced the HUD's speed / gear boxes #hud-speed / #hud-gear with the telemetry graphic: read the car itself then)
  const SPEED = `(function () { var e = document.getElementById('hud-speed'); return e ? e.textContent : (window.F1 && F1.game && F1.game.car ? Math.round(F1.game.car.state.speed * 3.6) + ' km/h (car)' : 'n/a'); })()`;
  const GEAR = `(function () { var e = document.getElementById('hud-gear'); return e ? e.textContent : (window.F1 && F1.game && F1.game.car ? String(F1.game.car.state.gear) + ' (car)' : 'n/a'); })()`;
  async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG()); }
  async function key(type, code, keyCode) { win.webContents.sendInputEvent({ type, keyCode }); }
  const report = {};
  report.menuCards = await js(`document.querySelectorAll('#track-grid .card').length`);
  report.errorVisible = await js(`!document.getElementById('error').classList.contains('hidden')`);
  await shot('01-menu');
  // select Monaco
  await js(`(function(){var cards=[...document.querySelectorAll('.card')];var c=cards.find(x=>x.textContent.includes('Monaco'));c.click();})()`);
  await sleep(1500);
  await shot('02-cockpit-start');
  report.hudVisible = await js(`!document.getElementById('hud').classList.contains('hidden')`);
  report.activeElement = await js(`document.activeElement && document.activeElement.tagName`);
  // press W for 4 s
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  await sleep(4000);
  report.speedAfter4sW = await js(SPEED);
  report.gear = await js(GEAR);
  await shot('03-driving');
  // steer left a bit while driving
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
  await sleep(600);
  await shot('04-steer-left');
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  // arrow keys
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
  await sleep(1500);
  report.speedArrowUp = await js(SPEED);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
  // Esc -> menu, then type in search, then Esc -> resume
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(300);
  report.menuAfterEsc = await js(`!document.getElementById('menu').classList.contains('hidden')`);
  report.resumeBtnVisible = await js(`!document.getElementById('menu-resume').classList.contains('hidden')`);
  await js(`document.getElementById('track-search').focus()`);
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'w' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'a' });
  await sleep(200);
  report.searchValue = await js(`document.getElementById('track-search').value`);
  report.searchCount = await js(`document.getElementById('track-count').textContent`);
  await shot('05-menu-search');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(300);
  report.menuAfterEsc2 = await js(`!document.getElementById('menu').classList.contains('hidden')`);
  report.activeAfterResume = await js(`document.activeElement && document.activeElement.tagName`);
  // does typing W now drive (i.e. search box no longer captures)?
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  await sleep(1500);
  report.speedAfterResumeW = await js(SPEED);
  report.searchValueAfter = await js(`document.getElementById('track-search').value`);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  // R reset
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R' });
  await sleep(200);
  report.speedAfterR = await js(SPEED);
  // switch tracks several times to check for leaks / errors
  const t0 = await js(`performance.memory ? performance.memory.usedJSHeapSize : -1`);
  for (let i = 0; i < 6; i++) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await sleep(150);
    await js(`document.querySelectorAll('.card')[${i * 5}].click()`);
    await sleep(500);
  }
  report.renderInfo = await js(`(function(){var r=null;try{ /* no access to renderer var; count scene via THREE? */ }catch(e){} return 'n/a';})()`);
  await shot('06-after-switching');
  report.hudTrackName = await js(`document.getElementById('hud-track').textContent`);
  // resize
  win.setSize(900, 600); await sleep(500); await shot('07-resized');
  report.canvasSize = await js(`[document.getElementById('game').width, document.getElementById('game').height, innerWidth, innerHeight]`);
  report.logs = logs;
  fs.writeFileSync(path.join(OUT, 'e-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.quit();
}).catch((e) => { console.log("e-main: FAILED " + (e && e.stack || e)); app.exit(1); });
