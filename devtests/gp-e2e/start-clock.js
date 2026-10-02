// The online race clock at lights out, measured over several starts: host + guest in a room (real preload / host IPC /
// server), Grand Prix -> skip -> grid -> lights out, both cars launch on the autopilot, 3 s of racing, end. Per start:
//   - how long after its rAF timestamp the lights-out frame really ran (frame delay)
//   - the race clock (the lap counter's time, which becomes the lap / race time in the classification) against the
//     session clock, in every frame of the first seconds: it may lag by the physics time not simulated yet, it must
//     never be AHEAD (the driver would be classified with more time than has passed)
// Every other start a main-thread hitch of HITCH ms is injected on the guest right before its lights-out frame (what a
// GC pause or a slow frame at that moment does).
//   npx electron devtests/gp-e2e/start-clock.js          about 80 s; exit code 1 when a check fails
//   env ROUNDS=6   HITCH=12 (ms)   PORT=24860   PATCH=js/main.js=<patched copy>  (see lib.js)
'use strict';
const electron = require('electron');
const { app, ipcMain } = electron;
const path = require('path');
const L = require('./lib');
require('../electron-userdata')(app, 'gp-e2e-clock');
const host = require(path.join(L.ROOT, 'net', 'host'));
const { sleep, check, info, setPart } = L;

