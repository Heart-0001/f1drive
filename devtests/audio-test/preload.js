// devtests/audio-test: lets the harness page hand files and log lines to the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__h', {
  save: (name, data) => ipcRenderer.invoke('at-save', name, data),
  log: (...a) => ipcRenderer.send('at-log', a.map(String).join(' ')),
  // a clock the page can time single update() calls with (performance.now() is coarsened to 100 us there): microseconds
  // (needs an unsandboxed preload, as live.js asks for; elsewhere it is null)
  hr: typeof process.hrtime === 'function' ? () => { const t = process.hrtime(); return t[0] * 1e6 + t[1] / 1e3; } : null
});
