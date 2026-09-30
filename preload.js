// Preload: the only bridge between the page and the main process (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('f1host', {
  /** startServer(port) -> Promise<{ ok, port, addresses: [LAN IPv4], token, error }> */
  startServer: function (port) { return ipcRenderer.invoke('f1:startServer', Number(port)); },
  /** stopServer() -> Promise<{ ok }> */
  stopServer: function () { return ipcRenderer.invoke('f1:stopServer'); }
});
