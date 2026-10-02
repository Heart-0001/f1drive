// Shared by the Electron harnesses in devtests/gp-e2e/: offscreen windows of the REAL game (real preload, real host
// IPC, real server), the autopilot injected into each page, checks, screenshots.
//
// PATCH=<project file>=<replacement>[,<project file>=<replacement>...]   (paths relative to the project root, or absolute)
//   runs the harness against modified COPIES of project files without touching the project:
//     - scripts of the page (js/*.js, net/session.js, tracks-data.js ...): the page is loaded from a copy of index.html
//       (in the out folder, with a <base> pointing at the project) whose <script src> tags point at the replacements;
//       index.html=<file> replaces the page itself
//     - files of the main process (net/server.js, net/session.js, net/host.js): require() is redirected to the
//       replacement; its own relative require()s resolve as if it lay in the project
//   e.g. PATCH='js/ui.js=devtests/gp-e2e/patched/ui.js' npx electron devtests/gp-e2e/online.js
'use strict';
const fs = require('fs'), path = require('path'), url = require('url'), Module = require('module');
const refCar = require('../ref-car');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);

/* ---------- PATCH ---------- */
const patches = {};                       // project-relative path (forward slashes) -> absolute replacement
(process.env.PATCH || '').split(',').map(s => s.trim()).filter(Boolean).forEach(spec => {
  const k = spec.indexOf('=');
  if (k < 0) throw new Error('PATCH: expected <project file>=<replacement>, got ' + spec);
  const rel = spec.slice(0, k).replace(/\\/g, '/').replace(/^\.\//, ''), file = path.resolve(ROOT, spec.slice(k + 1));
  if (!fs.existsSync(path.join(ROOT, rel))) throw new Error('PATCH: no such project file: ' + rel);
  if (!fs.existsSync(file)) throw new Error('PATCH: replacement not found: ' + file);
  patches[rel] = file;
});
const patched = Object.keys(patches);
{
  // main process: redirect require() of a patched project file; a replacement's relative requires resolve from the original's folder
  const byOrig = {}, byRepl = {};
  patched.forEach(rel => { const o = path.join(ROOT, rel); byOrig[o.toLowerCase()] = patches[rel]; byRepl[patches[rel].toLowerCase()] = o; });
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    let r;
    const from = parent && parent.filename && byRepl[parent.filename.toLowerCase()];
    if (from && /^\.\.?[\\/]/.test(request)) r = orig.call(this, path.resolve(path.dirname(from), request), parent, ...rest);
    else r = orig.call(this, request, parent, ...rest);
    return byOrig[String(r).toLowerCase()] || r;
  };
}

// The page to load: the real index.html, or a copy whose script tags point at the replacements.
let pageFileMade = '';
function pageFile() {
  if (!pageFileMade) pageFileMade = makePageFile();
  return pageFileMade;
}
function makePageFile() {
  const pagePatches = patched.filter(rel => rel === 'index.html' || /\.js$/.test(rel));
  let html = fs.readFileSync(patches['index.html'] || path.join(ROOT, 'index.html'), 'utf8'), changed = !!patches['index.html'];
  pagePatches.forEach(rel => {
    const tag = '<script src="' + rel + '"></script>';
    if (rel === 'index.html' || html.indexOf(tag) < 0) return;          // (a main-process-only file)
    html = html.replace(tag, '<script src="' + url.pathToFileURL(patches[rel]).href + '"></script>');
    changed = true;
  });
  if (!changed) return path.join(ROOT, 'index.html');
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'index-patched-' + process.pid + '.html');
  process.on('exit', () => { try { fs.unlinkSync(file); } catch (e) {} });
  fs.writeFileSync(file, html.replace('<head>', '<head><base href="' + url.pathToFileURL(ROOT + path.sep).href + '">'));
  return file;
}

/* ---------- checks ---------- */
const results = [];
let part = '';
function setPart(p) { part = p; console.log('\n=== ' + p + ' ===   [' + new Date().toISOString().slice(11, 19) + ']'); }
function check(name, ok, detail) {
  results.push({ name: part + ': ' + name, ok: !!ok });
  let d = detail === undefined ? '' : '  ' + (typeof detail === 'string' ? detail : J(detail));
  if (d.length > 1500) d = d.slice(0, 1500) + ' ...';
  console.log((ok ? 'PASS ' : 'FAIL ') + part + ': ' + name + d);
  return !!ok;
}
function info(text) { console.log('     ' + text); }
function summary() {
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '\nFAILED:\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  return bad.length;
}

