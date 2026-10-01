// Does the portable exe remember settings across launches although it unpacks itself to a NEW random folder every
// time (file:// origin, localStorage)? Run 1 sets the name field in the 多人連線 panel (ui.js saves it to localStorage),
// run 2 reads it back. Muted, default userData (the real one, as a player would have it).
//   node devtests/review-final/perf/persist.js <exe>       env PORT (9345)
'use strict';
const { spawn } = require('child_process');
const http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'f1drive-review-persist-'));
const WebSocket = require('ws');
const EXE = path.resolve(process.argv[2]);
const PORT = Number(process.env.PORT || 9345);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej); });

async function session(fn) {
  const app = spawn(EXE, ['--remote-debugging-port=' + PORT, '--mute-audio', '--user-data-dir=' + UD], { stdio: 'ignore' });
  let ws, id = 0; const pending = new Map();
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const js = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return x.result && x.result.value; };
  for (let attempt = 0; attempt < 120; attempt++) {
    await sleep(250);
    const list = await getJson('http://127.0.0.1:' + PORT + '/json').catch(() => []);
    const page = list.find(p => p.type === 'page' && /index\.html/.test(p.url));
    if (!page) continue;
    ws = new WebSocket(page.webSocketDebuggerUrl); ws.on('error', () => {});
    const ok = await new Promise(res => { ws.on('open', () => res(true)); ws.on('error', () => res(false)); ws.on('close', () => res(false)); });
    if (!ok) continue;
    ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || {}); pending.delete(d.id); } });
    const alive = await Promise.race([js('1'), new Promise(res => ws.on('close', () => res(null))), sleep(2000).then(() => null)]);
    if (alive === 1) break;
    try { ws.close(); } catch (e) {} pending.clear();
  }
  while (!(await js('!!(window.F1 && F1.game && F1.ui && document.readyState === "complete")'))) await sleep(50);
  await sleep(500);
  const out = await fn(js);
  send('Browser.close').catch(() => {}); await sleep(1500);
  try { process.kill(app.pid); } catch (e) {}
  return out;
}

(async () => {
  const r1 = await session(async js => {
    const before = await js('(function(){ try { return JSON.stringify(Object.keys(localStorage)); } catch (e) { return String(e); } })()');
    // type a name into the multiplayer name field the way ui.js listens for it
    const set = await js(`(function(){ var f = document.getElementById('mp-name'); if (!f) return 'no field'; f.value = 'review-persist'; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); return 'typed'; })()`);
    await sleep(1500);
    const after = await js('(function(){ try { return JSON.stringify({ keys: Object.keys(localStorage), mp: localStorage.getItem("f1drive.mp") }); } catch (e) { return String(e); } })()');
    return { url: await js('location.href'), before, set, after };
  });
  console.log('run 1', JSON.stringify(r1));
  const r2 = await session(async js => ({ url: await js('location.href'), mp: await js('(function(){ try { return localStorage.getItem("f1drive.mp"); } catch (e) { return String(e); } })()'), field: await js('(function(){ var f = document.getElementById("mp-name"); return f ? f.value : null; })()'), profile: await js('F1.ui.getProfile ? JSON.stringify(F1.ui.getProfile()) : null') }));
  console.log('run 2', JSON.stringify(r2));
  try { fs.rmSync(UD, { recursive: true, force: true }); } catch (e) {}
  console.log('remembered across launches (different unpack folders):', r1.url !== r2.url, /review-persist/.test(String(r2.mp)));
})();
