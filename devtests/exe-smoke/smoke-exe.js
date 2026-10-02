// Smoke test of a PACKAGED build: starts the exe with a remote-debugging port, drives the page over the
// Chrome DevTools Protocol, takes screenshots, closes the app.
//   node devtests/exe-smoke/smoke-exe.js [path/to/F1Drive.exe]   (default dist/win-unpacked/F1Drive.exe)
//   env PORT (CDP port, default 9333), TRACK (card text, default monza), OUT (screenshot prefix)
// Exit code 1 when a check fails. A window appears on screen for ~30 s.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'win-unpacked', 'F1Drive.exe'));
const PORT = Number(process.env.PORT || 9333);
const TRACK = (process.env.TRACK || 'monza').toLowerCase();
const OUT = path.join(__dirname, 'out', process.env.OUT || path.basename(path.dirname(EXE)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
}
function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!fs.existsSync(EXE)) { console.log('FAIL exe not found: ' + EXE); process.exit(1); }
  const userData = fs.mkdtempSync(path.join(require('os').tmpdir(), 'f1drive-exe-smoke-'));
  // --mute-audio: the packaged game plays its engine sound with no gesture; nobody at the PC should hear the smoke test
  const app = spawn(EXE, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + userData, '--mute-audio'], { stdio: 'ignore', detached: false });
  let ws, id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT + '-' + name + '.png', Buffer.from(r.data, 'base64'));
  };
  const until = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await js(expr)) return true; } catch (e) { /* page busy */ } await sleep(200); } return false; };
  try {
    let page = null;
    for (let t = 0; t < 60 && !page; t++) {
      await sleep(500);
      try { page = (await getJson('http://127.0.0.1:' + PORT + '/json')).find(p => p.type === 'page' && /index\.html/.test(p.url)); } catch (e) { /* not up yet */ }
    }
    check('app started and exposes its page', !!page, page ? page.url : EXE);
    if (!page) throw new Error('no page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id).res(d.result || {}); pending.delete(d.id); } });
    await send('Runtime.enable');
    const logs = [];
    ws.on('message', m => { const d = JSON.parse(m); if (d.method === 'Runtime.exceptionThrown') logs.push(d.params.exceptionDetails.text); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push(d.params.args.map(a => a.value).join(' ')); });
    await until('document.readyState === "complete" && !!window.F1 && !!F1.game', 15000);
    await sleep(800);
    check('no error overlay at start', await js('document.getElementById("error").classList.contains("hidden")'), await js('document.getElementById("error-text").textContent'));
    check('menu lists the tracks', await js('document.querySelectorAll(".card").length') >= 40);
    check('can host a room (preload API present)', await js('!!(window.f1host && F1.net && F1.net.canCreate)'));
    check('Grand Prix controller present', await js('!!(F1.gp && typeof F1.gp.start === "function")'));
    await shot('1-menu');
    const picked = await js(`(function(){var c=[].slice.call(document.querySelectorAll('.card')).filter(function(n){return n.textContent.toLowerCase().indexOf(${JSON.stringify(TRACK)})>=0;})[0]; if(!c) return null; c.click(); return c.querySelector('.card-name').textContent;})()`);
    check('track card clicked', !!picked, picked);
    check('driving starts', await until('F1.game.running && !!F1.game.track', 15000));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
    await sleep(3000);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
    const v = await js('F1.game.car.state.speed');
    check('W accelerates the car', v > 10, v);
    await shot('2-driving');
    const gpOk = await js(`(function(){ var q=document.getElementById('gp-q'), r=document.getElementById('gp-r'); return !!(q && r && document.getElementById('gp-start')); })()`);
    check('Grand Prix panel present', gpOk);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
    check('Esc opens the menu', await until('!F1.game.running && !document.getElementById("menu").classList.contains("hidden")', 3000));
    await js('document.getElementById("gp-q").value="1"; document.getElementById("gp-r").value="1"; document.getElementById("gp-q").dispatchEvent(new Event("input",{bubbles:true})); document.getElementById("gp-r").dispatchEvent(new Event("input",{bubbles:true})); true');
    await js('document.getElementById("gp-start").click(); true');
    check('Grand Prix qualifying starts from the menu', await until('F1.gp.phase === "quali" && F1.game.running', 5000), await js('F1.gp.phase'));
    await shot('3-quali');
    await js('F1.gp.action("skip"); true');
    check('grid with start lights', await until('F1.gp.phase === "grid"', 3000));
    await sleep(6500);
    await shot('4-lights');
    // v6 (skipped on a v5 build): seasons / cars, pit lane, audio, telemetry
    if (await js('!!(F1.cars && F1.cars.seasons)')) {
      check('v6: 17 seasons 2010..2026', await js('F1.cars.seasons.length === 17 && F1.cars.seasons[0].year === 2010 && F1.cars.seasons[16].year === 2026'));
      check('v6: the track has a pit lane with 16 boxes', await js('!!(F1.game.track.pit && F1.game.track.pit.boxes.length === 16)'));
      check('v6: car spec + tyres + battery', await js('!!(F1.game.spec && F1.game.tyres && typeof F1.game.car.state.battery === "number")'), await js('F1.game.spec && F1.game.spec.id'));
      check('v6: telemetry canvas present', await js('!!document.getElementById("hud-telemetry")'));
      const ab = await js('F1.audio && F1.audio.debug ? F1.audio.debug.backend + "/" + (F1.audio.debug.context && F1.audio.debug.context.state) : "none"');
      check('v6: audio engine running in the packaged app', /^(worklet|nodes)\/running$/.test(ab), ab);
    }
    // v7 (skipped on older builds): computer drivers, set the way a player does (大獎賽 tab → 電腦車手 5), then a race start
    if (await js('typeof F1.createAIDriver === "function"')) {
      await js('F1.gp.action("end"); true');
      await until('F1.gp.phase === "free"', 5000);
      if (await js('F1.game.running')) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
        await until('!F1.game.running', 3000);
      }
      await js('var s = document.getElementById("gp-bots"); s.value = "5"; s.dispatchEvent(new Event("change", { bubbles: true })); true');
      check('v7: 5 computer drivers from the 大獎賽 tab', await until('F1.game.bots && F1.game.bots.length === 5', 15000),
        await js('JSON.stringify({ bots: F1.game.bots ? F1.game.bots.length : null, cfg: F1.game.botCfg, phase: F1.gp.phase, options: document.getElementById("gp-bots").options.length })'));
      await js('document.getElementById("gp-q").value="1"; document.getElementById("gp-r").value="1"; document.getElementById("gp-q").dispatchEvent(new Event("input",{bubbles:true})); document.getElementById("gp-r").dispatchEvent(new Event("input",{bubbles:true})); document.getElementById("gp-start").click(); true');
      await until('F1.gp.phase === "quali"', 5000);
      await js('F1.gp.action("skip"); true');
      check('v7: grid with the bots', await until('F1.gp.phase === "grid"', 5000));
      check('v7: the race starts and the bots drive off', await until('F1.gp.phase === "race" && F1.game.bots.filter(function(b){ return b.car.state.speed > 15; }).length === 5', 25000),
        await js('F1.game.bots.map(function(b){ return Math.round(b.car.state.speed); })'));
      await sleep(3000);
      await shot('5-bots');
      check('v7: the bots appear in the standings', await js('F1.gp.view().rows.filter(function(r){ return r.bot; }).length === 5'));
    }
    check('no page errors', logs.length === 0, logs.slice(0, 5));
  } catch (e) {
    check('smoke run completed', false, e.message);
  } finally {
    try { if (ws) await send('Browser.close').catch(() => {}); } catch (e) { /* closing */ }
    await sleep(1500);
    // the portable exe is a stub that unpacks and starts the real app as a child: /T ends the whole tree
    try { require('child_process').execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' }); } catch (e) { /* already gone */ }
    // (the killed tree lets go of its files a moment later on Windows: retried for up to 5 s, review r3 PKG-5)
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { /* still locked */ }
  }
  const failed = results.filter(r => !r).length;
  console.log((results.length - failed) + ' / ' + results.length + ' checks passed');
  process.exit(failed ? 1 : 0);
})();
