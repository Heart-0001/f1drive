// Where does update() allocate? V8's sampling heap profiler over a loop of update() calls, through the DevTools
// protocol. Prints every allocation site (function, line) seen with its share. A diagnostic, not a pass / fail test.
//   npx electron devtests/audio-test/alloc-profile.js          BACKEND=nodes for the fallback graph
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('../electron-userdata')(app, 'audio-alloc');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('enable-precise-memory-info');
const NODES = process.env.BACKEND === 'nodes';
const CALLS = 60000;
ipcMain.handle('at-save', () => true);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { offscreen: true, contextIsolation: true, preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false } });
  await w.loadFile(path.join(__dirname, 'page.html'));
  const dbg = w.webContents.debugger;
  dbg.attach('1.3');
  await w.webContents.executeJavaScript(`(async function () {
    var a = window.__a = F1.createAudio({ worklet: ${!NODES}, autoSuspend: false });
    await a.init({ force: true });
    a.setActive(true); a.setVolume(0);
    var st = { x: 0, y: 0, z: 0, heading: 0.3, speed: 0, steer: 0.1, onGrass: false, hit: 0, throttle: 0, brake: 0, gear: 0, rpm: 4000, shiftT: 9, deploy: 0, harvest: 0, slip: 0 };
    var L = { x: 0, y: 0.7, z: 0, heading: 0.3 }, others = [], i;
    for (i = 0; i < 12; i++) others.push({ id: 'c' + i, x: (i % 3 - 1) * 3.5, y: 0, z: (i - 6) * 25, heading: 0.1, speed: 50 });
    window.__run = function (n) {
      for (var j = 0; j < n; j++) {
        var ph = j * 0.004;
        st.speed = 45 + 40 * Math.sin(ph); st.rpm = 8000 + 3500 * Math.sin(ph * 7); st.gear = 1 + ((j / 300) | 0) % 8; st.throttle = 0.5 + 0.5 * Math.sin(ph * 3); st.brake = 0;
        st.shiftT = (j % 300) / 60; st.deploy = j % 900 < 300 ? 1 : 0; st.harvest = 0.2; st.slip = 0.3 + 0.3 * Math.sin(ph * 5); st.z += st.speed / 60; st.x = Math.sin(ph); L.x = st.x; L.z = st.z;
        for (var q = 0; q < others.length; q++) { var o = others[q]; o.speed = 45 + 30 * Math.sin(ph + q); o.z += o.speed / 60; o.x = (q % 3 - 1) * 3.5 + 0.5 * Math.sin(ph * 2 + q); o.heading = 0.1 * Math.sin(ph + q); }
        if (j % 3000 === 0) for (q = 0; q < others.length; q++) others[q].z = st.z + (q - 6) * 25;
        a.update(1 / 60, st, L, others);
      }
    };
    if (${JSON.stringify(process.env.SCENE || '')} === 'fixed') window.__run = function (n) { for (var j = 0; j < n; j++) a.update(1 / 60, st, L, others); };
    window.__run(30000);
    window.__heap = function (n) { var h0 = performance.memory.usedJSHeapSize; window.__run(n); return (performance.memory.usedJSHeapSize - h0) / n; };
    return a.debug.backend;
  })()`).then(b => console.log('back end: ' + b));
  await dbg.sendCommand('HeapProfiler.enable');
  await dbg.sendCommand('HeapProfiler.collectGarbage');
  await dbg.sendCommand('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await w.webContents.executeJavaScript(`window.__run(${CALLS}); window.__a.debug.errors`).then(e => console.log('errors caught inside update(): ' + e));
  const { profile } = await dbg.sendCommand('HeapProfiler.stopSampling');
  const perCall = [];
  for (let i = 0; i < 9; i++) perCall.push(await w.webContents.executeJavaScript('window.__heap(500)'));
  console.log('performance.memory.usedJSHeapSize growth per call, 9 batches of 500: ' + perCall.map(x => x.toFixed(1)).join(' '));
  const sites = {};
  let total = 0;
  (function walk(node, stack) {
    const cf = node.callFrame, name = (cf.functionName || '(anonymous)') + ' ' + (cf.url || '').split('/').pop() + ':' + (cf.lineNumber + 1);
    if (node.selfSize > 0) { sites[name + '   <- ' + stack.slice(-2).join(' <- ')] = (sites[name + '   <- ' + stack.slice(-2).join(' <- ')] || 0) + node.selfSize; total += node.selfSize; }
    (node.children || []).forEach(c => walk(c, stack.concat(name)));
  })(profile.head, []);
  console.log('sampled allocation over ' + CALLS + ' update() calls: ' + total + ' bytes = ' + (total / CALLS).toFixed(2) + ' bytes per call');
  Object.keys(sites).sort((a, b) => sites[b] - sites[a]).slice(0, 25).forEach(k => console.log(String(sites[k]).padStart(9) + ' bytes  ' + (sites[k] / CALLS).toFixed(2).padStart(7) + ' /call  ' + k));
  app.exit(0);
});
