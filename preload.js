// Preload: the only bridge between the page and the main process (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('f1host', {
  /** startServer(port, opts?) -> Promise<{ ok, port, addresses: [LAN IPv4], token, error }>
   *  opts: { password }: a room password ('' / missing = an open room) */
  startServer: function (port, opts) {
    const password = opts && typeof opts.password === 'string' ? opts.password.slice(0, 256) : '';
    return ipcRenderer.invoke('f1:startServer', Number(port), { password: password });
  },
  /** stopServer() -> Promise<{ ok }> */
  stopServer: function () { return ipcRenderer.invoke('f1:stopServer'); }
});
