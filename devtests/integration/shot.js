// Integration smoke test: drives the real game in an offscreen Electron window.
// env TRACK = substring of track name, STEPS = "W:4000,WA:1500,:500" (keys:ms), OUT = prefix
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const out = __dirname + '/' + (process.env.OUT || 'g');
const trackName = (process.env.TRACK || 'Monza').toLowerCase();
const steps = (process.env.STEPS || 'W:4000,WA:1200,:300').split(',').map(s => s.split(':'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  w.webContents.setFrameRate(60);
  w.webContents.on('console-message', (e, level, msg, line, src) => console.log('[console ' + level + ']', msg, src + ':' + line));
  const shot = async n => fs.writeFileSync(out + '-' + n + '.png', (await w.webContents.capturePage()).toPNG());
  try {
    await w.loadURL('file:///C:/Users/user/Desktop/f1drive/index.html');
    await sleep(800);
    await shot('menu');
    const clicked = await w.webContents.executeJavaScript(`(function(){
      var c=[].slice.call(document.querySelectorAll('.card')).filter(function(n){return n.textContent.toLowerCase().indexOf(${JSON.stringify(trackName)})>=0;})[0];
      if(!c) return 'no card'; c.click(); return c.textContent; })()`);
    console.log('clicked:', clicked);
    await sleep(1000);
    await shot('start');
    let i = 0;
    for (const [keys, ms] of steps) {
      for (const k of keys) w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
      await sleep(+ms);
      await shot('step' + (i++));
      for (const k of keys) w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
    }
    console.log('hud:', await w.webContents.executeJavaScript(`document.getElementById('hud').innerText.replace(/\\s+/g,' ')`));
  } catch (e) { console.log('ERR', e.message); }
  app.exit(0);
});