const PORT = Number(process.env.PORT || 24860);
const ROUNDS = Number(process.env.ROUNDS || 6);
const HITCH = Number(process.env.HITCH || 12);
const TRACK = 'mc-1929';
const AHEAD_MAX = 3;                                // ms the race clock may be ahead (timer resolution, clock estimate)

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  host.register(ipcMain);
  const H = L.makeWin(electron, host, 'H'), G = L.makeWin(electron, host, 'G');
  const rows = [];
  try {
    setPart('room');
    for (const w of [H, G]) { const err = await w.open(); check(w.tag + ' boots', !err, err || undefined); }
    info('page: ' + L.pageFile() + (L.patched.length ? '   PATCHED: ' + L.patched.join(', ') : ''));
    // v6: the menu's side panel is tabbed; the room controls are in the 多人連線 tab (a control in a hidden tab cannot be clicked)
    check('v6 menu: the 多人連線 tab opens on both windows', (await H.click('tab-mp')) && (await G.click('tab-mp')) &&
      (await H.js(`!document.getElementById('mp-section').classList.contains('hidden')`)) && (await G.js(`!document.getElementById('mp-section').classList.contains('hidden')`)));
    await H.field('mp-name', 'Hana'); await H.field('mp-port', String(PORT));
    await H.click('mp-create');
    check('H hosts', await H.until(`F1.net.connected && F1.net.isHost`, 6000), await H.e(`text('mp-status')`));
    await G.field('mp-name', 'Gus'); await G.field('mp-addr', '127.0.0.1:' + PORT);
    await G.click('mp-join');
    check('G joins', await G.until(`F1.net.connected`, 6000), await G.e(`text('mp-status')`));
    // v7.2: the room is set up in the lobby (the track, 大獎賽, Q 1 / R 1); a round starts with 開始 and the loading
    // barrier (from the lobby) or with 再來一場 (from the results): they alternate
    check('H sets the room up in the lobby: the track, 大獎賽, Q 1, R 1', await L.roomSet(H, { track: TRACK, mode: 'gp', q: 1, r: 1 }));
    const onTrack = `F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id`;
    for (const w of [H, G]) { await w.e('start()'); }

    for (let r = 0; r < ROUNDS; r++) {
      const hitch = r % 2 === 1 ? HITCH : 0;
      setPart('start ' + (r + 1) + (hitch ? ' (hitch ' + hitch + ' ms on G)' : ''));
      await H.e(`arm({ onPhase: { quali: { mode: 'idle' }, grid: { mode: 'line', scale: 1, holdFor: 0, park: null } }, onGo: { holdFor: 0 } })`);
      await G.e(`arm({ onPhase: { quali: { mode: 'idle' }, grid: { mode: 'line', scale: 0.9, holdFor: 0, park: null } }, onGo: { holdFor: 0.6 } })`);
      await G.js(`__e2e.hitch = ${hitch}; true`);
      const fromLobby = await H.js(`F1.net.room.st === 'lobby'`);
      const started = fromLobby ? await L.roomStart(H, [G], { gp: true }) && await H.until(onTrack, 3000) && await G.until(onTrack, 3000)
        : await H.js(`F1.game.gp.action('again')`);
      info('round ' + (r + 1) + ' started ' + (fromLobby ? 'from the lobby (開始 + the barrier)' : 'with 再來一場'));
      await H.until(`F1.game.gp.phase === 'quali'`, 3000); await G.until(`F1.game.gp.phase === 'quali'`, 3000);
      await H.js(`F1.game.gp.action('skip')`);
      const grid = await H.until(`F1.game.gp.phase === 'grid'`, 3000) && await G.until(`F1.game.gp.phase === 'grid' && F1.game.gp.inputLocked`, 3000);
      // (nothing is polled while the lights are on: the pages are left alone)
      await sleep(10500);
      const racing = await H.until(`F1.game.gp.phase === 'race' && __e2e.raceClock && __e2e.raceClock.n >= 150`, 6000) && await G.until(`F1.game.gp.phase === 'race' && __e2e.raceClock && __e2e.raceClock.n >= 150`, 6000);
      const d = await Promise.all([H, G].map(w => w.js(`(function () { var c = __e2e.raceClock, g = __e2e.go; return { n: c.n, first: c.first, max: c.max, min: c.min, mean: c.sum / c.n, goFrameDelay: c.goFrameDelay,
        delayMax: c.delayMax, delayMean: c.delaySum / c.n, goAfterGoAt: g.server - g.goAt, v: F1.game.car.state.speed, lap: F1.game.lap.time, sinceGo: F1.gp.sinceGo }; })()`)));
      check('Grand Prix ' + (r + 1) + ': start, grid, lights out, both racing', started === true && grid && racing && d.every(x => x.v > 5), d.map(x => x.v));
      ['H', 'G'].forEach((tag, i) => {
        const x = d[i];
        rows.push({ round: r + 1, tag, hitch: i === 1 ? hitch : 0, ...x });
        info(tag + ': lights-out frame ran ' + x.goFrameDelay.toFixed(1) + ' ms after its timestamp, ' + x.goAfterGoAt.toFixed(1) + ' ms after goAt; race clock - session clock over ' + x.n +
          ' frames: first ' + x.first.toFixed(2) + ', max ' + x.max.toFixed(2) + ', min ' + x.min.toFixed(2) + ', mean ' + x.mean.toFixed(2) + ' ms; frame delay mean ' + x.delayMean.toFixed(2) + ', max ' + x.delayMax.toFixed(1) + ' ms');
      });
      check('the race clock is never ahead of the session clock (by more than ' + AHEAD_MAX + ' ms) in the first 150+ frames after lights out, on either car', d.every(x => x.max <= AHEAD_MAX),
        d.map(x => ({ aheadMaxMs: +x.max.toFixed(2), goFrameDelayMs: +x.goFrameDelay.toFixed(1) })));
      check('... and never behind by more than a physics step + two frames (8.3 + 33 ms)', d.every(x => x.min >= -42), d.map(x => +x.min.toFixed(2)));
      await H.js(`F1.game.gp.action('end')`);
      await H.until(`F1.game.gp.phase === 'results'`, 3000); await G.until(`F1.game.gp.phase === 'results'`, 3000);
      for (const w of [H, G]) await w.e(`set({ mode: 'stop' })`);
      await H.until(`Math.abs(F1.game.car.state.speed) < 0.5`, 8000); await G.until(`Math.abs(F1.game.car.state.speed) < 0.5`, 8000);
      if (Math.floor((r + 1) / 2) % 2 === 0) {               // (the next round from the lobby: the end in the results goes back there; rounds L L A A L L, the hitch on every second)
        await sleep(300); await H.js(`F1.game.gp.action('end')`);
        await H.until(`F1.game.gp.phase === 'free' && F1.net.room.st === 'lobby'`, 3000); await G.until(`F1.game.gp.phase === 'free' && F1.net.room.st === 'lobby'`, 3000);
      }
    }
    setPart('end');
    for (const w of [H, G]) await w.noErrors();
  } catch (e) { check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  console.log('\n--- measured (ms) ---');
  console.log('start car hitch  go-frame-delay  go-after-goAt  clock-ahead: first    max     min    mean   frame-delay: mean   max');
  rows.forEach(x => console.log(String(x.round).padStart(5) + '  ' + x.tag + '  ' + String(x.hitch).padStart(4) + '  ' + x.goFrameDelay.toFixed(1).padStart(13) + '  ' + x.goAfterGoAt.toFixed(1).padStart(13) + '  ' +
    x.first.toFixed(2).padStart(18) + x.max.toFixed(2).padStart(8) + x.min.toFixed(2).padStart(8) + x.mean.toFixed(2).padStart(8) + x.delayMean.toFixed(2).padStart(19) + x.delayMax.toFixed(1).padStart(6)));
  const bad = L.summary();
  try { await host.stopServer(); } catch (e) {}
  [H, G].forEach(w => { try { w.destroy(); } catch (e) {} });
  app.exit(bad ? 1 : 0);
});
