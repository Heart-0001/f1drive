// Cold-start timing of a packaged build (portable exe or win-unpacked exe), MUTED (--mute-audio), with a fresh
// user-data dir (first run) and then a second run (warm). Measures: spawn -> CDP endpoint up, -> page listed,
// -> F1.game present (boot), -> first track driving. Also: what the portable exe leaves in %TEMP%, and the
// renderer's WebGL / audio state. Closes the app through CDP (Browser.close).
//   node devtests/review-final/perf/exe-start.js <exe> [runs=2]      env PORT (9340), FIRSTRUN=1 (also time a run with
//   NO --user-data-dir, i.e. the real first-run userData under %APPDATA%: only if it does not exist yet)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const WebSocket = require('ws');
const EXE = path.resolve(process.argv[2]);
const RUNS = Number(process.argv[3] || 2);
const PORT = Number(process.env.PORT || 9340);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej); });

function tempDirs() { return fs.readdirSync(os.tmpdir()).filter(n => /^[0-9a-f]{6,}|nsis|7z|F1Drive/i.test(n)); }

async function run(label, userData) {
  const before = new Set(fs.readdirSync(os.tmpdir()));
  const t0 = Date.now();
  const args = ['--remote-debugging-port=' + PORT, '--mute-audio'];
  if (userData) args.push('--user-data-dir=' + userData);
  const app = spawn(EXE, args, { stdio: 'ignore' });
  const r = { label, pid: app.pid };
  let page = null;
  for (let t = 0; t < 240 && !page; t++) {
    await sleep(250);
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json');
      if (r.cdpUpMs === undefined) r.cdpUpMs = Date.now() - t0;
      page = list.find(p => p.type === 'page' && /index\.html/.test(p.url));
    } catch (e) { /* not up */ }
  }
  r.pageListedMs = Date.now() - t0;
  if (!page) { r.error = 'no page'; try { process.kill(app.pid); } catch (e) {} return r; }
  let ws, id = 0; const pending = new Map();
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const js = async expr => { const x = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return x.result && x.result.value; };
  // the target's socket is dropped (1006) while the initial navigation commits: connect until an evaluate answers
  for (let attempt = 0; attempt < 40; attempt++) {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json').catch(() => []);
    page = list.find(p => p.type === 'page' && /index\.html/.test(p.url));
    if (!page) { await sleep(250); continue; }
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('error', () => {});
    const ok = await new Promise(res => { ws.on('open', () => res(true)); ws.on('error', () => res(false)); ws.on('close', () => res(false)); });
    if (!ok) { await sleep(250); continue; }
    ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || {}); pending.delete(d.id); } });
    const alive = await Promise.race([js('1'), new Promise(res => ws.on('close', () => res(null))), sleep(2000).then(() => null)]);
    if (alive === 1) { r.cdpAttempts = attempt + 1; break; }
    try { ws.close(); } catch (e) {}
    pending.clear();
    await sleep(250);
  }
  while (!(await js('!!(window.F1 && F1.game && document.readyState === "complete")'))) await sleep(50);
  r.bootMs = Date.now() - t0;
  r.state = await js(`({ overlay: document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent,
     cards: document.querySelectorAll('.card').length, host: !!window.f1host,
     gl: (function(){ var c = document.createElement('canvas'); var g = c.getContext('webgl2'); if (!g) return 'none'; var d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })(),
     audio: F1.audio && F1.audio.debug ? F1.audio.debug.backend + '/' + (F1.audio.debug.context && F1.audio.debug.context.state) : 'none',
     dpr: window.devicePixelRatio, size: [innerWidth, innerHeight], store: (function(){ try { return Object.keys(localStorage); } catch (e) { return String(e); } })() })`);
  // first track: click Monza, wait for running
  const t1 = Date.now();
  await js(`(function(){ var i = F1_TRACKS.findIndex(function(t){ return t.id === 'it-1922'; }); document.querySelectorAll('#track-grid .card')[i].click(); return true; })()`);
  while (!(await js('F1.game.running && !!F1.game.track'))) await sleep(50);
  r.firstTrackMs = Date.now() - t1;
  // frame cost on the REAL window / GPU, 8 s of driving (W)
  await js(`window.__f = []; (function(){ var raf = window.requestAnimationFrame; window.requestAnimationFrame = function(cb){ return raf.call(window, function(t){ var s = performance.now(); cb(t); window.__f.push(performance.now() - s); }); }; })(); true`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  const tf = Date.now();
  await sleep(8000);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  const f = await js(`(function(){ var f = window.__f.slice().sort(function(a,b){return a-b;}); var s = 0; for (var i = 0; i < f.length; i++) s += f[i]; return { n: f.length, mean: s / f.length, p50: f[f.length >> 1], p95: f[Math.floor(f.length * .95)], max: f[f.length - 1], speed: F1.game.car.state.speed, heapMB: performance.memory.usedJSHeapSize / 1048576 }; })()`);
  f.fps = +(f.n / ((Date.now() - tf) / 1000)).toFixed(1);
  r.drive = f;
  r.muted = await js('(function(){ var d = F1.audio.debug; return { backend: d.backend, state: d.context && d.context.state, frames: d.frames }; })()');
  send('Browser.close').catch(() => {}); await sleep(300);
  ws.close();
  for (let i = 0; i < 100; i++) { await sleep(100); try { process.kill(app.pid, 0); } catch (e) { r.exitMs = i * 100; break; } }
  await sleep(2000);
  r.tempLeft = fs.readdirSync(os.tmpdir()).filter(n => !before.has(n));
  return r;
}

(async () => {
  console.log('exe', EXE, fs.statSync(EXE).size, 'bytes');
  const out = [];
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'f1drive-review-ud-'));
  for (let i = 0; i < RUNS; i++) { const r = await run(i === 0 ? 'fresh-userdata' : 'warm-userdata', ud); console.log(JSON.stringify(r)); out.push(r); }
  if (process.env.FIRSTRUN) {
    const real = path.join(process.env.APPDATA, 'F1Drive');
    if (fs.existsSync(real)) console.log('real userData exists already, skipping first-run test:', real);
    else { const r = await run('real-first-run', null); console.log(JSON.stringify(r)); out.push(r); console.log('created real userData:', fs.existsSync(real), real, fs.existsSync(real) ? fs.readdirSync(real) : ''); }
  }
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  fs.writeFileSync(path.join(__dirname, 'exe-start-' + path.basename(EXE, '.exe') + '.json'), JSON.stringify(out, null, 1));
})();
