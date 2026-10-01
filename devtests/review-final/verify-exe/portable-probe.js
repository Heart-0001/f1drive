// Verifier probe for PKG-2 / PKG-10: launches the PORTABLE exe MUTED (--mute-audio), with a throw-away
// user-data dir, and records:
//   - when the %TEMP% unpack dir appears / is complete, when CDP answers, when F1.game exists
//   - whether the spawned pid (NSIS stub) is still alive while the app runs
//   - MODE=close: Browser.close over CDP, then whether the stub exits and removes the unpack dir
//   - MODE=killstub: process.kill(stub pid) as smoke-exe.js's finally block does, then whether F1Drive.exe
//     processes from the unpack dir survive (they are cleaned up afterwards by CDP Browser.close, then by pid)
//   node devtests/review-final/verify-exe/portable-probe.js [exe]   env MODE=close|killstub, PORT (9450)
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'ws'));
const EXE = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'dist', 'F1Drive-v6-preview.exe'));
const MODE = process.env.MODE || 'close';
const PORT = Number(process.env.PORT || 9450);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { const q = http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }); q.on('error', rej); q.setTimeout(1000, () => q.destroy(new Error('timeout'))); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
function procsUnder(dir) {
  // F1Drive.exe processes whose image lives under dir (PowerShell, path filter: never touches other instances)
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process F1Drive -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + dir.replace(/'/g, "''") + "*' } | ForEach-Object { $_.Id }"], { encoding: 'utf8' });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch (e) { return []; }
}
function dirSizeMB(d) {
  let s = 0;
  const walk = p => { for (const n of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, n.name); if (n.isDirectory()) walk(f); else { try { s += fs.statSync(f).size; } catch (e) {} } } };
  try { walk(d); } catch (e) {}
  return +(s / 1048576).toFixed(1);
}

(async () => {
  const tmp = os.tmpdir();
  const before = new Set(fs.readdirSync(tmp));
  const ud = fs.mkdtempSync(path.join(tmp, 'f1drive-verify-exe-ud-'));
  before.add(path.basename(ud));
  const r = { exe: EXE, mode: MODE };
  const t0 = Date.now();
  const app = spawn(EXE, ['--mute-audio', '--remote-debugging-port=' + PORT, '--user-data-dir=' + ud], { stdio: 'ignore' });
  r.stubPid = app.pid;
  let unpack = null, page = null;
  for (let i = 0; i < 300 && !page; i++) {
    await sleep(100);
    if (!unpack) {
      const n = fs.readdirSync(tmp).filter(x => !before.has(x) && fs.existsSync(path.join(tmp, x, 'F1Drive.exe')));
      if (n.length) { unpack = path.join(tmp, n[0]); r.unpackDir = n[0]; r.unpackSeenMs = Date.now() - t0; }
    }
    try { const list = await getJson('http://127.0.0.1:' + PORT + '/json'); r.cdpUpMs = r.cdpUpMs || Date.now() - t0; page = list.find(p => p.type === 'page' && /index\.html/.test(p.url)); } catch (e) {}
  }
  if (!unpack) {
    // folder already existed before the launch (same hash name every time)?
    const n = fs.readdirSync(tmp).filter(x => fs.existsSync(path.join(tmp, x, 'F1Drive.exe')) && fs.existsSync(path.join(tmp, x, 'resources', 'app.asar')));
    r.unpackPreexisting = n;
    if (n.length) unpack = path.join(tmp, n[0]);
  }
  if (!page) { r.error = 'no page'; console.log(JSON.stringify(r, null, 1)); }
  let ws, id = 0; const pending = new Map();
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); setTimeout(() => res({ timeout: true }), 4000); });
  const js = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return x.result && x.result.value; };
  if (page) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json').catch(() => []);
      page = list.find(p => p.type === 'page' && /index\.html/.test(p.url));
      if (!page) { await sleep(200); continue; }
      ws = new WebSocket(page.webSocketDebuggerUrl); ws.on('error', () => {});
      const ok = await new Promise(res => { ws.on('open', () => res(true)); ws.on('close', () => res(false)); });
      if (!ok) { await sleep(200); continue; }
      ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || {}); pending.delete(d.id); } });
      if (await js('1') === 1) break;
    }
    while (!(await js('!!(window.F1 && F1.game && document.readyState === "complete")'))) await sleep(50);
    r.bootMs = Date.now() - t0;
    r.audioMuted = await js('F1.audio && F1.audio.debug ? F1.audio.debug.backend + "/" + (F1.audio.debug.context && F1.audio.debug.context.state) : "none"');
  }
  r.unpackSizeMB = unpack ? dirSizeMB(unpack) : null;
  r.stubAliveWhileAppRuns = alive(app.pid);
  r.appPidsUnderUnpack = unpack ? procsUnder(unpack) : [];
  if (MODE === 'killstub') {
    try { process.kill(app.pid); } catch (e) { r.killErr = e.message; }
    await sleep(2500);
    r.afterStubKill = { stubAlive: alive(app.pid), appPidsStillRunning: unpack ? procsUnder(unpack) : [], cdpStillAnswers: await getJson('http://127.0.0.1:' + PORT + '/json/version').then(() => true, () => false) };
  }
  // clean up: Browser.close over CDP, then (only if needed) the app processes by pid
  if (ws) { send('Browser.close'); }
  else { try { const v = await getJson('http://127.0.0.1:' + PORT + '/json/version'); const b = new WebSocket(v.webSocketDebuggerUrl); b.on('open', () => b.send(JSON.stringify({ id: 1, method: 'Browser.close' }))); b.on('error', () => {}); } catch (e) {} }
  const tc = Date.now();
  for (let i = 0; i < 150; i++) { await sleep(100); if (!alive(app.pid) && !(unpack && procsUnder(unpack).length)) break; }
  r.allGoneAfterCloseMs = Date.now() - tc;
  const left = unpack ? procsUnder(unpack) : [];
  if (left.length) { r.forcedKill = left; for (const p of left) { try { process.kill(p); } catch (e) {} } }
  await sleep(3000);
  r.unpackDirExistsAfterExit = unpack ? fs.existsSync(unpack) : null;
  r.unpackSizeAfterExitMB = unpack && fs.existsSync(unpack) ? dirSizeMB(unpack) : 0;
  try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {}
  console.log(JSON.stringify(r, null, 1));
  fs.writeFileSync(path.join(__dirname, 'portable-probe-' + MODE + '.json'), JSON.stringify(r, null, 1));
  process.exit(0);
})();
