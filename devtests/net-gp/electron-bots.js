// npx electron devtests/net-gp/electron-bots.js
// Computer drivers ("bots") over the wire in real Chromium: the real js/net.js + js/gp.js in two pages against the real
// net/server.js (default clock). The host page sets 6 bots through F1.gp.setBots and drives them like the game would
// (sendBotStates at 20 Hz, progress through gp.botProgress, laps through gp.botLap); a whole Grand Prix on a 200 m
// "track" in real time: the guest sees the bots as remote cars with their names / cars / skill, both pages hold
// identical sessions with the bots classified, the server counts only bot laps their states cover, and the host
// leaving takes the bots with him. No game, no sound (pages only; the window is muted anyway).
// Port: env PORT (default 24772, inside the range reserved for the net owner).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'net-bots');          // own throw-away userData dir, removed on exit; muted
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
const PORT = Number(process.env.PORT || 24772);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
function makeWin(tag) {
  const w = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'netbots-' + tag, backgroundThrottling: false } });
  w.webContents.setAudioMuted(true);
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
const LINEUP = [
  { name: 'M. Verstappen', car: '2026-red-bull', colour: '#1e41ff', skill: 0.98 },
  { name: 'L. Norris', car: '2026-mclaren', colour: '#ff8000', skill: 0.95 },
  { name: 'C. Leclerc', car: '2026-ferrari', colour: '#e8002d', skill: 0.7 },
  { name: 'G. Russell', car: '2026-mercedes', colour: '#27f4d2', skill: 0.66 },
  { name: 'F. Alonso', car: '2026-aston-martin', colour: '#229971', skill: 0.36 },
  { name: 'A. Albon', car: '2026-williams', colour: '#64c4ff', skill: 0.02 }];

