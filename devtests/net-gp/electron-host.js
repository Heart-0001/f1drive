// npx electron devtests/net-gp/electron-host.js
// "Create room" with a password through the real preload.js + net/host.js (the IPC path the game uses): the host
// page calls F1.net.create(port, {password}), its own join needs no typing (the token), a guest page (no preload)
// is refused without / with a wrong password and gets in with the right one. Closing the host's room ends it.
// Port: env PORT (default 24790, inside the range reserved for the net owner). Exit code 0 = every check passed.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'net-host');           // own throw-away userData dir, removed on exit
app.disableHardwareAcceleration();
const host = require(path.join(ROOT, 'net', 'host.js'));
const PORT = Number(process.env.PORT || 24790);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
function makeWin(tag, preload) {
  const w = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: {
    offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'nethost-' + tag, backgroundThrottling: false,
    preload: preload ? path.join(ROOT, 'preload.js') : undefined } });
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2) console.log('[' + tag + ' console]', msg); });
  w.js = code => w.webContents.executeJavaScript(code);
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (await w.js(code)) return true; await sleep(25); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  return w;
}

host.register(ipcMain);
app.whenReady().then(async () => {
  try {
    const page = path.join(__dirname, 'page-v6.html');
    const H = makeWin('H', true), G = makeWin('G', false);
    host.attach(H);
    await H.loadFile(page); await G.loadFile(page);
    check('the host page can create rooms (preload), the guest page cannot', await H.js(`F1.net.canCreate`) && !(await G.js(`F1.net.canCreate`)));
    const r = await H.js(`F1.net.create(${PORT}, { password: '  賽車 2024 ' })`);
    check('create with a password', r.ok && await H.js(`F1.net.connected && F1.net.isHost && F1.net.hostInfo.hasPassword === true`),
      [r, await H.js(`F1.net.hostInfo`)]);
    const addr = JSON.stringify('127.0.0.1:' + PORT);
    const g1 = await G.js(`F1.net.join(${addr})`);
    check('guest without the password: refused', !g1.ok && g1.error === '這個房間需要密碼，請輸入房間密碼', g1);
    const g2 = await G.js(`F1.net.join(${addr}, { password: '賽車2024' })`);
    check('guest with a wrong one: refused', !g2.ok && g2.error === '房間密碼錯誤', g2);
    const g3 = await G.js(`F1.net.join(${addr}, { password: '賽車 2024' })`);
    check('guest with the right one: in, the host sees him', g3.ok && await H.until(`F1.net.roster.length === 2`), g3);
    // protocol 2 through the in-game server: a lobby, not a dedicated server; the host sets up, the guest is ready, both load
    check('both in the lobby of an in-game room (ded false), the guest knows the address', (await H.js(`F1.net.room.st === 'lobby' && F1.net.ded === false && F1.net.address === null`)) &&
      (await G.js(`F1.net.room.st === 'lobby' && F1.net.ded === false && F1.net.address === ${JSON.stringify('127.0.0.1:' + PORT)}`)));
    check('the host sets the track, the guest says ready', (await H.js(`F1.net.setRoom({ track: 'monza' })`)) && await G.until(`F1.net.trackId === 'monza'`) &&
      (await G.js(`F1.net.setReady(true)`)) && await H.until(`F1.net.room.ready.length === 1`));
    check('start: both load, then the session', (await H.js(`F1.net.startRoom({ len: 5793 })`)) && await G.until(`F1.net.room.st === 'loading'`) &&
      (await H.js(`F1.net.sendLoaded(F1.net.room.rs, true, { len: 5793 })`)) && (await G.js(`F1.net.sendLoaded(F1.net.room.rs, true, { len: 5793 })`)) &&
      await H.until(`F1.net.room.st === 'session'`) && await G.until(`F1.net.room.st === 'session' && F1.net.loadedRs === F1.net.room.rs`));
    await sleep(1000);
    check('back to the lobby (the host)', (await H.js(`F1.net.backToLobby()`)) && await G.until(`F1.net.room.st === 'lobby'`));
    await H.js(`F1.net.leave()`);
    check('the host leaves: the room is closed for the guest', await G.until(`!F1.net.connected && F1.net.room === null`, 3000));
    // an open room is still what create() without options gives
    const r2 = await H.js(`F1.net.create(${PORT})`);
    const g4 = await G.js(`F1.net.join(${addr}, { password: 'whatever' })`);
    check('create without a password: an open room', r2.ok && g4.ok && (await H.js(`F1.net.hostInfo.hasPassword`)) === false, [r2, g4]);
    await G.js(`F1.net.leave()`); await H.js(`F1.net.leave()`);
    const errs = (await H.js(`__err`)).concat(await G.js(`__err`));
    check('no page errors', errs.length === 0, errs);
  } catch (e) {
    console.log('ERR', e && e.stack);
    results.push({ name: 'exception', ok: false });
  }
  await host.stopServer();
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed' + (bad.length ? ' — FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  app.exit(bad.length ? 1 : 0);
});
