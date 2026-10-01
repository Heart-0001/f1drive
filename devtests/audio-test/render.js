// Renders the scripted scenes of scenes.js through js/audio.js into WAV files (OfflineAudioContext in an offscreen
// Electron window, the graph stepped at 60 Hz exactly as the game drives it). The page is a file:// page with
// contextIsolation and no node integration, like the game's.
//   npx electron devtests/audio-test/render.js
//   env ONLY=a_launch,c_passby (default: all scenes)   BACKEND=worklet,nodes (default: both)   STEMS=0 (full mixes only)
//       FPS=0 (skip the launch at 30 / 144 updates per second, out/<backend>/fps/)
// Output: devtests/audio-test/out/<backend>/<scene>.wav + .json (timeline: what the car did at every frame) and
//         out/<backend>/stems/<scene>.<stem>.wav + .json (one source group soloed; the analysis measures those).
// Then: node devtests/audio-test/ears.js worklet --png   and   ... ears.js nodes   (the second review's independent analysis;
//       spectrograms to out/<backend>/png/), node devtests/audio-test/analyze.js (the first author's), exit code 1 on a failure.
//       node devtests/audio-test/control-test.js: the control layer alone, in plain node.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
require('../electron-userdata')(app, 'audio-render');
const OUT = path.join(__dirname, 'out');
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const BACKENDS = (process.env.BACKEND || 'worklet,nodes').split(',').filter(Boolean);
const STEMS = process.env.STEMS !== '0';
const M = { ENGINE: 1, AERO: 2, SURFACE: 4, ERS: 8, REMOTE: 16, FX: 32 };
// scene -> stems rendered besides the full mix
const PLAN = {
  a_launch: {}, a_minimal: {},
  b_lap: { engine: M.ENGINE, ers: M.ERS, surface: M.SURFACE, fx: M.FX },
  c_passby: { remote: M.REMOTE },
  d_pack: { remote: M.REMOTE },
  d_teleport: { remote: M.REMOTE },
  e_lights: { fx: M.FX },
  f_fades: {},
  g_top: { engine: M.ENGINE, aero: M.AERO, remote: M.REMOTE },
  g_mid: { engine: M.ENGINE }, g_overrun: { engine: M.ENGINE }, g_idle: { engine: M.ENGINE },
  h_distance: { remote: M.REMOTE },
  i_wind: { aero: M.AERO },
  a_v8launch: {}, g_v8: { engine: M.ENGINE }, g_v8over: { engine: M.ENGINE },
  k_balance: { engine: M.ENGINE, aero: M.AERO, remote: M.REMOTE },
  d_pack16: { remote: M.REMOTE },
  l_net20: { remote: M.REMOTE }, l_netlin: { remote: M.REMOTE }, l_netexact: { remote: M.REMOTE },
  m_pit: { engine: M.ENGINE },
  n_oneshots: { fx: M.FX, surface: M.SURFACE }
};
const FULL_MIX = { g_mid: false, g_overrun: false, g_idle: false, h_distance: false, i_wind: false, g_v8: false, g_v8over: false, l_net20: false, l_netlin: false, l_netexact: false };      // stems only
// the launch again with the game running at other frame rates (update() at 30 and 144 Hz)
const FPS = process.env.FPS === '0' ? [] : [30, 144];

let failed = 0;
ipcMain.handle('at-save', (e, name, data) => {
  const file = path.resolve(OUT, name);
  if (file.indexOf(OUT + path.sep) !== 0) throw new Error('bad file name ' + name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data));
  return true;
});
ipcMain.on('at-log', (e, msg) => console.log('[page]', msg));

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = new BrowserWindow({
    width: 640, height: 360, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }
  });
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    failed++;
    console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  await w.loadFile(path.join(__dirname, 'page.html'));
  const js = code => w.webContents.executeJavaScript(code);
  try {
    const mk = await js('AT.compMakeup()');
    console.log('compressor make-up gain for the master settings: x' + mk.makeup.toFixed(4) + ' (' + (20 * Math.log10(mk.makeup)).toFixed(2) + ' dB); module trim ' + mk.trimInModule +
      ' -> net ' + (20 * Math.log10(mk.makeup * mk.trimInModule)).toFixed(2) + ' dB below the threshold');
    const scenes = await js('AT.list()');
    const t0 = Date.now();
    let total = 0;
    for (const backend of BACKENDS) {
      for (const sc of scenes) {
        if (ONLY.length && ONLY.indexOf(sc.name) < 0) continue;
        const jobs = [];
        if (FULL_MIX[sc.name] !== false) jobs.push({ scene: sc.name, backend, mask: 63, file: backend + '/' + sc.name });
        if (STEMS) for (const stem of Object.keys(PLAN[sc.name] || {})) jobs.push({ scene: sc.name, backend, mask: PLAN[sc.name][stem], file: backend + '/stems/' + sc.name + '.' + stem });
        if (sc.name === 'a_launch') for (const fps of FPS) jobs.push({ scene: sc.name, backend, mask: 63, fps, file: backend + '/fps/' + sc.name + '.' + fps + 'fps' });
        for (const job of jobs) {
          const r = await js('AT.render(' + JSON.stringify(job) + ')');
          total += r.seconds;
          const bad = r.errors || r.nan || r.backend !== backend;
          if (bad) failed++;
          console.log((bad ? 'FAIL ' : 'ok   ') + (job.file + '.wav').padEnd(44) + r.seconds.toFixed(1).padStart(5) + ' s  rendered in ' + String(r.renderMs).padStart(5) + ' ms  peak ' +
            (20 * Math.log10(r.floatPeak || 1e-9)).toFixed(2).padStart(7) + ' dBFS' + (r.maxVoices ? '  voices<=' + r.maxVoices : '') + (r.thumps ? '  thumps ' + r.thumps : '') +
            (r.errors ? '  update() errors: ' + r.errors + ' ' + r.lastError : '') + (r.nan ? '  NaN samples: ' + r.nan : ''));
        }
      }
    }
    console.log('\n' + total.toFixed(0) + ' s of audio rendered in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s -> ' + OUT + (failed ? '   FAILED: ' + failed : ''));
  } catch (e) {
    failed++;
    console.log('FAIL harness: ' + (e && e.stack ? e.stack : e));
  }
  app.exit(failed ? 1 : 0);
});
