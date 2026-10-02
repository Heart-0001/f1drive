const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const host = require('./net/host');   // multiplayer: the relay server runs in this process while a room is open

const INDEX = path.join(__dirname, 'index.html');
const RELOAD_MIN_MS = 10000;          // a page that dies again this soon after being reloaded is not reloaded blindly
// the only pages the game links to (設定 → 資料來源: the data licences); they open in the user's browser
const EXTERNAL_OK = /^https:\/\/(github\.com|creativecommons\.org|www\.openstreetmap\.org)\//;
let mainWin = null;

function openLink(url) {
  if (typeof url === 'string' && EXTERNAL_OK.test(url)) shell.openExternal(url).catch(() => {});
}

function createWindow() {
  const win = mainWin = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'F1Drive',
    // taskbar / title bar (the exe file's own icon is package.json's build.win.icon)
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // keep sending our car position to the other players while the window is in the background
      backgroundThrottling: false
    }
  });
  // backgroundThrottling:false keeps the page 'visible' while minimised / hidden (js/audio.js cannot tell): mute it here
  const syncMute = () => { if (!win.isDestroyed()) win.webContents.setAudioMuted(win.isMinimized() || !win.isVisible()); };
  win.on('minimize', syncMute); win.on('restore', syncMute); win.on('hide', syncMute); win.on('show', syncMute);
  win.setMenuBarVisibility(false);
  win.maximize();
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  // the page never navigates anywhere else and never opens windows: a credits link goes to the browser instead
  win.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event) => { event.preventDefault(); openLink(event.url); });
  watchRenderer(win);
  host.attach(win);
  win.loadFile(INDEX);
}

// A page that dies (GPU driver reset, out of memory, a crash) leaves a blank window, and one that hangs a frozen
// one. The page boots cleanly from cold, and a room it hosted is already closed (host.attach), so: load it again;
// one that dies again within RELOAD_MIN_MS of that asks first instead of looping. A hang asks: wait, or reload.
function watchRenderer(win) {
  const wc = win.webContents;
  let reloadedAt = -Infinity, killedAt = -Infinity, asking = null;
  const reload = () => { if (!win.isDestroyed()) { reloadedAt = Date.now(); win.loadFile(INDEX); } };
  // -> Promise<button index>; the box closes by itself (as its cancelId) when abort() is called
  const ask = (o) => {
    if (asking || win.isDestroyed()) return Promise.resolve(-1);
    const box = asking = new AbortController();
    return dialog.showMessageBox(win, Object.assign({ title: 'F1Drive', noLink: true, defaultId: 0, signal: box.signal }, o))
      .then(r => r.response, () => -1)
      .finally(() => { if (asking === box) asking = null; });
  };
  wc.on('render-process-gone', (event, details) => {
    if (win.isDestroyed() || details.reason === 'clean-exit') return;
    if (asking) asking.abort();                          // a 'not responding' box is moot now
    // ours (see 'unresponsive'), or the first death in a while: load the page again (in a new renderer)
    if (Date.now() - killedAt < 5000 || Date.now() - reloadedAt > RELOAD_MIN_MS) { killedAt = -Infinity; reload(); return; }
    ask({ type: 'error', buttons: ['重新載入', '結束遊戲'], cancelId: 1, message: '遊戲畫面又停止運作了',
      detail: '畫面在重新載入後不久再次停止運作（' + details.reason + '）。可能是顯示卡驅動程式出了問題，或記憶體不足。\n要再重新載入一次（回到主選單）嗎？' })
      .then(r => { if (r === 0) reload(); else if (r === 1 && !win.isDestroyed()) win.close(); });
  });
  win.on('unresponsive', () => {
    ask({ type: 'warning', buttons: ['繼續等待', '重新載入'], cancelId: 0, message: '遊戲畫面沒有回應',
      detail: '可以再等一下，或重新載入遊戲（會回到主選單，你開的房間也會關閉）。' })
      .then(r => {
        if (r !== 1 || win.isDestroyed()) return;
        killedAt = Date.now();                           // a hung renderer cannot reload itself: end it, and
        wc.forcefullyCrashRenderer();                    //   'render-process-gone' loads the page in a new one
      });
  });
  win.on('responsive', () => { if (asking) asking.abort(); });   // it came back: the box answers 'wait' itself
}

// the engine sound (js/audio.js, Web Audio) starts with the game, not only after the first click / key
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// no default menu: its accelerators (Ctrl+R reload, Ctrl+W close) would interrupt a lap
Menu.setApplicationMenu(null);
// One game at a time (per profile): starting it again (a second double click while the portable exe is still
// unpacking, or while the game runs) brings the running window to the front instead of a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  });
  host.register(ipcMain);
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { host.stopServer(); });
}
