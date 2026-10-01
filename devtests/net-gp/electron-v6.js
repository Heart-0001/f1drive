// npx electron devtests/net-gp/electron-v6.js
// v6 network features in real Chromium pages: the real net/session.js + js/net.js + js/gp.js as classic scripts
// (page-v6.html) against the real net/server.js. Cars in the profile / roster, the room year and its event order,
// the Grand Prix year (the room's) and tyre wear through F1.gp, parc fermé and the car sent again afterwards, an
// offline Grand Prix with year / wear, joining a room with a password. No real-time race: a few seconds in all.
// Port: env PORT (default 24780, and PORT + 1; inside the range reserved for the net owner). Exit code 0 = every check passed.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'net-v6');            // own throw-away userData dir, removed on exit
app.disableHardwareAcceleration();
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
const PORT = Number(process.env.PORT || 24780);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
function makeWin(tag) {
  const w = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'netv6-' + tag, backgroundThrottling: false } });
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

app.whenReady().then(async () => {
  let srv = null, pwSrv = null;
  try {
    srv = await createServer({ port: PORT, host: '127.0.0.1', random: () => 0 });
    const page = path.join(__dirname, 'page-v6.html');
    const A = makeWin('A'), B = makeWin('B'), C = makeWin('C'), O = makeWin('O');
    for (const w of [A, B, C, O]) await w.loadFile(page);
    check('classic scripts: F1.net.setYear, F1.gp.view().year / wear, no module / require',
      await A.js(`typeof F1.net.setYear === 'function' && typeof module === 'undefined' && typeof require === 'undefined' && 'year' in F1.gp.view() && F1.gp.view().wear === 1`));
    const addr = JSON.stringify('127.0.0.1:' + PORT);
    await A.js(`F1.net.setProfile({ name: '安娜', colour: '#e10600', car: '2024-ferrari' })`);
    await B.js(`F1.net.setProfile({ name: '柏', car: 'Not A Car' }); F1.net.setProfile({ car: '2024-mclaren' })`);
    const ra = await A.js(`F1.net.join(${addr})`), rb = await B.js(`F1.net.join(${addr})`);
    check('both joined, A hosts', ra.ok && rb.ok && await A.js(`F1.net.isHost`) && !(await B.js(`F1.net.isHost`)), [ra, rb]);
    check('rosters carry the cars', await A.until(`F1.net.roster.length === 2 && F1.net.roster[1].car === '2024-mclaren' && F1.net.players[0].car === '2024-mclaren'`) &&
      await B.until(`F1.net.roster.length === 2 && F1.net.players[0].car === '2024-ferrari'`), await A.js(`F1.net.roster.map(function (p) { return [p.name, p.car]; })`));
    check('no year yet: net.year null, no event', (await A.js(`F1.net.year === null && !__ev.some(function (e) { return e[0] === 'year'; })`)));

    check('setYear: guest refused, bad year refused, host sent', (await B.js(`F1.net.setYear(2024)`)) === false &&
      (await A.js(`F1.net.setYear(2009)`)) === false && (await A.js(`F1.net.setYear(2024)`)) === true);
    check('the year reaches both, one event each', await A.until(`F1.net.year === 2024`) && await B.until(`F1.net.year === 2024`) &&
      JSON.stringify(await B.js(`__ev.filter(function (e) { return e[0] === 'year'; })`)) === '[["year",2024]]', await B.js(`__ev.filter(function (e) { return e[0] === 'year'; })`));
    await A.js(`F1.net.selectTrack('monza')`);
    check('track reaches B', await B.until(`F1.net.trackId === 'monza'`));

    await C.js(`F1.net.setProfile({ name: '晨', car: '2023-alpine' })`);
    const rc = await C.js(`F1.net.join(${addr})`);
    const order = await C.js(`__ev.filter(function (e) { return e[0] === 'connected' || e[0] === 'year' || e[0] === 'track'; })`);
    check('newcomer: connected, then year 2024, then track', rc.ok && JSON.stringify(order) === '[["connected",null],["year",2024],["track","monza"]]', order);
    check('newcomer car in the host roster', await A.until(`F1.net.roster.length === 3 && F1.net.roster[2].car === '2023-alpine'`));

    check('F1.gp.start (host) with year 1999 / wear 3 -> sent', (await A.js(`F1.gp.start({ q: 1, r: 1, year: 1999, wear: 3 }, 200)`)) === true);
    for (const [tag, w] of [['A', A], ['B', B], ['C', C]]) {
      check(tag + ': quali, view().year = the room year 2024, wear 3',
        await w.until(`F1.gp.phase === 'quali' && F1.gp.view().year === 2024 && F1.gp.view().wear === 3`), await w.js(`[F1.gp.phase, F1.gp.view().year, F1.gp.view().wear]`));
    }
    check('in a session: setYear refused locally', (await A.js(`F1.net.setYear(2025)`)) === false);
    await B.js(`F1.net.setProfile({ car: '2024-haas' }); F1.net.setProfile({ name: '柏二' })`);
    check('parc fermé: the rename arrives, the car stays', await A.until(`F1.net.roster[1].name === '柏二'`) && (await A.js(`F1.net.roster[1].car`)) === '2024-mclaren',
      await A.js(`F1.net.roster[1]`));
    check('B remembers its choice', (await B.js(`F1.net.getProfile().car`)) === '2024-haas');
    check('F1.gp.action(end) -> free', (await A.js(`F1.gp.action('end')`)) === true && await C.until(`F1.gp.phase === 'free'`));
    check('back in free practice the car goes out by itself', await C.until(`F1.net.players.filter(function (p) { return p.name === '柏二'; })[0].car === '2024-haas'`),
      await C.js(`F1.net.players.map(function (p) { return [p.name, p.car]; })`));
    check('the room year is unchanged by the session', (await C.js(`F1.net.year`)) === 2024 && (await A.js(`F1.gp.view().year`)) === 2024);

    // offline Grand Prix in its own page
    check('offline: F1.gp.start with year 2016 / wear 2', (await O.js(`F1.gp.start({ q: 1, r: 1, year: 2016, wear: 2 }, 5000)`)) === true &&
      (await O.js(`JSON.stringify([F1.gp.online, F1.gp.phase, F1.gp.view().year, F1.gp.view().wear, F1.gp.snapshot.year, F1.gp.snapshot.wear])`)) === '[false,"quali",2016,2,2016,2]',
      await O.js(`[F1.gp.online, F1.gp.phase, F1.gp.view().year, F1.gp.view().wear]`));

    await B.js(`F1.net.leave()`);
    check('leaving: net.year null, no extra year event', (await B.js(`F1.net.year === null && __ev.filter(function (e) { return e[0] === 'year'; }).length === 1`)));

    // a room with a password (what the host sets in net.create(port, {password}) goes to createServer the same way)
    pwSrv = await createServer({ port: PORT + 1, host: '127.0.0.1', password: '賽車 2024' });
    const paddr = JSON.stringify('127.0.0.1:' + (PORT + 1));
    const p1 = await B.js(`F1.net.join(${paddr})`);
    check('password room, none given: refused, asked for it', !p1.ok && p1.error === '這個房間需要密碼，請輸入房間密碼' && !(await B.js(`F1.net.connected`)), p1);
    const p2 = await B.js(`F1.net.join(${paddr}, { password: '賽車 2025' })`);
    check('password room, wrong one: refused', !p2.ok && p2.error === '房間密碼錯誤', p2);
    const p3 = await B.js(`F1.net.join(${paddr}, { password: '  賽車 2024 ' })`);
    check('password room, the right one (spaces around): in', p3.ok && await B.js(`F1.net.connected && F1.net.roster.length === 1`), p3);
    await B.js(`F1.net.leave()`);
    const errs = [];
    for (const w of [A, B, C, O]) errs.push.apply(errs, await w.js(`__err`));
    check('no page errors', errs.length === 0, errs);
    for (const w of [A, C]) await w.js(`F1.net.leave()`);
  } catch (e) {
    console.log('ERR', e && e.stack);
    results.push({ name: 'exception', ok: false });
  }
  if (srv) await srv.close();
  if (pwSrv) await pwSrv.close();
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed' + (bad.length ? ' — FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  app.exit(bad.length ? 1 : 0);
});
