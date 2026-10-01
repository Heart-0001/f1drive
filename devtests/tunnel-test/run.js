// Monaco's tunnel (js/tunnels.js) in the REAL game: index.html in an offscreen, MUTED Electron window
// (devtests/electron-userdata.js). page.js (injected) loads js/tunnels.js into the running page, builds it for the current
// track through the F1.game peek and adds its group to the scene; nothing in the project is edited.
//   npx electron devtests/tunnel-test/run.js
//   env TRACK (default mc-1929)  TAG (output folder out/<TAG>, default 'now')  ONLY=shots|drive|perf (comma list)
//       MODE=rec|off (the lighting prototype in the cockpit shots; default rec)   WHICH=<n> (the n-th covered stretch;
//       default the first 'tunnel', else the first)
// Screenshots in out/<TAG>/*.png (READ them), numbers in out/<TAG>/results.json and on stdout. Exit code 1 when a check fails.
'use strict';
const path = require('path'), fs = require('fs');
const { app, BrowserWindow } = require('electron');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'tunnel');
const TRACK = process.env.TRACK || 'mc-1929';
const TAG = process.env.TAG || 'now';
const OUT = path.join(__dirname, 'out', TAG);
fs.mkdirSync(OUT, { recursive: true });
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = g => !ONLY.length || ONLY.indexOf(g) >= 0;
const MODE = process.env.MODE || 'rec';
const PAGE = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const results = { track: TRACK, checks: [], build: null, shots: [], drive: [], perf: [] };
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : J(detail)) : ''));
  return !!ok;
}

function makeWin(W, H) {
  const w = new BrowserWindow({
    width: W, height: H, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(ROOT, 'preload.js'), partition: 'tn-' + Date.now() }
  });
  w.webContents.setFrameRate(60);
  w.errors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    w.errors.push(msg);
    console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  w.webContents.on('render-process-gone', (e, d) => { w.errors.push('renderer gone: ' + d.reason); console.log('renderer gone', d.reason); });
  w.js = code => w.webContents.executeJavaScript(code);
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 8000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(50); }
    console.log('TIMEOUT ' + (what || code));
    return false;
  };
  w.shot = async (name, note) => {
    await sleep(260);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    const st = await w.js('__tn.state()');
    results.shots.push({ name, note: note || '', state: st });
    console.log('shot ' + name + '.png ' + J(st));
    return img;
  };
  return w;
}

async function boot(w) {
  for (let k = 0; k < 4; k++) {
    try { await w.loadFile(path.join(ROOT, 'index.html')); break; } catch (e) { console.log('load retry ' + k + ': ' + e.message); await sleep(500); }
  }
  await sleep(1000);
  const overlay = await w.js(`(function(){ var e = document.getElementById('error'); return e && !e.classList.contains('hidden') ? (document.getElementById('error-text') || e).textContent : ''; })()`);
  if (overlay) { check('game boots without the error overlay', false, overlay.slice(0, 400)); return false; }
  console.log('page: ' + await w.js(PAGE) + ' / ' + await w.js('__tn.hook()'));
  return true;
}

