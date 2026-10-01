// Harness for js/telemetry.js (the bottom-centre broadcast graphic), no main.js needed.
// Loads page.html (the canvas over a screenshot of the game: bg.png, copied from devtests/gp-smoke/out/a2-driving.png
// when that exists) in an offscreen Electron window and drives F1.telemetry.draw() with the scripted states of
// states.js on a fake clock (ending where the flashing is 'on'; *-off variants 250 ms later).
//   shots   per window size: a contact sheet of every state, out/sheet-<width>-dpr<n>-<k>.png (crops at 1:1 device
//           pixels), and whole-window shots out/full-<width>-dpr<n>-<state>.png for five states
//   checks  backing store = CSS box x devicePixelRatio (both sizes); the speed digits keep their right edge for
//           0 / 9 / 99 / 100 / 345 km/h; junk input never throws; pedal smoothing (>= 75 % of a step within 50 ms,
//           steady under on/off every frame); a team change reaches the screen; per frame no DOM access and only
//           boxed numbers on the JS heap (fresh page, one state object as main.js passes it); a hidden canvas is
//           skipped and drawn again when shown; zoom 150 % (devicePixelRatio change) resizes the backing store
//   bench   FRAMES draw() calls back to back and FRAMES frames driven by requestAnimationFrame (240 Hz), per size
//   npx electron devtests/telemetry-test/shots.js                 both 1280x720 and 1920x1080 at devicePixelRatio 1,
//                                                                 then itself again at devicePixelRatio 2 (child process)
//   env DPR=1|2|1.5 (one pass only), ONLY=shots|checks|bench (comma list), FRAMES=10000. Exit code. ~3.5 min.
// Diagnostics (no verdict): probe-cost.js (where a frame's time goes), probe-alloc.js (JS heap allocation sites).
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');

const DPR = process.env.DPR ? Number(process.env.DPR) : 0;          // 0 = run 1 here, then 2 in a child
const PASS_DPR = DPR || 1;
// always forced: an offscreen window otherwise takes the primary display's scale (1.5 on the development PC)
app.commandLine.appendSwitch('force-device-scale-factor', String(PASS_DPR));
// gc() and exact performance.memory for the allocation check
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.commandLine.appendSwitch('enable-precise-memory-info');
require('../electron-userdata')(app, 'telemetry-' + PASS_DPR);

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const ONLY = process.env.ONLY || '';
const FRAMES = Number(process.env.FRAMES) || 10000;
const part = p => !ONLY || ONLY.split(',').indexOf(p) >= 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}

const { SCEN, S } = require('./states');

