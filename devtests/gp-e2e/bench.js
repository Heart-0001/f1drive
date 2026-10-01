// The autopilot in the REAL game, alone: N offscreen windows of the game (no room), each drives the racing line through the
// fake controller. Measures what the harness machine can do: frame rate per window with N windows rendering at once, lap
// times against the node simulation (devtests/gp-e2e/ap-sim.js), recovery from being thrown off.
//   npx electron devtests/gp-e2e/bench.js
//   env WINDOWS=4 (1..6)   PACES=1,0.93,0.82,0.6   LAPS=1 (timed laps per window)   TRACK=mc-1929   FPS=60   UPSET=1 (throw
//       window 1 off the road twice)   PATCH=... (see lib.js)
// Exit code 1 when a check fails. Takes about (LAPS + 0.1) * 105 s.
'use strict';
const electron = require('electron');
const { app } = electron;
const L = require('./lib');
require('../electron-userdata')(app, 'gp-e2e-bench');
const { sleep, check, info, setPart, fmt } = L;

const NWIN = Math.max(1, Math.min(6, Number(process.env.WINDOWS || 4)));
const PACES = (process.env.PACES || '1,0.93,0.82,0.6,0.93,0.82').split(',').map(Number);
const LAPS = Number(process.env.LAPS || 1);
const TRACK = process.env.TRACK || 'mc-1929';
const FPS = Number(process.env.FPS || 60);
const UPSET = process.env.UPSET === '1';

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const t0 = Date.now();
  const wins = [];
  try {
    setPart('bench');
    for (let i = 0; i < NWIN; i++) wins.push(L.makeWin(electron, null, 'W' + (i + 1), { fps: FPS }));
    for (const w of wins) { const err = await w.open(); check(w.tag + ' boots', !err, err || undefined); }
    const gpu = await app.getGPUInfo('basic').catch(() => null);
    info('GPU: ' + JSON.stringify(gpu && gpu.gpuDevice ? gpu.gpuDevice.map(d => ({ vendor: d.vendorId, device: d.deviceId, active: d.active })) : gpu));
    info('renderer: ' + await wins[0].js(`(function () { var c = document.createElement('canvas').getContext('webgl'); var e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`));
    for (const w of wins) { await w.pick(TRACK); }
    for (const w of wins) check(w.tag + ' loads the track', await w.until(`F1.game.running && F1.game.track`, 20000));
    await sleep(500);
    for (let i = 0; i < NWIN; i++) {
      check(wins[i].tag + ': the fake controller is seen by the game', await wins[i].until(`F1.gamepad.state.connected && __e2e.shown('hud-hint-pad')`, 3000));
      await wins[i].e(`set({ mode: 'line', scale: ${PACES[i % PACES.length]} })`);
      await wins[i].e('fps()');
      await wins[i].e('start()');
    }
    const pred = await wins[0].js(`F1.game.raceLine.lapTime`);
    info('line predicts ' + fmt(pred) + '; driving ' + LAPS + ' timed lap(s) per window');
    const done = wins.map(() => false), fpsLog = wins.map(() => []);
    let upsets = 0, shot = false;
    const end = Date.now() + (LAPS + 1.2) * (pred / Math.min(...PACES.slice(0, NWIN)) + 25) * 1000;
    while (Date.now() < end && !done.every(Boolean)) {
      await sleep(5000);
      const line = [];
      for (let i = 0; i < NWIN; i++) {
        const s = await wins[i].e('state()'), f = await wins[i].e('fps()');
        fpsLog[i].push(f);
        line.push(wins[i].tag + ' lap ' + s.lap.n + ' @' + s.car.i + ' ' + (s.car.v * 3.6).toFixed(0) + ' km/h ' + f.fps.toFixed(0) + ' fps (gap ' + f.maxGap.toFixed(0) + ')');
        if (s.lap.n > LAPS) done[i] = true;
        if (UPSET && i === 0 && s.lap.started && ((upsets === 0 && s.car.i > 300) || (upsets === 1 && s.car.i > 900))) {
          // thrown off: turned 0.8 rad at speed, then (second time) put against the wall facing it
          upsets++;
          await wins[0].js(upsets === 1 ? `F1.game.car.state.heading += 0.8; true`
            : `(function () { var c = F1.game.car.state, s = F1.game.track.samples[c.sampleIndex], d = -((s.wallNegDist || 12) - 1.05); c.x = s.x + s.nx * d; c.z = s.z + s.nz * d; c.heading = Math.atan2(-s.nx, -s.nz); c.speed = 0; return true; })()`);
          info('W1 thrown off (' + upsets + ') at sample ' + s.car.i);
        }
      }
      console.log('     ' + line.join(' | '));
      if (!shot && Date.now() - t0 > 30000) { shot = true; for (const w of wins) await w.shot('bench-' + w.tag); }
    }
    for (let i = 0; i < NWIN; i++) {
      const w = wins[i], pace = PACES[i % PACES.length];
      const s = await w.e('state()'), st = await w.e('stats()');
      const f = fpsLog[i], avg = f.reduce((a, b) => a + b.frames, 0) * 1000 / f.reduce((a, b) => a + b.ms, 0), worst = Math.min(...f.map(x => x.fps)), gap = Math.max(...f.map(x => x.maxGap));
      const clean = !(UPSET && i === 0);
      check(w.tag + ' (pace ' + pace + '): ' + LAPS + ' timed lap(s) done' + (clean ? ', no wall, no grass, no reset' : ' after being thrown off twice'),
        s.lap.n > LAPS && (clean ? st.wall === 0 && st.grass === 0 && st.resets === 0 && st.reverses === 0 : upsets === 2),
        { best: fmt(s.lap.best), last: fmt(s.lap.last), expected: fmt(pred / pace), wall: st.wall, grass: st.grass, reverses: st.reverses, resets: st.resets, maxDev: +st.maxDev.toFixed(2), events: st.events.slice(0, 6) });
      check(w.tag + ': frame rate usable (average >= 30 fps, no 5 s window under 20 fps)', avg >= 30 && worst >= 20, { avgFps: +avg.toFixed(1), worst5s: +worst.toFixed(1), longestFrameMs: +gap.toFixed(0) });
      check(w.tag + ': HUD lap time = the lap counter\'s', await w.js(`__e2e.text('hud-best') === F1.ui.formatTime(Math.round(F1.game.lap.best * 1000) / 1000)`), await w.e(`text('hud-best')`));
      await w.noErrors();
    }
  } catch (e) { check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  info('duration ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  const bad = L.summary();
  wins.forEach(w => { try { w.destroy(); } catch (e) {} });
  app.exit(bad ? 1 : 0);
});
