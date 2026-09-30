const { app, BrowserWindow } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 800, height: 450, show: false, webPreferences: { offscreen: true } });
  w.webContents.setFrameRate(60);
  await w.loadFile('C:/Users/user/Desktop/f1drive/index.html');
  await sleep(500);
  await w.webContents.executeJavaScript("window.__k=[]; ['keydown','keyup','blur'].forEach(function(n){window.addEventListener(n,function(e){window.__k.push(n+':'+(e.code||''))},true)}); [].slice.call(document.querySelectorAll('.card')).filter(function(n){return /monza/i.test(n.textContent)})[0].click()");
  await sleep(1500);
  const sp = async tag => console.log(tag, await w.webContents.executeJavaScript("F1.game.car.state.speed.toFixed(2)+' '+F1.game.running"));
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' }); await sleep(3000); await sp('after W');
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S' });
  for (let i = 0; i < 6; i++) { await sleep(700); await sp('S held'); }
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S' });
  console.log(await w.webContents.executeJavaScript("JSON.stringify(window.__k)"));
  app.exit(0);
});