/* ---------- one pass: this process's devicePixelRatio, two window sizes ---------- */
async function pass() {
  fs.mkdirSync(OUT, { recursive: true });
  // background: a real screenshot of the game if one is around
  const bg = path.join(__dirname, 'bg.png');
  if (!fs.existsSync(bg)) {
    const src = path.join(ROOT, 'devtests', 'gp-smoke', 'out', 'a2-driving.png');
    if (fs.existsSync(src)) fs.copyFileSync(src, bg);
  }
  const bgUrl = fs.existsSync(bg) ? url.pathToFileURL(bg).href : '';
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  const consoleErrors = [];
  w.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2 && msg.indexOf('Electron Security Warning') >= 0) return;
    // the harness's own pixel readbacks and the deliberately throwing getter of the junk test are expected
    if (/willReadFrequently/.test(msg) || /F1.telemetry: Error: boom/.test(msg)) return;
    if (level >= 2) { consoleErrors.push(msg); console.log('[console ' + level + ']', msg); }
  });
  const js = code => w.webContents.executeJavaScript(code);
  const tag = 'dpr' + PASS_DPR;
  const save = (name, img) => fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());

  try {
    const pageUrl = url.pathToFileURL(path.join(__dirname, 'page.html')).href + (bgUrl ? '?bg=' + encodeURIComponent(bgUrl) : '');
    await w.loadURL(pageUrl);
    await sleep(300);
    check(tag + ': init() returns true', await js('__init()') === true);

    for (const [W, H] of [[1280, 720], [1920, 1080]]) {
      w.setContentSize(W, H);
      await sleep(400);
      const vp = await js('[innerWidth, innerHeight, devicePixelRatio]');
      const size = W + 'x' + H + '@' + PASS_DPR;
      check(size + ': viewport', vp[0] === W && vp[1] === H && vp[2] === PASS_DPR, vp);
      const info = await js(`__show(${JSON.stringify(SCEN[0][1])})`);
      const expW = Math.round(info.cssW * PASS_DPR), expH = Math.round(info.cssH * PASS_DPR);
      check(size + ': backing store = CSS box x devicePixelRatio', Math.abs(info.w - expW) <= 1 && Math.abs(info.h - expH) <= 1,
        { css: [info.cssW, info.cssH], backing: [info.w, info.h] });

      if (part('shots')) {
        const crops = [];
        for (const [name, st, opts] of SCEN) {
          await js(`__show(${JSON.stringify(st, (k, v) => (typeof v === 'number' && !isFinite(v)) ? String(v) : v)
            .replace(/"(NaN|Infinity|-Infinity)"/g, '$1')}, ${JSON.stringify(opts || {})})`);
          await sleep(60);
          const r = info.rect, pad = 12;
          const crop = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(W, r.width + 2 * pad), height: Math.min(H - Math.max(0, r.y - pad), r.height + 2 * pad) };
          const img = await w.webContents.capturePage(crop);
          crops.push({ label: name + '  ' + size, url: img.toDataURL() });
          if (/^(idle-neutral|deploy|limiter-lane-80|tyres-worn-flat-puncture|no-ers-2010)$/.test(name)) {
            save(`full-${W}-${tag}-${name}`, await w.webContents.capturePage());
          }
        }
        // contact sheets: 2 columns, cropped at 1:1 device pixels
        for (let i = 0, s = 0; i < crops.length; i += 8, s++) {
          const dataUrl = await js(`__sheet(${JSON.stringify(crops.slice(i, i + 8))}, 2, 1)`);
          fs.writeFileSync(path.join(OUT, `sheet-${W}-${tag}-${s + 1}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
        }
        console.log('saved ' + crops.length + ' crops for ' + size);
      }

      if (part('checks')) {
        // no layout jump: the speed digits' ink for 9 / 99 / 345 must end at the same right edge, and the rest of the
        // graphic (everything outside the digit field) must be pixel-identical between 0 and 345 km/h
        const r = await js(`(function () {
          var cv = document.getElementById('hud-telemetry'), c = cv.getContext('2d'), tel = F1.telemetry;
          var st = ${JSON.stringify(S({ gear: 3, rpm: 8000 }))};
          function inkRight(v) {
            st.speedKmh = v; __show(st);
            var k = Math.min(cv.width / tel.W, cv.height / tel.H), ox = Math.round((cv.width - tel.W * k) / 2), oy = Math.round(cv.height - tel.H * k);
            var x0 = Math.floor(ox + 180 * k), x1 = Math.ceil(ox + 345 * k), y0 = Math.floor(oy + 80 * k), y1 = Math.ceil(oy + 117 * k);
            var d = c.getImageData(x0, y0, x1 - x0, y1 - y0), right = -1;
            for (var y = 0; y < d.height; y++) for (var x = 0; x < d.width; x++) {
              var i = (y * d.width + x) * 4;
              if (d.data[i] > 220 && d.data[i + 1] > 220 && d.data[i + 2] > 220 && d.data[i + 3] > 200 && x > right) right = x;
            }
            return (right + x0) / k;
          }
          return { r9: inkRight(9), r99: inkRight(99), r345: inkRight(345), r0: inkRight(0), r100: inkRight(100) };
        })()`);
        check(size + ': speed digits right-aligned in fixed cells (ink right edge within 2 design units for 0 / 9 / 99 / 100 / 345)',
          Math.max(r.r0, r.r9, r.r99, r.r100, r.r345) - Math.min(r.r0, r.r9, r.r99, r.r100, r.r345) < 2.5, r);
      }
    }

    if (part('checks')) {
      // robustness: nothing may throw or warn for any junk
      const junk = await js(`(function () {
        var tel = F1.telemetry, bad = [];
        var vals = [undefined, null, 0, -1, 1e9, NaN, Infinity, -Infinity, '', 'x', '#12', true, {}, [], [NaN, 'a'], function () {}];
        var keys = ['speedKmh','gear','rpm','rpmIdle','rpmShift','rpmMax','throttle','brake','battery','deploy','harvest','limiter','inPit',
          'limitKmh','tyres','nextCompound','team','car','colour','colour2'];
        try { tel.draw(); tel.draw(null); tel.draw(5); tel.draw('x'); tel.draw([]); } catch (e) { bad.push('top: ' + e); }
        for (var i = 0; i < keys.length; i++) for (var j = 0; j < vals.length; j++) {
          var t = {}; t[keys[i]] = vals[j];
          try { tel.draw(t); } catch (e) { bad.push(keys[i] + '=' + String(vals[j]) + ': ' + e); }
        }
        var tyreVals = [{ wear: [1, 2, 3] }, { wear: { 0: 0.5 } }, { flat: 'aaaa' }, { puncture: NaN }, { puncture: 2.7 }, { compound: 'soft' },
          { wear: [NaN, Infinity, -1, 5], flat: [NaN, 1, 2, -1], puncture: 0 }];
        for (j = 0; j < tyreVals.length; j++) try { tel.draw({ tyres: tyreVals[j] }); } catch (e) { bad.push('tyres ' + j + ': ' + e); }
        var getterBomb = {}; Object.defineProperty(getterBomb, 'speedKmh', { get: function () { throw new Error('boom'); } });
        try { tel.draw(getterBomb); } catch (e) { bad.push('getter: ' + e); }
        return { bad: bad, errors: window.__errors.slice() };
      })()`);
      check('draw() never throws on junk input', junk.bad.length === 0, junk.bad.slice(0, 5));
      check('junk input: at most one console warning (the throwing getter), no page errors',
        junk.errors.filter(e => !/^warn: F1\.telemetry: Error: boom/.test(e)).length === 0, junk.errors.slice(0, 3));

      // smoothing: a keyboard throttle 0 -> 1 is at least 75 % after 50 ms, and on/off every frame does not flicker
      const sm = await js(`(function () {
        var tel = F1.telemetry, cv = document.getElementById('hud-telemetry'), c = cv.getContext('2d');
        var a = ${JSON.stringify(S({ gear: 3, speedKmh: 100, rpm: 8000, throttle: 0 }))}, b = JSON.parse(JSON.stringify(a)); b.throttle = 1;
        // count lit throttle-arc pixels along the arc's centre line, 92 deg from 22 deg anticlockwise
        function arcFill() {
          var k = Math.min(cv.width / tel.W, cv.height / tel.H), ox = Math.round((cv.width - tel.W * k) / 2), oy = Math.round(cv.height - tel.H * k);
          var n = 0, lit = 0;
          for (var a = 0; a <= 92; a += 1) {
            var ang = (22 - a) * Math.PI / 180, x = Math.round(ox + (260 + Math.cos(ang) * 49.5) * k), y = Math.round(oy + (100 + Math.sin(ang) * 49.5) * k);
            var p = c.getImageData(x, y, 1, 1).data; n++;
            if (p[1] > 180 && p[0] < 120) lit++;
          }
          return lit / n;
        }
        __step(a, b, 50); var at50 = arcFill();
        __step(a, b, 400); var full = arcFill();
        __step(a, a, 400); var none = arcFill();
        // flicker: alternate every frame for 30 frames; the arc must stay near the middle, not jump 0 <-> 1
        var seen = [], i, fakeNow = 0; tel.clock = function () { return fakeNow; }; tel.reset();
        for (i = 0; i < 40; i++) { fakeNow = i * 1000 / 60; tel.draw(i % 2 ? a : b); if (i >= 20) seen.push(arcFill()); }
        return { at50: at50, full: full, none: none, flickerMin: Math.min.apply(null, seen), flickerMax: Math.max.apply(null, seen) };
      })()`);
      check('pedal smoothing: throttle step shows >= 75 % within 50 ms, 100 % when settled, 0 at rest',
        sm.at50 >= 0.72 && sm.full > 0.97 && sm.none < 0.02, sm);
      check('pedal smoothing: on/off every frame stays steady (swing < 45 % of the arc)', sm.flickerMax - sm.flickerMin < 0.45, sm);

      // static layer is rebuilt only when needed: a changing team name reflows, the same state does not
      const reb = await js(`(function () {
        var tel = F1.telemetry, st = ${JSON.stringify(S({}))};
        __show(st); var cv = document.getElementById('hud-telemetry'), c = cv.getContext('2d');
        var a = c.getImageData(0, 0, cv.width, cv.height).data, s1 = 0; for (var i = 0; i < a.length; i += 97) s1 += a[i];
        st.team = 'Williams'; __show(st);
        var b = c.getImageData(0, 0, cv.width, cv.height).data, s2 = 0; for (i = 0; i < b.length; i += 97) s2 += b[i];
        return { changed: s1 !== s2 };
      })()`);
      check('team change is drawn (static layer rebuilt)', reb.changed);

      // per frame: no DOM reads / writes (layout queries, canvas size, element creation) and no JS objects created.
      // States that share the static key (same car, rpm range, battery presence, limit) but differ in everything else.
      // in a freshly loaded page: the junk test above fed draw() dozens of object shapes, which leaves its property loads
      // megamorphic (generic loads copy double fields into new heap numbers); the game only ever passes one shape
      await w.loadURL(pageUrl);
      await sleep(300);
      await js('__init()');
      const same = SCEN.filter(([n, st]) => st.team === 'McLaren' && st.battery !== null && st.rpmIdle === 4000 && st.limitKmh === 80 &&
        st.colour === '#ff8000').map(x => x[1]);
      const pf = await js(`(function () {
        var tel = F1.telemetry, states = ${JSON.stringify(same)}, n = states.length, i;
        tel.clock = function () { return performance.now(); };
        var counts = { layout: 0, size: 0, create: 0, style: 0 };
        var undo = [];
        function wrapMethod(obj, name, key) {
          var orig = obj[name];
          obj[name] = function () { counts[key]++; return orig.apply(this, arguments); };
          undo.push(function () { obj[name] = orig; });
        }
        function wrapProp(obj, name, key) {
          var d = Object.getOwnPropertyDescriptor(obj, name);
          Object.defineProperty(obj, name, { configurable: true,
            get: function () { counts[key]++; return d.get.call(this); },
            set: d.set ? function (v) { counts[key]++; d.set.call(this, v); } : undefined });
          undo.push(function () { Object.defineProperty(obj, name, d); });
        }
        for (i = 0; i < 40000; i++) tel.draw(states[i % n]);         // warm up: optimised code, static layer built
        wrapMethod(Element.prototype, 'getBoundingClientRect', 'layout');
        wrapMethod(Element.prototype, 'getClientRects', 'layout');
        ['clientWidth', 'clientHeight'].forEach(function (k) { wrapProp(Element.prototype, k, 'layout'); });
        ['offsetWidth', 'offsetHeight'].forEach(function (k) { wrapProp(HTMLElement.prototype, k, 'layout'); });
        ['width', 'height'].forEach(function (k) { wrapProp(HTMLCanvasElement.prototype, k, 'size'); });
        wrapProp(HTMLElement.prototype, 'style', 'style');
        wrapMethod(document, 'createElement', 'create');
        wrapMethod(window, 'getComputedStyle', 'layout');
        for (i = 0; i < 2000; i++) tel.draw(states[i % n]);
        undo.forEach(function (f) { f(); });
        // JS heap growth over 10 000 draws. Like main.js, ONE state object of a stable shape whose fields change every
        // frame (here from typed tables of the scripted states), minus the same loop without draw() (gc() first;
        // young-generation growth, no collection expected in between)
        var NUMF = ['speedKmh', 'gear', 'rpm', 'throttle', 'brake', 'battery', 'deploy', 'harvest'], tab = new Float64Array(n * 17);
        var lims = [], pits = [], cmps = [], nxts = [];
        states.forEach(function (s, j) {
          NUMF.forEach(function (f, q) { tab[j * 17 + q] = s[f]; });
          for (var w = 0; w < 4; w++) { tab[j * 17 + 8 + w] = s.tyres.wear[w]; tab[j * 17 + 12 + w] = s.tyres.flat[w]; }
          tab[j * 17 + 16] = s.tyres.puncture;
          lims.push(s.limiter); pits.push(s.inPit); cmps.push(s.tyres.compound); nxts.push(s.nextCompound);
        });
        var st = JSON.parse(JSON.stringify(states[0]));
        st.tyres.wear = [0.5, 0.5, 0.5, 0.5]; st.tyres.flat = [0.5, 0.5, 0.5, 0.5];
        function refresh(j) {
          var o = j * 17, ty = st.tyres;
          st.speedKmh = tab[o]; st.gear = tab[o + 1]; st.rpm = tab[o + 2]; st.throttle = tab[o + 3]; st.brake = tab[o + 4];
          st.battery = tab[o + 5]; st.deploy = tab[o + 6]; st.harvest = tab[o + 7]; st.limiter = lims[j]; st.inPit = pits[j];
          ty.wear[0] = tab[o + 8]; ty.wear[1] = tab[o + 9]; ty.wear[2] = tab[o + 10]; ty.wear[3] = tab[o + 11];
          ty.flat[0] = tab[o + 12]; ty.flat[1] = tab[o + 13]; ty.flat[2] = tab[o + 14]; ty.flat[3] = tab[o + 15];
          ty.puncture = tab[o + 16]; ty.compound = cmps[j]; st.nextCompound = nxts[j];
        }
        function run(withDraw) {
          for (var r = 0; r < 20000; r++) { refresh(r % n); if (withDraw) tel.draw(st); }     // warm up
          gc(); gc();
          var m0 = performance.memory.usedJSHeapSize;
          for (r = 0; r < 10000; r++) { refresh(r % n); if (withDraw) tel.draw(st); }
          return (performance.memory.usedJSHeapSize - m0) / 10000;
        }
        var first = run(true), withDraw = run(true), third = run(true), without = run(false);
        return { counts: counts, states: n, bytesPerDraw: Math.min(withDraw, third) - without, runs: [first, withDraw, third], loopOnly: without };
      })()`);
      check('per frame: no DOM access (layout reads, canvas size, style, createElement) over 2000 draws',
        pf.counts.layout === 0 && pf.counts.size === 0 && pf.counts.create === 0 && pf.counts.style === 0, pf.counts);
      console.log(`JS heap growth per draw() over 10 000 draws (one state object cycling through ${pf.states} scripted states): ${pf.bytesPerDraw.toFixed(1)} bytes (three runs ${pf.runs.map(x => x.toFixed(1)).join(' / ')}; the refresh loop alone: ${pf.loopOnly.toFixed(1)})`);
      // draw() creates no objects, arrays, strings or closures; what remains is V8 boxing a few doubles into 12-byte heap
      // numbers (the performance.now() read, values passed where TurboFan did not inline): measured 11..75 bytes a frame
      // depending on the states and the JIT's inlining. A tripwire, not a proof: probe-alloc.js shows the sites.
      check('per frame: JS heap growth per draw() < 128 bytes (only boxed numbers)', pf.bytesPerDraw < 128, pf.bytesPerDraw.toFixed(1));

      // hidden canvas (the HUD is display: none while the menu is open): draw() does nothing, then works when shown
      const hid = await js(`(async function () {
        var cv = document.getElementById('hud-telemetry'), st = ${JSON.stringify(S({ speedKmh: 123, gear: 4, rpm: 9000, throttle: 1 }))};
        function ink() { var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, n = 0; for (var i = 3; i < d.length; i += 16) if (d[i] > 0) n++; return n; }
        cv.style.display = 'none';
        await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
        var err = '';
        try { for (var i = 0; i < 5; i++) __show(st); } catch (e) { err = String(e); }
        var hiddenSize = [cv.width, cv.height];
        cv.style.display = '';
        await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
        __show(st);
        return { err: err, hiddenSize: hiddenSize, shownSize: [cv.width, cv.height], ink: ink() };
      })()`);
      check('hidden canvas: no error, backing store follows (0 x 0), drawn again once shown', !hid.err && hid.hiddenSize[0] === 0 &&
        hid.shownSize[0] > 0 && hid.ink > 1000, hid);

      // devicePixelRatio change at run time (browser zoom): the backing store follows without a call from outside
      w.webContents.setZoomFactor(1.5);
      await sleep(500);
      const zm = await js(`(function () { var st = ${JSON.stringify(S({}))}; __show(st); var cv = document.getElementById('hud-telemetry'), r = cv.getBoundingClientRect();
        return { dpr: devicePixelRatio, css: [r.width, r.height], backing: [cv.width, cv.height] }; })()`);
      w.webContents.setZoomFactor(1);
      await sleep(400);
      check('zoom 150 %: backing store = CSS box x the new devicePixelRatio', Math.abs(zm.backing[0] - Math.round(zm.css[0] * zm.dpr)) <= 1 &&
        Math.abs(zm.backing[1] - Math.round(zm.css[1] * zm.dpr)) <= 1 && Math.abs(zm.dpr - 1.5 * PASS_DPR) < 0.01, zm);
    }

    if (part('bench')) {
      // FRAMES (10 000) frames back to back, then FRAMES frames driven by requestAnimationFrame (as in the game: each
      // frame is composited, so the canvas is really rasterised between two draws), at both window sizes
      const f4 = x => x.toFixed(4);
      for (const [W, H] of [[1920, 1080], [1280, 720]]) {
        w.setContentSize(W, H);
        await sleep(400);
        await js('__show({})');
        const b = await js(`__bench(${FRAMES}, false)`);
        console.log(`draw() x ${b.n} back to back @${W}x${H} dpr ${PASS_DPR}: avg ${f4(b.avg)} ms, worst batch-of-100 avg ${f4(b.worstBatchAvg)}; single calls (0.1 ms timer): p99 ${f4(b.singleP99)}, p99.9 ${f4(b.singleP999)}, max ${f4(b.singleMax)} ms`);
        w.webContents.setFrameRate(240);
        const r = await js(`__bench(${FRAMES}, true)`);
        w.webContents.setFrameRate(60);
        console.log(`draw() x ${r.n} in requestAnimationFrame @${W}x${H} dpr ${PASS_DPR}: avg ${f4(r.avg)} ms, p50 ${f4(r.p50)}, p99 ${f4(r.p99)}, p99.9 ${f4(r.p999)}, max ${f4(r.max)} ms`);
        check(`${W}x${H} dpr ${PASS_DPR}: draw() average < 0.3 ms back to back and per rAF frame`, b.avg < 0.3 && r.avg < 0.3, [f4(b.avg), f4(r.avg)]);
      }
    }
    check(tag + ': no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  } catch (e) {
    check(tag + ': harness ran to the end', false, e && e.stack ? e.stack : String(e));
  }
}

app.whenReady().then(async () => {
  await pass();
  let childOk = true;
  if (!DPR) {
    // devicePixelRatio 2: a second Electron process (force-device-scale-factor is process-wide)
    console.log('\n--- devicePixelRatio 2 (child process) ---');
    const cp = require('child_process');
    const r = cp.spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { DPR: '2' }), stdio: 'inherit', timeout: 240000 });
    childOk = r.status === 0;
    if (!childOk) console.log('child pass failed: status ' + r.status + (r.error ? ' ' + r.error : ''));
  }
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' / ' + results.length + ' checks passed (dpr ' + PASS_DPR + ')' +
    (failed.length ? '  FAILED: ' + failed.map(r => r.name).join(' | ') : ''));
  app.exit(failed.length || !childOk ? 1 : 0);
});
