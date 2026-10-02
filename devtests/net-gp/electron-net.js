// npx electron devtests/net-gp/electron-net.js
// The real js/net.js in two real Chromium pages against the real net/server.js (default clock), a whole
// Grand Prix on a 200 m "track" in real time: the room lobby of protocol 2 (settings, ready, start, the loading
// barrier, back to the lobby), clock sync, snapshots, lights timing, rejected laps, teardown.
// The pages drive along x at 90 m/s meanwhile: the server counts only laps (and progress) the car states cover.
// Port: env PORT (default 24770, inside the range reserved for the net owner).
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'net-gp');           // own throw-away userData dir, removed on exit
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
const PORT = Number(process.env.PORT || 24770);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
function makeWin(tag) {
  const w = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'netgp-' + tag, backgroundThrottling: false } });
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2) console.log('[' + tag + ' console]', msg); });
  w.js = code => w.webContents.executeJavaScript(code);
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js(code)) return true; await sleep(25); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  return w;
}

app.whenReady().then(async () => {
  let srv = null;
  try {
    srv = await createServer({ port: PORT, host: '127.0.0.1', random: () => 0 });
    const A = makeWin('A'), B = makeWin('B');
    await A.loadFile(path.join(__dirname, 'page.html')); await B.loadFile(path.join(__dirname, 'page.html'));
    check('page loaded, F1.net + F1.createSession present', await A.js(`!!(window.F1 && F1.net && F1.createSession && F1.Session.TIME_TOLERANCE_S === 1)`));
    const addr = JSON.stringify('127.0.0.1:' + PORT);
    const ra = await A.js(`F1.net.join(${addr})`), rb = await B.js(`F1.net.join(${addr})`);
    check('both joined', ra.ok && rb.ok && await A.js(`F1.net.isHost`) && !(await B.js(`F1.net.isHost`)), [ra, rb]);
    await sleep(500);
    // clock: the page's serverNow() against the server's clock, bracketed by two reads in this process
    for (const w of [A, B]) {
      const t0 = srv.info().now, v = await w.js(`F1.net.serverNow()`), t1 = srv.info().now;
      check('serverNow within the bracket (' + (t1 - t0) + ' ms wide) +/- 15 ms', v > t0 - 15 && v < t1 + 15, { before: t0 - v, after: t1 - v });
    }
    // protocol 2: the room's lobby. Nobody is on a track; the host sets the room up, the guest says ready, the host starts,
    // both build the "track" and report it; the Grand Prix starts at the barrier
    check('both in the lobby, no track loading', (await A.js(`F1.net.room.st === 'lobby' && F1.net.room.rs === 0`)) &&
      (await B.js(`F1.net.room.st === 'lobby' && !__ev.some(function (e) { return e[0] === 'load' || e[0] === 'track'; })`)));
    check('B refused locally (not host): gp start / setRoom / startRoom', (await B.js(`F1.net.gp('start', {q: 1, r: 1, len: 200})`)) === false &&
      (await B.js(`F1.net.setRoom({ track: 'monza' })`)) === false && (await B.js(`F1.net.startRoom({ len: 200, force: true })`)) === false);
    check('the host sets track, mode, laps', (await A.js(`F1.net.setRoom({ track: 'monza', mode: 'gp', q: 1, r: 1 })`)) === true);
    check('the settings reach B (room.set), nothing loads', await B.until(`F1.net.trackId === 'monza' && F1.net.room.set.mode === 'gp' && F1.net.room.set.q === 1`) &&
      (await B.js(`F1.net.room.st === 'lobby' && !__ev.some(function (e) { return e[0] === 'load'; })`)));
    check('start without B ready: nostart not-ready', (await A.js(`F1.net.startRoom({ len: 200 })`)) === true &&
      await A.until(`__ev.some(function (e) { return e[0] === 'nostart' && e[1] === 'not-ready'; })`) && (await B.js(`F1.net.room.st`)) === 'lobby');
    check('B ready', (await B.js(`F1.net.setReady(true)`)) === true && await A.until(`F1.net.room.ready.indexOf(${await B.js(`F1.net.id`)}) >= 0`));
    await sleep(1050);                                            // (START_MIN_MS is not an issue: the refused start did not count)
    check('host starts', (await A.js(`F1.net.startRoom({ len: 200 })`)) === true);
    check('both load rs 1', await A.until(`F1.net.room.st === 'loading' && __ev.some(function (e) { return e[0] === 'load' && e[1] === 'monza 1'; })`) &&
      await B.until(`F1.net.room.st === 'loading' && __ev.some(function (e) { return e[0] === 'load' && e[1] === 'monza 1'; })`));
    await A.js(`F1.net.sendLoaded(1, true, { len: 200 })`);
    await sleep(300);
    check('the barrier holds while B loads: no qualifying yet', (await B.js(`F1.net.room.st === 'loading' && F1.net.session.phase === 'free'`)) &&
      JSON.stringify(await B.js(`F1.net.roster.map(function (p) { return p.load; })`)) === '["done","wait"]', await B.js(`F1.net.roster.map(function (p) { return p.load; })`));
    await B.js(`F1.net.sendLoaded(1, true, { len: 200 })`);
    check('quali on both, after go', await A.until(`F1.net.session && F1.net.session.phase === 'quali'`) && await B.until(`F1.net.session && F1.net.session.phase === 'quali'`) &&
      (await B.js(`__ev.some(function (e) { return e[0] === 'go'; }) && F1.net.room.st === 'session'`)));
    const t0 = Date.now();
    // both cars drive along x at 90 m/s from now on, 20 states a second as the game sends them: the server counts
    // only laps (and live progress) that the car states cover
    for (const w of [A, B]) {
      await w.js(`window.__x = 0; window.__drive = setInterval(function () { __x += 4.5; F1.net.sendState({ x: __x, z: 0, heading: Math.PI / 2, speed: 90 }, true); }, 50); true`);
    }
    await B.js(`F1.net.sendGpLap(F1.net.session.sid, 2.5)`);
    check('early lap rejected with the reason', await B.until(`__ev.some(function (e) { return e[0] === 'lapRejected' && e[1] === 'too-soon'; })`), await B.js(`__ev.filter(function (e) { return e[0] === 'lapRejected'; })`));
    await sleep(2350 - (Date.now() - t0));
    await B.js(`F1.net.sendGpLap(F1.net.session.sid, 2.2)`); await A.js(`F1.net.sendGpLap(F1.net.session.sid, 2.25)`);
    check('grid on both', await A.until(`F1.net.session.phase === 'grid'`) && await B.until(`F1.net.session.phase === 'grid'`));
    const sa = await A.js(`F1.net.session`), sb = await B.js(`F1.net.session`);
    check('identical snapshots, B on pole', JSON.stringify(sa) === JSON.stringify(sb) && sa.grid[0] === await B.js(`F1.net.id`), sa.grid);
    check('lights: goAt = lightsAt + 5.5 s, first light ~4 s away', sa.goAt - sa.lightsAt === 5500 && sa.lightsAt - srv.info().now > 3000 && sa.lightsAt - srv.info().now <= 4000, sa.lightsAt - srv.info().now);
    // each page notes, on its OWN synchronised clock, when the race snapshot arrived
    check('race on both', await A.until(`F1.net.session.phase === 'race'`, 12000) && await B.until(`F1.net.session.phase === 'race'`, 3000));
    for (const w of [A, B]) {
      const late = await w.js(`(function () { var e = __ev.filter(function (x) { return x[0] === 'gp' && x[1].phase === 'race'; })[0]; return e[1].at - F1.net.session.goAt; })()`);
      check('race snapshot arrives 0..350 ms after goAt on the page clock', late >= -15 && late < 350, late);
    }
    const tRace = Date.now();
    // (the progress rides on the driving states; each is believed as far as the path since lights out backs it)
    await A.js(`F1.net.setProgress(0.7)`);
    await B.js(`F1.net.setProgress(0.2)`);
    check('live order follows progress', await B.until(`F1.net.session.order[0] === ${await A.js(`F1.net.id`)}`, 3000), await B.js(`F1.net.session.order`));
    await sleep(2350 - (Date.now() - tRace));
    // the laps carry the moment of the crossing on the synchronised clock
    await A.js(`F1.net.sendGpLap(F1.net.session.sid, 2.3, F1.net.serverNow())`); await B.js(`F1.net.sendGpLap(F1.net.session.sid, 2.31, F1.net.serverNow())`);
    check('results on both', await A.until(`F1.net.session.phase === 'results'`) && await B.until(`F1.net.session.phase === 'results'`));
    const res = await B.js(`F1.net.session`);
    check('classification', res.order[0] === await A.js(`F1.net.id`) && res.players.every(p => p.fin && p.rLaps === 1), res.players.map(p => [p.id, p.rTime, p.gap]));
    for (const w of [A, B]) await w.js(`clearInterval(window.__drive); true`);
    // the host takes the room back to the lobby: both hear 'lobby' (room first, then gp free); states stop
    await sleep(1000);
    check('back to the lobby', (await A.js(`F1.net.backToLobby()`)) === true && await A.until(`F1.net.room.st === 'lobby'`) &&
      await B.until(`F1.net.room.st === 'lobby' && F1.net.session.phase === 'free' && __ev.some(function (e) { return e[0] === 'lobby'; })`));
    // the server goes away
    await srv.close(); srv = null;
    check('both told, nothing left behind', await A.until(`!F1.net.connected`) && await B.until(`!F1.net.connected`) &&
      await B.js(`F1.net.session === null && F1.net.id === 0 && Math.abs(F1.net.serverNow() - Date.now()) < 50`), await B.js(`__ev[__ev.length - 1]`));
    check('no page errors', (await A.js(`__err.length`)) + (await B.js(`__err.length`)) === 0, await A.js(`__err`));
  } catch (e) {
    console.log('ERR', e && e.stack);
    results.push({ name: 'exception', ok: false });
  }
  if (srv) await srv.close();
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed' + (bad.length ? ' — FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  app.exit(bad.length ? 1 : 0);
});
