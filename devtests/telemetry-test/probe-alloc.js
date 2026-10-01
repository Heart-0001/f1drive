// Which lines of js/telemetry.js allocate on the JS heap while draw() runs every frame? Diagnostic only.
// Runs N draws over the scripted states that share one static layer, with V8's sampling heap profiler on (through
// the DevTools protocol), and prints the allocation sites by bytes.
//   npx electron devtests/telemetry-test/probe-alloc.js        env N=40000
const { app, BrowserWindow } = require('electron');
const path = require('path'), url = require('url');
const N = Number(process.env.N) || 40000;
// SET=harness: the sampling run cycles through the scripted states of shots.js that share one static layer
const SET = process.env.SET || 'probe';
const { SCEN } = require('./states');
const SAME = SCEN.filter(([n, st]) => st.team === 'McLaren' && st.battery !== null && st.rpmIdle === 4000 && st.limitKmh === 80 &&
  st.colour === '#ff8000').map(x => x[1]);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('js-flags', '--expose-gc' + (process.env.NOINLINE ? ' --no-turbo-inlining' : ''));
app.commandLine.appendSwitch('enable-precise-memory-info');
require('../electron-userdata')(app, 'telemetry-alloc');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await w.loadURL(url.pathToFileURL(path.join(__dirname, 'page.html')).href);
    await new Promise(r => setTimeout(r, 300));
    const js = code => w.webContents.executeJavaScript(code);
    await js(`__init(); window.__states = [
      { speedKmh: 200, gear: 5, rpm: 9000, throttle: 1, brake: 0, battery: 0.6, deploy: 1, harvest: 0, limiter: false, inPit: false,
        tyres: { compound: 'M', wear: [0.1, 0.2, 0.3, 0.4], flat: [0, 0.5, 0, 0], puncture: -1 }, team: 'McLaren', car: 'MCL40', colour: '#ff8000' },
      { speedKmh: 80, gear: 3, rpm: 7000, throttle: 0, brake: 1, battery: 0.3, deploy: 0, harvest: 1, limiter: true, inPit: true,
        tyres: { compound: 'M', wear: [0.5, 0.6, 0.7, 0.9], flat: [0.8, 0, 0, 0], puncture: 3 }, team: 'McLaren', car: 'MCL40', colour: '#ff8000' }
    ]; F1.telemetry.clock = function () { return performance.now(); };
    for (var i = 0; i < 5000; i++) F1.telemetry.draw(__states[i & 1]); true`);
    // heap growth per draw, one state at a time (gc first, exact counters)
    const per = await js(`(function () {
      var base = { speedKmh: 200, gear: 5, rpm: 9000, throttle: 1, brake: 0, battery: 0.6, deploy: 0, harvest: 0, limiter: false,
        inPit: false, tyres: { compound: 'M', wear: [0.1, 0.2, 0.3, 0.4], flat: [0, 0, 0, 0], puncture: -1 }, team: 'McLaren',
        car: 'MCL40', colour: '#ff8000' };
      function v(o) { var r = JSON.parse(JSON.stringify(base)); for (var k in o) r[k] = o[k]; return r; }
      var cases = { plain: v({}), stand: v({ speedKmh: 0, gear: 0, rpm: 4000, throttle: 0 }), brake: v({ throttle: 0, brake: 1 }),
        deploy: v({ deploy: 1 }), harvest: v({ harvest: 1, throttle: 0, brake: 1 }), limiter: v({ limiter: true, inPit: true, speedKmh: 80 }),
        shiftPoint: v({ rpm: 11800 }), flatPuncture: v({ tyres: { compound: 'M', wear: [0.5, 0.6, 0.7, 0.9], flat: [0.8, 0, 0, 0], puncture: 3 } }),
        empty: v({ battery: 0 }) };
      var out = {}, all = Object.keys(cases), round, j;
      for (round = 0; round < 2; round++) for (j = 0; j < 20000; j++) F1.telemetry.draw(cases[all[j % all.length]]);   // warm every path
      // two passes over the cases; the first can still include (re)optimisation, the second is the steady state
      for (round = 0; round < 2; round++) for (var name in cases) {
        var st = cases[name], i;
        for (i = 0; i < 3000; i++) F1.telemetry.draw(st);
        gc(); gc();
        var m0 = performance.memory.usedJSHeapSize;
        for (i = 0; i < 10000; i++) F1.telemetry.draw(st);
        out[name] = (round ? out[name] + ' / ' : '') + ((performance.memory.usedJSHeapSize - m0) / 10000).toFixed(1);
      }
      // for the sampling run: one object refreshed every frame from the cases (as main.js would hand it over)
      var list = ${SET === 'harness' ? JSON.stringify(SAME) : 'null'} || Object.keys(cases).map(function (k) { return cases[k]; });
      var one = JSON.parse(JSON.stringify(base));
      var F = ['speedKmh', 'gear', 'rpm', 'throttle', 'brake', 'battery', 'deploy', 'harvest'], tb = new Float64Array(list.length * 17);
      list.forEach(function (c, j) { F.forEach(function (f, q) { tb[j * 17 + q] = c[f]; });
        for (var w = 0; w < 4; w++) { tb[j * 17 + 8 + w] = c.tyres.wear[w]; tb[j * 17 + 12 + w] = c.tyres.flat[w]; } tb[j * 17 + 16] = c.tyres.puncture; });
      one.tyres.wear = [0.5, 0.5, 0.5, 0.5]; one.tyres.flat = [0.5, 0.5, 0.5, 0.5];
      window.__cycle = function (j) {
        j = j % list.length; var o = j * 17, ty = one.tyres;
        one.speedKmh = tb[o]; one.gear = tb[o + 1]; one.rpm = tb[o + 2]; one.throttle = tb[o + 3]; one.brake = tb[o + 4];
        one.battery = tb[o + 5]; one.deploy = tb[o + 6]; one.harvest = tb[o + 7]; one.limiter = list[j].limiter; one.inPit = list[j].inPit;
        for (var w = 0; w < 4; w++) { ty.wear[w] = tb[o + 8 + w]; ty.flat[w] = tb[o + 12 + w]; }
        ty.puncture = tb[o + 16]; ty.compound = list[j].tyres.compound; one.nextCompound = list[j].nextCompound;
        return one;
      };
      for (var r = 0; r < 30000; r++) F1.telemetry.draw(__cycle(r));
      return out;
    })()`);
    console.log('heap growth per draw (bytes) by state, first pass / second pass: ' + JSON.stringify(per));
    const dbg = w.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('HeapProfiler.enable');
    await dbg.sendCommand('HeapProfiler.startSampling', { samplingInterval: 32, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const r = await js(`(function () { var m0 = performance.memory.usedJSHeapSize;
      for (var i = 0; i < ${N}; i++) F1.telemetry.draw(__cycle(i));
      return performance.memory.usedJSHeapSize - m0; })()`);
    const { profile } = await dbg.sendCommand('HeapProfiler.stopSampling');
    const sites = {};
    (function walk(n) {
      const f = n.callFrame, key = (f.url.split('/').pop() || '?') + ':' + (f.lineNumber + 1) + ':' + (f.columnNumber + 1) + ' ' + (f.functionName || '(anon)');
      if (n.selfSize) sites[key] = (sites[key] || 0) + n.selfSize;
      (n.children || []).forEach(walk);
    })(profile.head);
    const list = Object.entries(sites).sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(`[${SET} states] ${N} draws, heap growth (coarse, may include collections) ${r} bytes; sampled allocation sites:`);
    let total = 0; list.forEach(([, v]) => { total += v; });
    for (const [k, v] of list) console.log('  ' + String(v).padStart(9) + ' B  ' + (v / N).toFixed(1).padStart(6) + ' B/draw  ' + k);
    dbg.detach();
  } catch (e) { console.log('probe failed: ' + (e && e.stack || e)); }
  app.exit(0);
});