app.whenReady().then(async () => {
  let srv = null;
  try {
    srv = await createServer({ port: PORT, host: '127.0.0.1', random: () => 0 });
    const A = makeWin('A'), B = makeWin('B');
    await A.loadFile(path.join(__dirname, 'page-bots.html')); await B.loadFile(path.join(__dirname, 'page-bots.html'));
    check('pages loaded: F1.net, F1.gp with the bot API', await A.js(`!!(F1.net && F1.gp && F1.net.setBots && F1.net.sendBotStates && F1.gp.setBots && F1.gp.botLap && F1.gp.entry)`));
    const addr = JSON.stringify('127.0.0.1:' + PORT);
    const ra = await A.js(`F1.net.join(${addr})`), rb = await B.js(`F1.net.join(${addr})`);
    check('both joined, A hosts', ra.ok && rb.ok && await A.js(`F1.net.isHost`) && !(await B.js(`F1.net.isHost`)), [ra, rb]);
    const aId = await A.js(`F1.net.id`), bId = await B.js(`F1.net.id`);
    // the field: only the host, only in free practice
    check('a guest cannot set bots', (await B.js(`F1.gp.setBots(3, 'pro')`)) === false);
    check('the host sets 6 (mixed)', (await A.js(`F1.gp.setBots(${JSON.stringify(LINEUP)}, 'mixed')`)) === true);
    check('the host\'s gp.bots(): 6 with ids, slots 2..7, list order', await A.until(`F1.gp.bots().length === 6`) &&
      JSON.stringify(await A.js(`F1.gp.bots().map(function (b) { return [b.name, b.car, b.skill, b.slot, b.bi]; })`)) ===
      JSON.stringify(LINEUP.map((b, i) => [b.name, b.car, b.skill, i + 2, i])), await A.js(`F1.gp.bots()`));
    const ids = await A.js(`F1.gp.bots().map(function (b) { return b.id; })`);
    check('the host\'s bots are local cars: not in his net.players', await A.js(`F1.net.players.length === 1 && F1.net.players[0].id === ${bId}`));
    check('the guest sees them as remote cars with name / car / skill / colour', await B.until(`F1.net.players.filter(function (p) { return p.bot; }).length === 6`) &&
      JSON.stringify(await B.js(`F1.net.players.filter(function (p) { return p.bot; }).map(function (p) { return [p.id, p.name, p.car, p.skill, p.colour, p.owner]; })`)) ===
      JSON.stringify(LINEUP.map((b, i) => [ids[i], b.name, b.car, b.skill, b.colour, aId])));
    check('events: bots for the owner only', JSON.stringify(await A.js(`__ev.filter(function (e) { return e[0] === 'gp.bots'; }).pop()`)) === JSON.stringify(['gp.bots', ids, null]) &&
      (await B.js(`__ev.filter(function (e) { return e[0] === 'gp.bots' && e[1].length; }).length`)) === 0);
    const vb = await B.js(`F1.gp.view().bots`), va = await A.js(`F1.gp.view().bots`);
    check('view().bots: count / level / max / who may edit', JSON.stringify([va, vb]) === JSON.stringify([{ count: 6, skill: 'mixed', max: 14, canEdit: true }, { count: 6, skill: 'mixed', max: 14, canEdit: false }]), [va, vb]);
    // the host page drives its bots (and its own car), the guest its own car
    await A.js(`__driveBots()`);
    await B.js(`window.__x = 0; window.__drive = setInterval(function () { __x += 4.5; F1.net.sendState({ x: __x, z: -10, heading: Math.PI / 2, speed: 90 }, true); }, 50); true`);
    check('bot poses reach the guest, each in its lane', await B.until(`(function () { F1.net.update(); var bs = F1.net.players.filter(function (p) { return p.bot; });
      return bs.length === 6 && bs.every(function (p, i) { return p.active && Math.abs(p.state.z - 10 * (i + 1)) < 0.01 && p.state.x > 0; }); })()`, 3000));
    // a Grand Prix with them: Q 1 / R 1 on a 200 m track
    await A.js(`F1.net.selectTrack('monza')`);
    check('track on both', await B.until(`F1.net.trackId === 'monza'`));
    check('the host starts', (await A.js(`F1.gp.start({ q: 1, r: 1 }, 200)`)) === true);
    check('quali on both', await A.until(`F1.gp.phase === 'quali'`) && await B.until(`F1.gp.phase === 'quali'`));
    const tq = Date.now();
    check('parc fermé: the field cannot change', (await A.js(`F1.gp.setBots(2)`)) === false);
    check('a bot lap too early: rejected by id, not as ours', (await A.js(`F1.gp.botLap(${ids[5]}, 2.5)`)) === '' &&
      await A.until(`__ev.some(function (e) { return e[0] === 'gp.botLapRejected' && e[1] === ${ids[5]} && e[2] === 'too-soon'; })`) &&
      (await A.js(`__ev.filter(function (e) { return e[0] === 'net.lapRejected'; }).length`)) === 0);
    await sleep(2400 - (Date.now() - tq));
    // laps: the bots' in skill order, then the humans'
    const ql = await A.js(`${JSON.stringify(ids)}.map(function (id, i) { return F1.gp.botLap(id, 2.2 + i * 0.01); })`);
    check('the host reports his bots\' laps', ql.every(r => r === ''), ql);
    check('the guest cannot', (await B.js(`F1.gp.botLap(${ids[0]}, 2.2)`)) === 'not-ours');
    await A.js(`F1.gp.lapDone(2.27)`); await B.js(`F1.gp.lapDone(2.28)`);
    check('grid on both, by time, bots included', await A.until(`F1.gp.phase === 'grid'`) && await B.until(`F1.gp.phase === 'grid'`) &&
      JSON.stringify(await B.js(`F1.gp.snapshot.grid`)) === JSON.stringify(ids.concat([aId, bId])), await B.js(`F1.gp.snapshot.grid`));
    check('entry(): a bot\'s grid slot and lock', JSON.stringify(await A.js(`(function () { var e = F1.gp.entry(${ids[2]}); return [e.bot, e.taking, e.gridSlot, e.locked, e.lapTotal]; })()`)) ===
      JSON.stringify([true, true, 2, true, 1]));
    check('race on both', await A.until(`F1.gp.phase === 'race'`, 12000) && await B.until(`F1.gp.phase === 'race'`, 3000));
    check('botsGo on the host only, once', await A.until(`__ev.filter(function (e) { return e[0] === 'gp.botsGo'; }).length === 1`) &&
      (await B.js(`__ev.filter(function (e) { return e[0] === 'gp.botsGo'; }).length`)) === 0);
    const tr = Date.now();
    // live order from progress: the host holds bot 0 back (0.001 of a lap), the humans report a little more
    await A.js(`__hold[${ids[0]}] = 0.001; F1.gp.setProgress(0.01); true`); await B.js(`F1.gp.setProgress(0.005)`);
    check('live order: the bots by their progress', await B.until(`JSON.stringify(F1.gp.snapshot.order) === ${JSON.stringify(JSON.stringify(ids.slice(1).concat([aId, bId, ids[0]])))}`, 3000),
      await B.js(`F1.gp.snapshot.order`));
    await sleep(2400 - (Date.now() - tr));
    await A.js(`${JSON.stringify(ids)}.map(function (id, i) { return F1.gp.botLap(id, 2.3 + i * 0.01); })`);
    await A.js(`F1.gp.lapDone(2.37)`); await B.js(`F1.gp.lapDone(2.38)`);
    check('results on both', await A.until(`F1.gp.phase === 'results'`) && await B.until(`F1.gp.phase === 'results'`));
    const sa = await A.js(`F1.net.session`), sb = await B.js(`F1.net.session`);
    check('identical sessions on both pages', JSON.stringify(sa) === JSON.stringify(sb));
    check('classification by race time, bots classified', JSON.stringify(sb.order) === JSON.stringify(ids.concat([aId, bId])) &&
      sb.players.every(p => p.fin && p.rLaps === 1) && sb.players.filter(p => p.bot).length === 6, sb.players.map(p => [p.id, p.rTime, p.bot === true]));
    const rows = await B.js(`F1.gp.view().rows.map(function (r) { return [r.id, r.bot, r.skill, r.car, r.colour]; })`);
    check('the guest\'s view rows: bot / skill / car / colour', JSON.stringify(rows.slice(0, 6)) === JSON.stringify(LINEUP.map((b, i) => [ids[i], true, b.skill, b.car, b.colour])) &&
      rows[6][1] === false && rows[7][1] === false, rows);
    // the host leaves: his bots go; the classification stays
    await A.js(`clearInterval(window.__botTimer); F1.net.leave(); true`);
    check('the host leaving takes his bots', await B.until(`F1.net.players.length === 0 && F1.net.roster.length === 1`, 3000) &&
      await B.js(`F1.gp.view().bots.count === 0 && F1.gp.phase === 'results'`));
    check('his page is back offline with no bots', await A.js(`!F1.net.connected && F1.gp.bots().length === 0 && !F1.gp.online`));
    await B.js(`clearInterval(window.__drive); F1.net.leave(); true`);
    check('no page errors', (await A.js(`__err.length`)) + (await B.js(`__err.length`)) === 0, [await A.js(`__err`), await B.js(`__err`)]);
  } catch (e) {
    console.log('ERR', e && e.stack);
    results.push({ name: 'exception', ok: false });
  }
  if (srv) await srv.close();
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed' + (bad.length ? ' — FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  app.exit(bad.length ? 1 : 0);
});
