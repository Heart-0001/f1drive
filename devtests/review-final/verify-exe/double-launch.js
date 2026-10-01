// PKG-2 failure scenario: the player double-clicks the portable exe again while the first copy is still starting
// (or already running). Both launches MUTED (--mute-audio), throw-away user-data dirs, CDP ports 9460 / 9461.
// Records what the second launch does (second window? error? exits?), then closes everything it started.
//   node devtests/review-final/verify-exe/double-launch.js [exe]   env GAP_MS (delay between the launches, default 1500)
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'ws'));
const EXE = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'dist', 'F1Drive-v6-preview.exe'));
const GAP = Number(process.env.GAP_MS || 1500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { const q = http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }); q.on('error', rej); q.setTimeout(1000, () => q.destroy(new Error('timeout'))); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const UNPACK = path.join(os.tmpdir(), '3K4Lj2NoKbUMbuJaZcP5IxEZGh3');
function procs() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process F1Drive -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + UNPACK + "*' } | ForEach-Object { $_.Id }"], { encoding: 'utf8' });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch (e) { return []; }
}
function windowsOf(pid) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process -Id " + pid + " -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowTitle }"], { encoding: 'utf8' }).trim();
  } catch (e) { return ''; }
}
async function cdpUp(port) { try { const l = await getJson('http://127.0.0.1:' + port + '/json'); return l.filter(p => p.type === 'page').map(p => p.url.replace(/^.*[\\/]/, '')); } catch (e) { return null; } }
async function browserClose(port) {
  try { const v = await getJson('http://127.0.0.1:' + port + '/json/version'); await new Promise(res => { const b = new WebSocket(v.webSocketDebuggerUrl); b.on('open', () => { b.send(JSON.stringify({ id: 1, method: 'Browser.close' })); setTimeout(res, 300); }); b.on('error', res); }); return true; } catch (e) { return false; }
}

(async () => {
  const r = { exe: EXE, gapMs: GAP, unpackExistedBefore: fs.existsSync(UNPACK) };
  const udA = fs.mkdtempSync(path.join(os.tmpdir(), 'f1drive-verify-dblA-')), udB = fs.mkdtempSync(path.join(os.tmpdir(), 'f1drive-verify-dblB-'));
  const t0 = Date.now();
  const A = spawn(EXE, ['--mute-audio', '--remote-debugging-port=9460', '--user-data-dir=' + udA], { stdio: 'ignore' });
  await sleep(GAP);
  const B = spawn(EXE, ['--mute-audio', '--remote-debugging-port=9461', '--user-data-dir=' + udB], { stdio: 'ignore' });
  r.timeline = [];
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    r.timeline.push({ t: Date.now() - t0, stubA: alive(A.pid), stubB: alive(B.pid), cdpA: await cdpUp(9460), cdpB: await cdpUp(9461), stubBWindow: alive(B.pid) ? windowsOf(B.pid) : '' });
  }
  r.appProcs = procs();
  r.stubBExitCode = B.exitCode;
  // clean up everything we started
  await browserClose(9460); await browserClose(9461);
  await sleep(2000);
  for (const p of [B.pid, A.pid]) { if (alive(p)) { try { process.kill(p); } catch (e) {} } }
  for (const p of procs()) { try { process.kill(p); } catch (e) {} }
  await sleep(3000);
  r.leftProcs = procs();
  r.unpackLeft = fs.existsSync(UNPACK);
  if (r.unpackLeft && !r.unpackExistedBefore && !r.leftProcs.length) { try { fs.rmSync(UNPACK, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); r.unpackRemovedByProbe = true; } catch (e) { r.unpackRemoveErr = e.message; } }
  for (const d of [udA, udB]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {} }
  // compress the timeline to the changes
  let prev = '';
  r.timeline = r.timeline.filter(x => { const k = JSON.stringify(Object.assign({}, x, { t: 0 })); const keep = k !== prev; prev = k; return keep; });
  console.log(JSON.stringify(r, null, 1));
  fs.writeFileSync(path.join(__dirname, 'double-launch.json'), JSON.stringify(r, null, 1));
  process.exit(0);
})();