/* ---------- windows ---------- */
const AUTOPILOT = fs.readFileSync(path.join(__dirname, 'autopilot.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
let winSeq = 0;

// electron = require('electron'), host = require(ROOT/net/host) (or null: no room), opts {fps, width, height, fresh}
// The window drives the reference car (2025-standard, the v5 car the autopilot was tuned on): picked before the game
// boots (devtests/ref-car.js; since v6.1 a fresh install drives the 2026 standard car). opts.fresh: a fresh install.
function makeWin(electron, host, tag, opts) {
  opts = opts || {};
  const w = new electron.BrowserWindow({
    width: opts.width || 1280, height: opts.height || 720, show: false, useContentSize: true,
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'gpe2e-' + tag + '-' + (++winSeq),
      preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false
    }
  });
  w.webContents.setFrameRate(opts.fps || 60);
  w.errors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;    // dev-only CSP notice
    w.errors.push(msg);
    console.log('[' + tag + ' console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  w.webContents.on('render-process-gone', (e, d) => { w.errors.push('render process gone: ' + d.reason); console.log('[' + tag + '] render process gone', d.reason); });
  if (host) host.attach(w);
  w.tag = tag;
  w.js = code => w.webContents.executeJavaScript(code);
  w.e = (call) => w.js('__e2e.' + call);
  w.shot = async n => {
    await sleep(120);                                   // (a DOM change made just now must have been painted)
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, n + '.png');
    fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
    return file;
  };
  w.key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: k });
  w.tap = async k => { w.key(k, true); await sleep(60); w.key(k, false); await sleep(120); };
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(40); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  w.open = async () => {
    if (!opts.fresh) await refCar.seed(w);
    await w.loadFile(pageFile());
    await sleep(900);
    await w.js(AUTOPILOT + '\n;true');
    await w.js(PAGE);
    return w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  };
  w.field = (id, v) => w.js(`(function () { var e = document.getElementById(${J(id)}); e.value = ${J(v)};
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
  // a real mouse click in the middle of an element
  w.click = async id => {
    const r = await w.js(`(function () { var e = document.getElementById(${J(id)}), r = e.getBoundingClientRect();
      if (r.width > 0 && (r.top < 0 || r.bottom > innerHeight)) { e.scrollIntoView({ block: 'center' }); r = e.getBoundingClientRect(); }
      var x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, h: r.height, hit: !!top && (top === e || e.contains(top)), disabled: !!e.disabled }; })()`);
    if (!(r.w > 0 && r.h > 0) || !r.hit || r.disabled) { console.log('click: ' + tag + ' #' + id + ' cannot be clicked ' + J(r)); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return true;
  };
  // a real mouse click on the first element matching a CSS selector (scrolled into view)
  w.clickSel = async sel => {
    const id = await w.js(`(function () { var e = document.querySelector(${J(sel)}); if (!e) return null; if (!e.id) e.id = '__e2e-click-' + Math.random().toString(36).slice(2); return e.id; })()`);
    if (!id) { console.log('click: ' + tag + ' ' + sel + ' not found'); return false; }
    return w.click(id);
  };
  // a track card, by id or name part (a real click on the card would need scrolling: the card's own click handler is used).
  // v7.2: alone the card opens the start panel, then 開始 (free practice; its mode button first) drives; in a room the
  // host's card sets the room's track (the lobby's picker opened first) and nothing loads before the room's 開始.
  w.pick = name => w.js(`(function () { var k = F1_TRACKS.findIndex(function (t) { return t.id === ${J(name)} || t.name.toLowerCase().indexOf(${J(name)}) >= 0; });
    if (k < 0) return null;
    var room = !!(F1.net && F1.net.connected), b = document.getElementById('setup-track-btn');
    if (room && F1.game.setup && F1.game.setup.show !== 'picker' && b) b.click();
    document.querySelector('#track-grid .card[data-i="' + k + '"]').click();
    if (!room) { var m = document.querySelector('#setup-mode [data-m="free"]'); if (m) m.click(); var g = document.getElementById('setup-go'); if (g) g.click(); }
    return F1_TRACKS[k].id + ' ' + F1_TRACKS[k].name; })()`);
  w.noErrors = async () => {
    const overlay = w.isDestroyed() ? 'window destroyed' : await w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
    check(tag + ': no error overlay, no console errors', !overlay && w.errors.length === 0, overlay || w.errors.slice(0, 3));
  };
  return w;
}

const fmt = t => t == null ? '--' : Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');
// js/ui.js fmtTime: the HUD cuts to the millisecond
const hudTime = t => { if (t == null) return '--'; const ms = Math.floor(t * 1000 + 1e-6); const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return m + ':' + String(s).padStart(2, '0') + '.' + String(r).padStart(3, '0'); };
const hudGap = g => { if (!(g > 0)) g = 0; return '+' + (g < 60 ? (Math.floor(g * 1000 + 1e-6) / 1000).toFixed(3) : hudTime(g)); };

/* ---------- v7.2 rooms: the lobby (docs/lobby-design.md): nobody drives before the host's 開始 and the loading barrier ---------- */
// The host's lobby settings through the lobby's own controls: {track, mode: 'free' | 'gp', q, r, wear, bots, skill}.
async function roomSet(hostW, o) {
  if (o.track) {
    await hostW.pick(o.track);
    if (!await hostW.until(`F1.net.room.set.track === ${J(o.track)} && F1.game.setup.show === 'setup'`, 3000, 'room track')) return false;
  }
  if (o.mode) await hostW.clickSel(`#setup-mode [data-m="${o.mode}"]`);
  if (o.q !== undefined) await hostW.field('gp-q', String(o.q));
  if (o.r !== undefined) await hostW.field('gp-r', String(o.r));
  if (o.wear !== undefined) await hostW.clickSel(`#gp-wear button[data-w="${o.wear}"]`);
  if (o.bots !== undefined) await hostW.js(`(function () { var e = document.getElementById('gp-bots'); e.value = ${J(String(o.bots))}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (o.skill) await hostW.clickSel(`#gp-skill button[data-s="${o.skill}"]`);
  const want = {};
  ['track', 'mode', 'q', 'r', 'wear', 'bots', 'skill'].forEach(k => { if (o[k] !== undefined) want[k] = typeof o[k] === 'string' && /^\d+$/.test(o[k]) ? +o[k] : o[k]; });
  return hostW.until(`(function () { var s = F1.net.room.set, w = ${J(want)}; for (var k in w) if (s[k] !== w[k]) return false; return true; })()`, 3000, 'room settings ' + J(want));
}
// The guests press 準備 (those not ready yet), the host 開始 (again after START_MIN_MS if the server said busy; force: through
// 「不等了，直接開始」 and its confirmation); everybody loads, the session begins after the barrier. o.gp: wait for
// qualifying. -> true when every window drives in the room's session
async function roomStart(hostW, guests, o) {
  o = o || {};
  if (!o.force) for (const g of guests) {
    if (!await g.js(`!!(F1.net.room && F1.net.room.ready.indexOf(F1.net.id) >= 0)`)) await g.click('setup-ready');
  }
  if (!o.force && !await hostW.until(`F1.game.setup && F1.game.setup.go.enabled`, 5000, 'everybody ready')) return false;
  for (let k = 0; k < 3; k++) {
    if (o.force && await hostW.js(`!!(F1.game.setup && F1.game.setup.force)`)) { await hostW.click('setup-force'); await hostW.click('setup-force-yes'); }
    else await hostW.click('setup-go');
    if (await hostW.until(`F1.net.room.st !== 'lobby'`, 1500, 'room loading')) break;
    await sleep(1100);
  }
  const cond = `F1.net.room && F1.net.room.st === 'session' && F1.game.running` + (o.gp ? ` && F1.game.gp.phase === 'quali'` : '');
  let ok = true;
  for (const w of [hostW].concat(guests)) ok = await w.until(cond, o.ms || 40000, 'room session') && ok;
  return ok;
}
// The host takes the room back to the lobby: Esc (the room menu) and 回到大廳 (confirmed where a Grand Prix would end);
// in the results the overlay's 回到大廳. -> every window in `all` in the lobby, off the track
async function roomBack(hostW, all) {
  // (again after START_MIN_MS: the server drops a back within 1 s of the host's last start)
  for (let k = 0; k < 3 && await hostW.js(`F1.net.room.st !== 'lobby'`); k++) {
    if (await hostW.js(`F1.game.gp.phase === 'results' && !document.getElementById('gp-res-lobby').classList.contains('hidden') && !document.getElementById('gp-results').classList.contains('hidden')`)) await hostW.click('gp-res-lobby');
    else {
      if (await hostW.js(`F1.game.running`)) await hostW.tap('Escape');
      await hostW.click('setup-lobby');
      if (await hostW.js(`!document.getElementById('setup-confirm').classList.contains('hidden')`)) await hostW.click('setup-force-yes');
    }
    if (await hostW.until(`F1.net.room.st === 'lobby'`, 1500, 'back')) break;
    await sleep(1100);
  }
  let ok = true;
  for (const w of all || [hostW]) ok = await w.until(`F1.net.room.st === 'lobby' && !F1.game.running`, 5000, 'lobby') && ok;
  return ok;
}

module.exports = { ROOT, OUT, sleep, J, patched, patches, pageFile, check, info, setPart, summary, makeWin, fmt, hudTime, hudGap, results,
  roomSet, roomStart, roomBack };
