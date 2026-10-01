// Electron main-process side of "Create room": runs net/server.js in this process while a room is open.
// Used by electron-main.js; the page reaches it through preload.js (window.f1host).
'use strict';
const crypto = require('crypto');
const relay = require('./server');

let server = null;          // { port, close() }
let serverOwner = 0;        // webContents id of the page that created the room
let busy = false;

async function stopServer() {
  const s = server;
  server = null; serverOwner = 0;
  if (s) { try { await s.close(); } catch (e) {} }
}

/** Register the IPC handlers (call once). */
function register(ipcMain) {
  // opts: { password } ('' / missing = an open room); the server cleans it the way js/net.js does
  ipcMain.handle('f1:startServer', async (event, port, opts) => {
    if (busy) return { ok: false, error: 'busy' };
    busy = true;
    try {
      port = Number(port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'badport' };
      const password = opts && typeof opts.password === 'string' ? opts.password.slice(0, 256) : '';
      await stopServer();
      // only the page that created the room gets this token, and only its holder is the host
      const token = crypto.randomBytes(16).toString('hex');
      server = await relay.createServer({ port: port, hostToken: token, password: password });
      serverOwner = event.sender.id;
      return { ok: true, port: server.port, addresses: relay.lanAddresses(), token: token };
    } catch (err) {
      return { ok: false, error: err && err.code ? String(err.code) : String((err && err.message) || err) };
    } finally {
      busy = false;
    }
  });

  ipcMain.handle('f1:stopServer', async (event) => {
    if (server && serverOwner && event.sender.id !== serverOwner) return { ok: false };
    await stopServer();
    return { ok: true };
  });
}

/** The room dies with the page that hosts it (window closed, renderer crashed or reloaded). */
function attach(win) {
  const id = win.webContents.id;
  const drop = () => { if (serverOwner === id) stopServer(); };
  win.on('closed', drop);
  win.webContents.on('render-process-gone', drop);
  win.webContents.on('did-start-loading', drop);
}

module.exports = { register: register, attach: attach, stopServer: stopServer };
