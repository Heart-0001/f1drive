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

// electron = require('electron'), host = require(ROOT/net/host) (or null: no room), opts {fps, width, height}
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
  // a track card, by id or name part (a real click on the card would need scrolling: the card's own click handler is used)
  w.pick = name => w.js(`(function () { var k = F1_TRACKS.findIndex(function (t) { return t.id === ${J(name)} || t.name.toLowerCase().indexOf(${J(name)}) >= 0; });
    if (k < 0) return null; document.querySelectorAll('.card')[k].click(); return F1_TRACKS[k].id + ' ' + F1_TRACKS[k].name; })()`);
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

module.exports = { ROOT, OUT, sleep, J, patched, patches, pageFile, check, info, setPart, summary, makeWin, fmt, hudTime, hudGap, results };
