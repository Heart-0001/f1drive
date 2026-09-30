const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const host = require('./net/host');   // multiplayer: the relay server runs in this process while a room is open

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'F1Drive',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // keep sending our car position to the other players while the window is in the background
      backgroundThrottling: false
    }
  });
  win.setMenuBarVisibility(false);
  win.maximize();
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  // the page never navigates anywhere else and never opens windows
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  host.attach(win);
  win.loadFile(path.join(__dirname, 'index.html'));
}

// no default menu: its accelerators (Ctrl+R reload, Ctrl+W close) would interrupt a lap
Menu.setApplicationMenu(null);
host.register(ipcMain);
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { host.stopServer(); });
