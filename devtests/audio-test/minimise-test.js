// The game's window minimised / hidden. A REAL window with the game's webPreferences (backgroundThrottling: false, so
// that the multiplayer relay keeps getting our position) is shown, minimised, restored, hidden and shown again; the
// page runs requestAnimationFrame -> F1.audio.update as main.js does.
//   npx electron devtests/audio-test/minimise-test.js          (exit code 1 when a check fails)
// Electron never tells such a page that it is minimised or hidden (document.hidden stays false, no visibilitychange,
// requestAnimationFrame goes on), so js/audio.js cannot fade itself out there: the main process has to. Checked:
//   1. without wiring in the main process the page is not told and the engine sounds on (why the host must act);
//   2. muteWhenHidden(win) below, the wiring meant for electron-main.js, mutes the window while it is minimised /
//      hidden and only then (webContents.setAudioMuted: Chromium's tab mute, after the page's graph);
//   3. the page-side alternative, the host calling F1.audio.setActive(false / true) on the same events: the graph
//      falls silent, the AudioContext goes to sleep and Chromium stops reporting the window audible; back on restore.
// Audio output: --disable-audio-output (a fake device: nothing reaches the speakers, and Chromium still tracks whether
// the window is audible). Small windows at the top left of the screen, never focused.
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../electron-userdata')(app, 'audio-minimise');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-audio-output');
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '   ' + JSON.stringify(detail) : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const warnings = [];

// ---- the wiring asked of electron-main.js (in createWindow, after new BrowserWindow); keep the two in step ----
function muteWhenHidden(win) {
  const sync = () => { if (!win.isDestroyed()) win.webContents.setAudioMuted(win.isMinimized() || !win.isVisible()); };
  win.on('minimize', sync); win.on('restore', sync); win.on('hide', sync); win.on('show', sync);
}

async function open(wire) {
  const w = new BrowserWindow({ width: 400, height: 240, x: 20, y: 20, show: false, focusable: false, title: 'F1Drive audio minimise test',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });   // (electron-main.js's)
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Security Warning') < 0) { warnings.push(msg); console.log('[console]', msg); } });
  if (wire) wire(w);
  await w.loadFile(path.join(__dirname, 'page.html'));
  w.showInactive();
  await sleep(300);
  w.js = c => w.webContents.executeJavaScript(c, false);
  w.sample = async () => Object.assign(await w.js('AT.winSample()'), { muted: w.webContents.isAudioMuted(), audible: w.webContents.isCurrentlyAudible() });
  w.start = await w.js('AT.winStart()');
  return w;
}
// visible -> minimised -> restored -> hidden -> shown, a sample after each (Chromium holds 'audible' for 2 s)
async function cycle(w, hold) {
  const s = {};
  await sleep(hold); s.visible = await w.sample();
  w.minimize(); await sleep(hold); s.minimised = await w.sample();
  w.restore(); w.showInactive(); await sleep(hold); s.restored = await w.sample();
  w.hide(); await sleep(hold); s.hidden = await w.sample();
  w.showInactive(); await sleep(hold); s.shown = await w.sample();
  await w.js('AT.winStop()');
  for (const k in s) console.log('  ' + k + ': ' + JSON.stringify(s[k]));
  return s;
}
const loud = x => x.rmsDb > -30, quiet = x => x.rmsDb < -100;
const told = s => [s.minimised, s.hidden].some(x => x.hidden || x.vis.length);

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    // 1. nothing in the main process
    let w = await open(null);
    console.log('1. no wiring: ' + JSON.stringify(w.start));
    let s = await cycle(w, 1200);
    check('1. no wiring: the page is never told it is minimised / hidden (document.hidden ' + s.minimised.hidden + ' / ' + s.hidden.hidden + ', visibilitychange ' + s.hidden.vis.length + ' times) and requestAnimationFrame runs on (' +
      s.visible.frames + ' -> ' + s.minimised.frames + ' -> ' + s.hidden.frames + ' frames)', !told(s) && s.minimised.frames > s.visible.frames + 30 && s.hidden.frames > s.restored.frames + 30);
    check('1. no wiring: so the engine sounds on while minimised (' + s.minimised.rmsDb + ' dBFS) and hidden (' + s.hidden.rmsDb + ' dBFS), window never muted', s.visible.state === 'running' && loud(s.minimised) && loud(s.hidden) && !s.minimised.muted && !s.hidden.muted);
    w.destroy();

    // 2. electron-main.js's wiring: webContents.setAudioMuted
    w = await open(muteWhenHidden);
    s = await cycle(w, 800);
    check('2. muteWhenHidden: the window is muted while minimised (' + s.minimised.muted + ') and hidden (' + s.hidden.muted + '), and not while visible (' + s.visible.muted + '), restored (' + s.restored.muted + '), shown again (' + s.shown.muted + ')',
      s.minimised.muted && s.hidden.muted && !s.visible.muted && !s.restored.muted && !s.shown.muted);
    check('2. muteWhenHidden: the page itself runs on untouched (' + s.minimised.frames + ' frames, ' + s.minimised.rmsDb + ' dBFS before the tab mute, nothing caught)', loud(s.minimised) && loud(s.restored) && s.minimised.errors === 0);
    w.destroy();

    // 3. the page-side alternative: the host turns the same events into F1.audio.setActive(false / true)
    w = await open(win => {
      const tell = () => { if (!win.isDestroyed() && win.js) win.js('F1.audio.setActive(' + !(win.isMinimized() || !win.isVisible()) + ')'); };
      win.on('minimize', tell); win.on('restore', tell); win.on('hide', tell); win.on('show', tell);
    });
    s = await cycle(w, 3000);
    check('3. setActive(false) on minimise / hide: silent (' + s.minimised.rmsDb + ' / ' + s.hidden.rmsDb + ' dBFS), context asleep (' + s.minimised.state + ' / ' + s.hidden.state + '), window not audible (' + s.minimised.audible + ' / ' + s.hidden.audible +
      ') although update() goes on (' + s.visible.frames + ' -> ' + s.hidden.frames + ' frames)', quiet(s.minimised) && quiet(s.hidden) && s.minimised.state === 'suspended' && s.hidden.state === 'suspended' && !s.minimised.audible && !s.hidden.audible && s.hidden.frames > s.restored.frames + 30);
    check('3. setActive(true) on restore / show: back (' + s.restored.rmsDb + ' / ' + s.shown.rmsDb + ' dBFS, ' + s.restored.state + ', audible ' + s.restored.audible + ' / ' + s.shown.audible + ')',
      loud(s.visible) && loud(s.restored) && loud(s.shown) && s.restored.state === 'running' && s.visible.audible && s.restored.audible && s.shown.audible && s.shown.errors === 0);
    check('nothing on the console in any window', warnings.length === 0, warnings.slice(0, 3));
    w.destroy();
  } catch (e) {
    check('harness ran to the end', false, e && e.stack ? e.stack : String(e));
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '\nFAILED:\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  app.exit(bad.length ? 1 : 0);
});