async function pickTrack(w, id) {
  const ok = await w.js(`(function () { var i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; });
    var c = document.querySelector('#track-grid .card[data-i="' + i + '"]'); if (!c) return false; c.click(); return true; })()`);
  if (!ok) return false;
  return w.until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)} && __tn.renderer`, 30000, 'track ' + id);
}

async function main() {
  await app.whenReady();
  const w = makeWin(1280, 720);
  let failed = false;
  try {
    if (!await boot(w)) throw new Error('boot');
    if (!check('track ' + TRACK + ' running', await pickTrack(w, TRACK))) throw new Error('track');
    await sleep(800);
    check('js/tunnels.js loads into the page', (await w.js(`__tn.load('js/tunnels.js')`)) === 'loaded');
    const b = await w.js('__tn.build()');
    results.build = b;
    console.log('build ' + J(b));
    check('built: tunnels', b.tunnels.length > 0, b.tunnels.map(t => t.name + ' ' + t.from + '..' + t.to + ' ' + t.length + ' m').join(', '));
    check('build time < 60 ms', b.ms < 60, b.ms + ' ms');
    check('draw calls <= 5', b.stats.drawCalls <= 5, b.stats.drawCalls);
    results.lights = await w.js('__tn.findLights()');
    const T = process.env.WHICH ? b.tunnels[+process.env.WHICH] : (b.tunnels.find(t => t.kind === 'tunnel') || b.tunnels[0]);
    const P = b.tunnels.find(t => t.kind === 'underpass');
    const N = await w.js('F1.game.track.samples.length');
    const at = k => ((k % N) + N) % N;
    const mid = at(T.from + Math.round(((T.to - T.from + N) % N) / 2));
    results.T = { from: T.from, to: T.to, mid, N };
    await w.js(`__tn.setMode(${J(MODE)})`);

    if (want('shots')) {
      await w.js('__tn.ext(null); __tn.hud(true)');
      const cockpit = [
        ['c1-approach', T.from - 35, 'cockpit 70 m before the entry portal'],
        ['c2-portal', T.from - 8, 'cockpit 16 m before the entry'],
        ['c3-inside-entry', T.from + 12, 'cockpit 24 m inside'],
        ['c4-inside-mid', mid, 'cockpit in the middle'],
        ['c5-exit-view', T.to - 35, 'cockpit 70 m before the exit'],
        ['c6-exit', T.to + 4, 'cockpit just out of the exit'],
      ];
      if (P) cockpit.push(['c7-portier', P.from - 14, 'cockpit before the Portier underpass']);
      for (const [name, i, note] of cockpit) {
        await w.js(`__tn.place({ i: ${at(i)} })`);
        await w.shot(name, note);
      }
      await w.js(`__tn.setMode('off')`);
      await w.js(`__tn.place({ i: ${mid} })`);
      await w.shot('c8-inside-mid-nolight', 'cockpit in the middle, scene lights unchanged (module alone)');
      await w.js(`__tn.setMode(${J(MODE)})`);

      // outside views (HUD hidden); the car stands at the entry
      await w.js(`__tn.hud(false); __tn.place({ i: ${at(T.from + 6)} })`);
      const ext = [
        ['e1-entry-portal', { at: at(T.from - 24), d: 4, h: 4, look: { at: at(T.from + 2), d: 0, h: 6 }, fov: 60, viewIdx: null }, 'the entry portal from the road, 48 m out'],
        ['e2-exit-portal', { at: at(T.to + 40), d: -2, h: 4, look: { at: at(T.to - 2), d: 0, h: 5 }, fov: 55, viewIdx: null }, 'the exit portal from the chicane side'],
        ['e3-aerial', { at: mid, d: 120, h: 90, look: { at: mid, d: 0, h: 0 }, fov: 55, viewIdx: null }, 'aerial from the sea side'],
        ['e4-seaside', { at: at(mid - 20), d: 55, h: 6, look: { at: at(mid - 20), d: 0, h: 6 }, fov: 60, viewIdx: null }, 'the tunnel block from the sea side, low'],
        ['e5-inside-chase', { at: at(T.from + 1), d: 0, h: 2.8, look: { at: at(T.from + 14), d: 0, h: 1.2 }, fov: 60, viewIdx: at(T.from + 1) }, 'inside, behind the car near the entry'],
        ['e6-inside-wide', { at: at(mid - 8), d: -9, h: 4.5, look: { at: at(mid + 25), d: 4, h: 2.5 }, fov: 70, viewIdx: at(mid - 8) }, 'inside, wide from the right wall'],
        ['e7-entry-aerial', { at: at(T.from - 60), d: -20, h: 45, look: { at: at(T.from + 10), d: 0, h: 5 }, fov: 55, viewIdx: null }, 'the entry from above (Portier side)'],
      ];
      if (P) ext.push(['e8-portier', { at: at(P.from - 30), d: -4, h: 6, look: { at: at(P.from + 4), d: 0, h: 4 }, fov: 55, viewIdx: null }, 'the Portier underpass from the road']);
      for (const [name, spec, note] of ext) {
        if (name === 'e5-inside-chase' || name === 'e6-inside-wide') await w.js(`__tn.place({ i: ${spec.look.at - 4} })`);
        console.log('ext ' + name + ' ' + J(await w.js(`__tn.ext(${J(spec)})`)));
        await w.shot(name, note);
      }
      // the car touching the left (sea side) barrier in the middle, seen from behind: the barrier stops it, the tunnel
      // wall stands right behind the barrier
      const wd = await w.js(`F1.game.track.samples[${mid}].wallPosDist`);
      await w.js(`__tn.place({ i: ${mid}, d: ${wd - 1.05} })`);
      await w.js(`__tn.ext(${J({ at: at(mid - 6), d: wd - 4, h: 2.2, look: { at: at(mid + 3), d: wd - 0.5, h: 1.2 }, fov: 60, viewIdx: mid })})`);
      await w.shot('e9-wall-contact', 'car against the left barrier mid-tunnel');
      await w.js('__tn.ext(null); __tn.hud(true)');
    }

    if (want('drive')) {
      // the real loop: start after Portier at 150 km/h, full throttle on the centreline through the tunnel
      await w.js('__tn.ext(null); __tn.hud(true)');
      const start = at(T.from - 25);
      await w.js(`__tn.place({ i: ${start}, v: ${150 / 3.6} })`);
      await w.js(`__tn.drive({ look: 24, k: 2.0, thr: 1, vmax: ${290 / 3.6} })`);
      const t0 = Date.now();
      let k = 0, maxHit = 0, lastI = start, passed = false;
      while (Date.now() - t0 < 14000) {
        const st = await w.js('__tn.state()');
        results.drive.push(Object.assign({ t: Date.now() - t0 }, st));
        const rel = ((st.i - T.from) + N) % N;
        if (rel <= (T.to - T.from + N) % N) maxHit = Math.max(maxHit, st.hit || 0);   // (the corner after it is the autopilot's problem)
        if (k < 8 && ((k === 0 && rel > N - 12) || (k > 0 && rel < (T.to - T.from + N) % N + 30 && rel >= (k - 1) * 45))) {
          await w.shot('d' + k + '-drive', 'driving: ' + st.v + ' km/h at sample ' + st.i);
          k++;
        }
        if (rel > ((T.to - T.from + N) % N) + 30 && rel < N / 2) { passed = true; break; }
        lastI = st.i;
        await sleep(90);
      }
      check('autopilot drove through the tunnel', passed, results.drive.length ? results.drive[results.drive.length - 1] : null);
      check('no wall contact between the portals on the centreline', maxHit === 0, maxHit);
      // the sun goes out inside (a short underpass only dims it), the hemisphere light dips in a long tunnel; both back after
      const ap = results.drive.filter(s => s.applied).map(s => s.applied), mins = await w.js('__tn.minApplied');
      const sunMin = mins.sun, hemiMin = mins.hemi;
      const last = ap[ap.length - 1] || {};
      check('scene light (prototype of the main.js integration) dips inside and comes back', sunMin < (T.length > 60 ? 0.2 : 0.95) &&
        (T.length > 150 ? hemiMin < 0.9 : true) && last.sun === 1 && last.hemi === 1, { sunMin, hemiMin, last });
      await w.js('__tn.freeze()');
    }

    if (want('perf')) {
      await w.js('__tn.ext(null); __tn.hud(true)');
      for (const [label, i] of [['approach', at(T.from - 35)], ['inside', mid], ['exit-view', at(T.to - 35)]]) {
        await w.js(`__tn.place({ i: ${i} })`);
        await sleep(300);
        const p = await w.js('__tn.perf(60)');
        p.label = label;
        results.perf.push(p);
        console.log('perf ' + J(p));
      }
      await w.js('__tn.frameStats()');
      await sleep(3000);
      results.frame = await w.js('__tn.frameStats()');
      console.log('frame ' + J(results.frame));
    }
    const errs = await w.js('__tn.errs');
    check('no page errors', !errs.length && !w.errors.length, errs.concat(w.errors).slice(0, 5));
  } catch (e) {
    console.log('ERR ' + (e && e.stack || e));
    failed = true;
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  failed = failed || results.checks.some(c => !c.ok);
  console.log((failed ? 'FAILED' : 'OK') + ' ' + results.checks.filter(c => c.ok).length + '/' + results.checks.length + ' checks; out/' + TAG);
  app.exit(failed ? 1 : 0);
}
main();
