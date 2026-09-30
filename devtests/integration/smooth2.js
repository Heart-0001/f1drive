// focused diagnostic: B records its view of A each frame while A accelerates
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = 'C:/Users/user/Desktop/f1drive';
const host = require(ROOT + '/net/host');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function win(tag) {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, partition: 'sm-' + tag, preload: ROOT + '/preload.js', backgroundThrottling: false } });
  w.webContents.setFrameRate(60); host.attach(w);
  w.js = c => w.webContents.executeJavaScript(c);
  w.key = (k, d) => w.webContents.sendInputEvent({ type: d ? 'keyDown' : 'keyUp', keyCode: k });
  return w;
}
app.whenReady().then(async () => {
  host.register(ipcMain);
  const A = win('A'), B = win('B');
  await A.loadFile(ROOT + '/index.html'); await B.loadFile(ROOT + '/index.html');
  await sleep(500);
  await A.js("document.getElementById('mp-addr').value='127.0.0.1:24741'; document.getElementById('mp-join').click()");
  await sleep(800);
  await B.js("document.getElementById('mp-addr').value='127.0.0.1:24741'; document.getElementById('mp-join').click()");
  await sleep(800);
  await A.js("[].slice.call(document.querySelectorAll('.card')).filter(function(n){return /monza/i.test(n.textContent)})[0].click()");
  await sleep(4000);
  await B.js("window.__rec=[]; (function loop(){ if(!window.__rec) return; var p=F1.net.players[0]; if(p&&p.active) window.__rec.push([performance.now(),p.state.x,p.state.z,p.state.speed,performance.now()-p._recv,p._buf.length,p._off]); requestAnimationFrame(loop); })(); 1");
  const WS=require(ROOT+'/node_modules/ws'); const obs=new WS('ws://127.0.0.1:24741'); const arr=[]; obs.on('open',()=>obs.send(JSON.stringify({t:'hello',v:1,name:'obs'}))); const cnt={}; obs.on('message',d=>{const m=JSON.parse(d); cnt[m.t]=(cnt[m.t]||0)+1; if(m.t==='snap') for(const e of m.p) if(e[0]===1) arr.push([Date.now(), e[1]]);});
  await A.js('window.__ft=[]; (function loop(t){ if(!window.__ft) return; window.__ft.push(performance.now()); requestAnimationFrame(loop); })(); 1');
  await A.js('window.__sent={}; (function(){var o=WebSocket.prototype.send; WebSocket.prototype.send=function(d){try{var t=JSON.parse(d).t; window.__sent[t]=(window.__sent[t]||0)+1;}catch(e){} return o.apply(this,arguments);};})(); 1');
  A.key('W', true);
  await sleep(6000);
  console.log('frames sent by A', JSON.stringify(await A.js('window.__sent')), 'all observer msgs', JSON.stringify(cnt));
  const ft=await A.js('(function(){var r=window.__ft; window.__ft=null; return r;})()'); let g=0; for(let i=1;i<ft.length;i++) g=Math.max(g,ft[i]-ft[i-1]);
  let ga=0,gc=0; for(let i=1;i<arr.length;i++){ga=Math.max(ga,arr[i][0]-arr[i-1][0]); gc=Math.max(gc,arr[i][1]-arr[i-1][1]);}
  console.log('frames A', ft.length, 'max A frame gap', g.toFixed(0), '| observer snaps', arr.length, 'max arrival gap', ga, 'max sender-timestamp gap', gc);
  const rec = await B.js("(function(){var r=window.__rec; window.__rec=null; return r;})()");
  A.key('W', false);
  let worst = [];
  for (let i = 1; i < rec.length; i++) {
    const dt = (rec[i][0] - rec[i - 1][0]) / 1000, st = Math.hypot(rec[i][1] - rec[i - 1][1], rec[i][2] - rec[i - 1][2]);
    worst.push({ i, dev: +(st - 0.5 * (rec[i][3] + rec[i - 1][3]) * dt).toFixed(3), dtms: +(dt * 1000).toFixed(1), v: rec[i][3], sinceRecv: +rec[i][4].toFixed(0), buf: rec[i][5], off: +rec[i][6].toFixed(1) });
  }
  const maxRecv = Math.max(...rec.map(r => r[4]));
  worst.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));
  console.log('frames', rec.length, 'max ms since last snapshot', maxRecv.toFixed(0), 'end speed', rec[rec.length - 1][3]);
  console.log(worst.slice(0, 6).map(o => JSON.stringify(o)).join('\n'));
  await host.stopServer(); app.exit(0);
});
