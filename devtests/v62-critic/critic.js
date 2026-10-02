// v6.2 critic: the v6.2 changes played like the user would (offscreen Electron windows, MUTED by
// devtests/electron-userdata.js; keys = main.js's own key handlers, a fake standard controller; time-warped where the car
// is driven: gp-e2e/solo-page.js), screenshots in devtests/v62-critic/out/ (READ them), NOTE lines with what was measured.
// Parts:
//   hairpin  Monaco's Fairmont hairpin at 45 / 50 km/h on the keys (racing line and the middle of the road) and on the pad,
//            and at 20 km/h (the user's report); the fresh-install 2026 car and the 2025 reference car
//   tunnel   Monaco's tunnel: the light (main.js's scene lights), the reverb (F1.audio.debug), both kinds of mirror
//   spa      Eau Rouge -> Raidillon (pitch of the car and of the camera, pictures at speed and standing)
//   bank     Zandvoort T3 / T14 and Madring's La Monumental (roll of the car and of the camera, corner speeds)
//   suzuka   the crossover from both roads (under the deck / over it, R on the deck and under it)
//   silver   Silverstone's new start line / grid / pits; the pit lane on the pad: the compound prompt, X, the box
//   names    the Chinese names and the search ('japan', '日本', '鈴鹿', 'suzuka', 'monza', '蒙札' ...), real typing
//   fov      設定 → 視野 with real keys / mouse, remembered, the cockpit camera
//   pits     pit stops at Singapore and Zandvoort in 2024 (60 km/h) and 2025 / 2026 (80 km/h), on the pad
// Exit code 1 when a check fails.
//   npx electron devtests/v62-critic/critic.js        env ONLY=<parts>
'use strict';
const { app, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
require('../electron-userdata')(app, 'v62-critic');
const L = require('../v61-critic/lib');
const { sleep, J, results, state, check, note } = L;
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PAGE = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
const r1 = v => Math.round(v * 10) / 10;

function makeWin(tag, opts) {
  const w = L.makeWin(tag, opts);
  w.shot = async (n, draw) => {
    if (draw) await w.js(`window.__e && __e.draw ? __e.draw() : true`);
    await sleep(draw ? 150 : 300);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, n + '.png'), img.toPNG());
    console.log('shot ' + n + '.png');
    return img;
  };
  const open = w.open;
  w.open = async o => { const e = await open(o); await w.js(PAGE); return e; };
  w.now = () => w.js(`__q.now()`);
  // pump until the car is at sample i (within `ahead` samples after it), at most maxS s of game time
  w.until_i = (i, maxS, ahead) => w.pump(`(function () { var N = g.track.samples.length, k = ((g.car.state.sampleIndex - ${i}) % N + N) % N; return k <= ${ahead || 25}; })()`, maxS || 60, 'sample ' + i);
  w.rec = () => w.js(`(function () { var r = JSON.parse(JSON.stringify(__q.d.rec)); r.vminK = r.vmin * 3.6; r.vmaxK = r.vmax * 3.6; r.keyEvents = __q.keyEvents - r.keyPresses0; delete r.path; return r; })()`);
  w.path = () => w.js(`__q.d.rec.path`);
  return w;
}
const deg = r => r * 180 / Math.PI;

/* ================= Monaco's hairpin ================= */
async function hairpinRuns(w, label) {
  const N = await w.js(`F1.game.track.samples.length`);
  const lockInfo = await w.js(`(function () { var p = F1.game.car.perf, o = {}; [20, 45, 50, 55, 60].forEach(function (k) { o[k] = +(p.wheelbase / Math.tan(p.steerLockAt(k / 3.6, 0, -1))).toFixed(2); }); return { spec: F1.game.spec.id, radius: o }; })()`);
  note(label + ': full-lock turning radius (m) by km/h ' + J(lockInfo));
  const runs = [
    { n: 'keys-line-45', input: 'keys', path: 'line', v: 45 },
    { n: 'keys-line-50', input: 'keys', path: 'line', v: 50 },
    { n: 'keys-middle-45', input: 'keys', path: 'centre', off: 0, v: 45 },
    { n: 'keys-outside-50', input: 'keys', path: 'centre', off: 2.5, v: 50 },
    { n: 'keys-middle-20', input: 'keys', path: 'centre', off: 0, v: 20 },
    { n: 'pad-line-50', input: 'pad', path: 'line', v: 50 },
    { n: 'pad-middle-47', input: 'pad', path: 'centre', off: 0, v: 47 }
  ];
  const out = {};
  for (const r of runs) {
    if (r.input === 'keys') await w.js(`__q.unplug()`); else await w.js(`__q.plug()`);
    await w.frames(3);
    const st = await w.js(`__q.place(592, 105)`);
    const stopU = ((700 - st) % N + N) % N;
    await w.js(`__q.drive(${J({ input: r.input, path: r.path, off: r.off || 0, vKmh: r.v, hold: [622, 648], rec: [622, 648], stopU, then: 'stop' })})`);
    if (r.n === 'keys-line-50' || r.n === 'pad-line-50' || r.n === 'keys-middle-45') {
      await w.until_i(624, 20, 4);
      await w.shot(label + '-hairpin-' + r.n + '-a-turnin', true);
      await w.until_i(634, 20, 4);
      await w.shot(label + '-hairpin-' + r.n + '-b-apex', true);
    }
    await w.pump(`__q.d.done`, 30, 'run ' + r.n);
    const rec = await w.rec();
    out[r.n] = rec;
    note(label + ' ' + r.n + ': ' + J({ v: [r1(rec.vminK), r1(rec.vmaxK)], steerMax: +rec.steerMax.toFixed(2), hits: rec.hits, maxHit: +rec.maxHit.toFixed(2), grass: rec.grass,
      wallMin: +rec.wallMin.toFixed(2), edgeMax: +rec.edgeMax.toFixed(2), keys: rec.keyEvents, frames: rec.recFrames, done: rec.frames }));
    const ok = rec.hits === 0 && rec.recFrames > 30 && rec.vmaxK < r.v + 3 && rec.vminK > r.v - 6;   // (hits: the whole run, from 60 m before the corner to 100 m after it)
    check(label + ' ' + r.n + ': through the hairpin at ' + r.v + ' km/h with no wall contact', ok,
      { v: [r1(rec.vminK), r1(rec.vmaxK)], hits: rec.hits, wallMin: rec.wallMin, grass: rec.grass, steerMax: rec.steerMax });
  }
  return out;
}
async function partHairpin() {
  state.part = 'hairpin';
  // a fresh install: the 2026 season's standard car (what the user drives by default)
  let w = makeWin('hp26');
  await w.open({ fresh: true, warp: true });
  check('Monaco picked (fresh install: 2026 standard car)', await w.pickTrackWarp('mc-1929'));
  await w.js(`__e.ap.mode = 'line'; true`);
  const a = await hairpinRuns(w, '2026');
  await w.noErrors();
  w.destroy();
  // the 2025 reference car (the calibration anchor)
  w = makeWin('hp25');
  await w.open({ warp: true });
  check('Monaco picked (2025 reference car)', await w.pickTrackWarp('mc-1929'));
  await w.js(`__e.ap.mode = 'line'; true`);
  const b = await hairpinRuns(w, '2025');
  // the whole lap on the keys from the start line: Ste Devote, Casino, Mirabeau, the hairpin (no takeover)
  await w.js(`__q.unplug()`);
  await w.tap('Escape'); await w.until(`!F1.game.running`, 3000, 'menu');
  await w.pickTrackWarp('mc-1929');
  const st = await w.js(`F1.game.car.state.sampleIndex`);
  await w.js(`__q.drive(${J({ input: 'keys', path: 'line', vKmh: 48, hold: [622, 648], rec: [600, 700], stopU: ((720 - st) % 1663 + 1663) % 1663, then: 'stop' })})`);
  await w.pump(`__q.d.done`, 90, 'keys from the start to after the hairpin');
  const c = await w.rec();
  note('2025 keys from the start line: ' + J({ v: [r1(c.vminK), r1(c.vmaxK)], hits: c.hits, grass: c.grass, wallMin: c.wallMin, steerMax: c.steerMax, frames: c.frames }));
  check('2025 keys from the start line through Ste Devote .. Mirabeau and the hairpin at 48 km/h: no wall contact anywhere', c.hits === 0 && c.recFrames > 50, { hits: c.hits, maxHit: c.maxHit, grass: c.grass });
  await w.noErrors();
  w.destroy();
  return { a, b };
}

/* ================= Monaco's tunnel ================= */
async function partTunnel() {
  state.part = 'tunnel';
  const w = makeWin('tunnel');
  await w.open({ fresh: true, warp: true });
  check('Monaco picked', await w.pickTrackWarp('mc-1929'));
  const tl = await w.js(`F1.game.tunnels ? F1.game.tunnels.tunnels.map(function (t) { return { name: t.name, from: t.from, to: t.to, len: Math.round(t.length), w: +t.width.toFixed(1), h: +t.height.toFixed(1) }; }) : null`);
  note('tunnels: ' + J(tl));
  const T = tl && tl.find(t => t.name === 'Tunnel');
  check('main.js built the tunnels (Portier + the 368 m tunnel)', !!T && tl.length === 2, tl);
  if (!T) { w.destroy(); return; }
  await w.js(`__q.plug(); __e.ap.mode = 'line'; true`);
  const st = await w.js(`__q.place(${T.from - 90}, 'line')`);
  const N = 1663;
  await w.js(`__q.drive(${J({ input: 'pad', path: 'line', rec: [T.from - 30, T.to + 30], stopU: ((T.to + 80 - st) % N + N) % N, then: 'line' })})`);
  const pts = [['01-approach', T.from - 25], ['02-portal', T.from + 6], ['03-colonnade', T.from + 50], ['04-deep', T.from + Math.round((T.to - T.from) * 0.75)], ['05-exit', T.to - 6], ['06-out', T.to + 40]];
  const seen = {};
  for (const [n, i] of pts) {
    await w.until_i(i, 20, 3);
    await sleep(350);                         // (the audio params ramp in real time: tau 0.05 s)
    seen[n] = await w.now();
    await w.shot('tunnel-' + n, true);
    note(n + ': ' + J({ i: seen[n].i, kmh: seen[n].kmh, tunnel: seen[n].tunnel, covered: seen[n].covered, hemi: seen[n].hemi, sun: seen[n].sun, audio: seen[n].audio, mirrors: seen[n].mirrors, cockpitMirrors: seen[n].cockpitMirrors }));
  }
  const deep = seen['04-deep'], out = seen['06-out'], ap = seen['01-approach'];
  check('deep in the tunnel: the scene lights dimmed (sun off, hemisphere down), daylight again outside', deep.sun < 0.2 && deep.hemi < 0.95 && out.sun > 0.99 && out.hemi > 0.99 && ap.sun > 0.99, { deep: [deep.hemi, deep.sun], out: [out.hemi, out.sun] });
  check('deep in the tunnel: the reverb is connected and the tunnel k sent (F1.audio.debug), wet gain ramped up', deep.audio && deep.audio.reverb && deep.audio.tunnel > 0.9 && deep.audio.wet > 0.3 && deep.audio.builds >= 1, deep.audio);
  check('approach: no tunnel sound yet', ap.audio && ap.audio.tunnel === 0, ap.audio);
  check('the HUD mirrors and the cockpit mirrors keep drawing inside the tunnel', deep.mirrors && deep.mirrors.visible && deep.mirrors.passes > seen['02-portal'].mirrors.passes && deep.cockpitMirrors > seen['02-portal'].cockpitMirrors, { portal: seen['02-portal'].mirrors, deep: deep.mirrors });
  await w.pump(`__q.d.done`, 30, 'tunnel run');
  const rec = await w.rec();
  note('tunnel run: ' + J({ v: [r1(rec.vminK), r1(rec.vmaxK)], hits: rec.hits, tunnelMax: rec.tunnelMax, hemiMin: rec.hemiMin, sunMin: rec.sunMin, reverb: rec.reverbOn }));
  check('through the tunnel on the line at speed: no wall contact', rec.hits === 0, rec);
  // 2 s after leaving: the reverb disconnected (no CPU outside the tunnels)
  await w.frames(240); await sleep(400);
  const after = await w.now();
  note('after: ' + J(after.audio));
  check('after the tunnel (4 s on): the reverb is disconnected again, k 0', after.audio && after.audio.tunnel === 0 && !after.audio.reverb, after.audio);
  await w.noErrors();
  w.destroy();
}

/* ================= Spa: Eau Rouge -> Raidillon ================= */
async function partSpa() {
  state.part = 'spa';
  const w = makeWin('spa');
  await w.open({ fresh: true, warp: true });
  check('Spa picked', await w.pickTrackWarp('be-1925'));
  const prof = await w.js(`(function () { var S = F1.game.track.samples, o = []; for (var i = 430; i <= 560; i += 10) o.push([i, +S[i].y.toFixed(1)]); return o; })()`);
  note('Spa heights (sample, y): ' + J(prof));
  await w.js(`__q.plug(); __e.ap.mode = 'line'; true`);
  const st = await w.js(`__q.place(380, 290)`);
  await w.js(`__q.drive(${J({ input: 'pad', path: 'line', rec: [440, 560], stopU: ((600 - st) % 3502 + 3502) % 3502, then: 'stop' })})`);
  const seen = {};
  for (const [n, i] of [['01-descent', 440], ['02-bottom', 466], ['03-raidillon', 492], ['04-raidillon-high', 512], ['05-top', 540]]) {
    await w.until_i(i, 20, 3);
    seen[n] = await w.now();
    await w.shot('spa-speed-' + n, true);
  }
  await w.pump(`__q.d.done`, 30, 'spa run');
  const rec = await w.rec();
  note('Spa at speed: ' + J(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { i: v.i, kmh: v.kmh, y: v.y, carPitch: v.carPitchDeg, camPitch: v.camPitchDeg, compress: v.compress && +v.compress.toFixed(2) }]))));
  check('Eau Rouge / Raidillon flat out on the line: no wall contact, no grass', rec.hits === 0 && rec.grass === 0, { hits: rec.hits, grass: rec.grass, v: [rec.vminK, rec.vmaxK] });
  check('Raidillon: the car pitches up more than 6 deg (a 14 % climb), the camera shows it pitched up', deg(rec.carPitchMax) > 6 && seen['03-raidillon'].camPitchDeg > 2, { car: deg(rec.carPitchMax), seen: seen['03-raidillon'] });
  // standing on the climb (a practice restart there): the steady view
  for (const [n, i] of [['06-standing-bottom', 470], ['07-standing-raidillon', 500]]) {
    await w.js(`__q.place(${i}, 0); true`);
    await w.frames(90);
    const s = await w.now();
    note(n + ': ' + J({ i: s.i, y: s.y, carPitch: s.carPitchDeg, camPitch: s.camPitchDeg }));
    await w.shot('spa-' + n, true);
  }
  await w.noErrors();
  w.destroy();
}

/* ================= Zandvoort T3 / T14, Madring La Monumental ================= */
async function bankRun(w, id, name, a, b, place, vPlace, N) {
  await w.js(`__q.plug(); __e.ap.mode = 'line'; true`);
  const st = await w.js(`__q.place(${place}, ${vPlace})`);
  await w.js(`__q.drive(${J({ input: 'pad', path: 'line', rec: [a, b], stopU: ((b + 40 - st) % N + N) % N, then: 'line' })})`);
  const mid = Math.round((a + b) / 2);
  await w.until_i(a + 10, 30, 4);
  await w.shot('bank-' + name + '-a-entry', true);
  await w.until_i(mid, 30, 4);
  const m = await w.now();
  await w.shot('bank-' + name + '-b-mid', true);
  await w.pump(`__q.d.done`, 40, name);
  const rec = await w.rec();
  const line = await w.js(`(function () { var P = F1.game.raceLine.points, mn = 1e9; for (var i = ${a}; i <= ${b}; i++) mn = Math.min(mn, P[i % ${N}].speed); return mn * 3.6; })()`);
  note(name + ': ' + J({ driven: [r1(rec.vminK), r1(rec.vmaxK)], lineMin: r1(line), carRollMax: r1(deg(rec.carRollMax)), camRollMax: r1(deg(rec.camRollMax)), mid: { kmh: m.kmh, carRoll: m.carRollDeg, camRoll: m.camRollDeg, compress: m.compress && +m.compress.toFixed(2) }, hits: rec.hits, grass: rec.grass }));
  return { rec, mid: m, line };
}
async function partBank() {
  state.part = 'bank';
  const w = makeWin('bank');
  await w.open({ fresh: true, warp: true });
  check('Zandvoort picked', await w.pickTrackWarp('nl-1948'));
  const t3 = await bankRun(w, 'nl-1948', 'zandvoort-T3', 420, 505, 330, 170, 2130);
  const t14 = await bankRun(w, 'nl-1948', 'zandvoort-T14', 1850, 1995, 1760, 200, 2130);
  for (const [n, r] of [['T3', t3], ['T14', t14]]) {
    check('Zandvoort ' + n + ' on the line: no wall / grass, the camera rolls visibly (> 7 deg) but less than the car (19 / 18 deg banking)',
      r.rec.hits === 0 && r.rec.grass === 0 && Math.abs(r.mid.camRollDeg) > 7 && Math.abs(r.mid.camRollDeg) < Math.abs(r.mid.carRollDeg), { mid: r.mid, hits: r.rec.hits });
  }
  // (the 2026 standard car: the 2025 reference car's line is 137 km/h at T3, real 2023-24 cars 142-151; devtests/v62-critic/bank-ab.js
  //  compares banked against flat)
  check('Zandvoort T3 with the 2026 car: the line > 120 km/h and the driver within 8 km/h of it', t3.line > 120 && t3.rec.vminK > t3.line - 8, { driven: t3.rec.vminK, line: t3.line });
  await w.tap('Escape'); await w.until(`!F1.game.running`, 3000, 'menu');
  check('Madring picked', await w.pickTrackWarp('es-2026'));
  const mon = await bankRun(w, 'es-2026', 'madring-monumental', 1115, 1375, 1020, 200, 2708);
  check('Madring La Monumental on the line: no wall / grass, the camera rolls visibly (> 5 deg; 13.5 deg banking)', mon.rec.hits === 0 && mon.rec.grass === 0 && Math.abs(mon.mid.camRollDeg) > 5, mon.mid);
  await w.noErrors();
  w.destroy();
  return { t3, t14, mon };
}

/* ================= Suzuka's crossover ================= */
async function partSuzuka() {
  state.part = 'suzuka';
  const w = makeWin('suzuka');
  await w.open({ fresh: true, warp: true });
  check('Suzuka picked', await w.pickTrackWarp('jp-1962'));
  const br = await w.js(`F1.game.track.bridges && F1.game.track.bridges[0] ? (function (b) { return { up: b.up, lo: b.lo, sep: +b.separation.toFixed(2), clearance: +b.clearance.toFixed(2), deck: [b.deckFrom, b.deckTo] }; })(F1.game.track.bridges[0]) : null`);
  note('bridge: ' + J(br));
  check('Suzuka has a bridge (track.bridges)', !!br, br);
  if (!br) { w.destroy(); return; }
  const N = 2903;
  await w.js(`__q.plug(); __e.ap.mode = 'line'; true`);
  // the lower road (under the deck)
  let st = await w.js(`__q.place(${br.lo - 70}, 160)`);
  await w.js(`__q.drive(${J({ input: 'pad', path: 'line', rec: [br.lo - 30, br.lo + 30], stopU: ((br.lo + 60 - st) % N + N) % N, then: 'line' })})`);
  await w.until_i(br.lo - 30, 20, 3); await w.shot('suzuka-01-lower-approach', true);
  await w.until_i(br.lo - 4, 20, 3); const under = await w.now(); await w.shot('suzuka-02-lower-under-deck', true);
  await w.pump(`__q.d.done`, 30, 'lower road');
  const lo = await w.rec();
  note('lower road: ' + J({ under: { i: under.i, y: under.y }, y: [lo.ymin, lo.ymax], jumps: lo.jumps, maxJump: lo.maxJump, hits: lo.hits, v: [lo.vminK, lo.vmaxK] }));
  check('the lower road under the bridge: no jump to the upper road, no wall contact', lo.jumps === 0 && lo.hits === 0 && Math.abs(under.i - br.lo) < 8, { jumps: lo.jumps, maxJump: lo.maxJump, under: under.i });
  // the upper road (over the deck)
  st = await w.js(`__q.place(${br.up - 80}, 200)`);
  await w.js(`__q.drive(${J({ input: 'pad', path: 'line', rec: [br.up - 30, br.up + 30], stopU: ((br.up + 70 - st) % N + N) % N, then: 'line' })})`);
  await w.until_i(br.up - 40, 20, 3); await w.shot('suzuka-03-upper-approach', true);
  await w.until_i(br.up, 20, 3); const over = await w.now(); await w.shot('suzuka-04-upper-on-deck', true);
  await w.pump(`__q.d.done`, 30, 'upper road');
  const up = await w.rec();
  note('upper road: ' + J({ over: { i: over.i, y: over.y }, y: [up.ymin, up.ymax], jumps: up.jumps, hits: up.hits, v: [up.vminK, up.vmaxK] }));
  check('the upper road over the bridge: no jump to the lower road, no wall contact, the car high above the lower road', up.jumps === 0 && up.hits === 0 && Math.abs(over.i - br.up) < 8 && over.y > under.y + 4, { jumps: up.jumps, over, under: under.y });
  // R on the deck and under it (the reset keeps the road the car is on)
  await w.js(`__q.place(${br.up}, 0); true`); await w.frames(10);
  await w.tap('R'); await w.frames(10);
  const rUp = await w.now();
  await w.js(`__q.place(${br.lo}, 0); true`); await w.frames(10);
  await w.tap('R'); await w.frames(10);
  const rLo = await w.now();
  note('R: ' + J({ up: [rUp.i, rUp.y], lo: [rLo.i, rLo.y] }));
  check('R on the deck stays on the upper road; R under it stays on the lower road', Math.abs(rUp.i - br.up) < 6 && Math.abs(rLo.i - br.lo) < 6 && rUp.y > rLo.y + 4, { rUp, rLo });
  await w.shot('suzuka-05-R-under-deck', true);
  await w.noErrors();
  w.destroy();
}

/* ================= a pit stop on the pad (the compound prompt, X, the box) ================= */
// From 440 m before the pit lane on the racing line: the pit driver of gp-e2e/solo-page.js (E.pitPlan, the fake pad's
// stick and triggers) into box 1; B (limiter) just before the entry line, X (next compound) once in the lane, B off
// after the exit, as a player on the controller would.
async function pitStop(w, tag, wantLimit) {
  const P = await w.js(`(function () { var t = F1.game.track, p = t.pit; return { from: p.from, to: p.to, entry: p.entry, exit: p.exit, limit: p.limitKmh, year: p.year, N: t.samples.length, side: p.side }; })()`);
  note(tag + ': pit lane ' + J(P));
  check(tag + ': the lane limit is ' + wantLimit + ' km/h (track.pit, the season ' + P.year + ')', P.limit === wantLimit, P);
  await w.js(`__q.plug(); __e.ap.mode = 'line'; __e.ap.on = true; true`);
  await w.frames(3);
  await w.js(`__q.place(${(P.from - 220 + P.N) % P.N}, 'line')`);
  const plan = await w.js(`__e.pitPlan({ slot: 0, cruise: true, then: 'line' })`);
  if (!check(tag + ': pit plan made', plan && plan.ok, plan)) return null;
  const t0 = await w.js(`__v.toasts.length`);
  await w.pump(`(function () { var N = g.track.samples.length, k = ((${P.entry} - g.car.state.sampleIndex) % N + N) % N; return k < 30; })()`, 60, 'near the entry line');
  await w.button(1, 3, true);                                     // B: limiter on
  const lim = await w.js(`F1.game.limiter`);
  await w.pump(`g.pit.state.inLane`, 40, 'in the lane');
  await w.frames(20);
  const lane = await w.js(`({ toasts: __v.toastsSince(${t0}), strip: __t.text('hud-pit'), next: F1.game.nextCompound, keys: __v.hud.nextKeys, limit: __t.text('hud-pit-limit'),
    pad: F1.gamepad.state.connected, kmh: F1.game.car.state.speed * 3.6 })`);
  await w.shot(tag + '-01-lane', true);
  await w.button(2, 3, true);                                     // X: the next compound
  await w.frames(10);
  const x = await w.js(`({ next: F1.game.nextCompound, strip: __t.text('hud-pit'), toasts: __v.toastsSince(${t0}), tel: __v.hud.nextCompound, keys: __v.hud.nextKeys })`);
  await w.shot(tag + '-02-X-pressed', true);
  await w.pump(`g.pit.state.service`, 60, 'the service');
  await w.frames(30);
  await w.shot(tag + '-03-service', true);
  await w.pump(`!g.pit.state.service`, 60, 'the service done');
  const fitted = await w.js(`F1.game.car.tyres.state.compound`);
  await w.pump(`__e.ap.mode === 'line'`, 60, 'out of the lane');
  const pi = await w.js(`__e.pitInfo()`);
  const limOn = await w.js(`F1.game.limiter`);
  if (limOn) await w.button(1, 3, true);                         // B: limiter off on the track again
  await w.frames(60);
  const fin = await w.js(`({ toasts: __v.toastsSince(${t0}), limiter: F1.game.limiter, kmh: F1.game.car.state.speed * 3.6 })`);
  note(tag + ': ' + J({ limiterAtEntry: lim, lane, x, fitted, rec: { maxLaneKmh: r1(pi.rec.maxLaneKmh), cruise: r1(pi.rec.cruiseKmh), svc: pi.rec.svcTotal, speeding: pi.rec.speedingFrames, hits: pi.rec.hits, grass: pi.rec.grass }, fin }));
  const enterToast = lane.toasts.find(t => /選擇輪胎/.test(t)) || '';
  check(tag + ': B before the entry line: limiter on; in the lane at the limit (never above it), no speeding, no wall',
    lim === true && pi.rec.maxLaneKmh <= wantLimit + 0.5 && pi.rec.cruiseKmh > wantLimit - 4 && pi.rec.speedingFrames === 0 && pi.rec.hits === 0, { lim, rec: pi.rec });
  check(tag + ': entering the lane with the pad: the toast names X first (按 X（鍵盤 T）選擇輪胎：軟 / 中 / 硬（下一組：…）)', /^按 X（鍵盤 T）選擇輪胎：軟 \/ 中 \/ 硬（下一組：.+胎）$/.test(enterToast), lane.toasts);
  check(tag + ': the pit strip shows the limit and 下一組：…（X / T 切換）', lane.limit === '維修區 限速' + wantLimit && /下一組：.+胎（X \/ T 切換）/.test(lane.strip), lane);
  check(tag + ': X in the lane changes the next set (strip, telemetry, toast), the box fits it', x.next !== lane.next && x.tel === x.next && /下一組輪胎：/.test(x.toasts.join('|')) &&
    x.strip.indexOf('下一組：' + ({ S: '軟胎', M: '中性胎', H: '硬胎' })[x.next]) >= 0 && fitted === x.next && x.keys === 'X / T', { before: lane.next, x, fitted });
  check(tag + ': a service in box 1 (2..4.5 s + nothing else), out again, B switched the limiter off', pi.rec.svcTotal > 1.9 && pi.rec.svcTotal < 4.6 && pi.rec.svcDoneClock !== null && fin.limiter === false,
    { svc: pi.rec.svcTotal, fin });
  return { P, lane, x, fitted, rec: pi.rec };
}

/* ================= Silverstone: the new line, grid and pits ================= */
async function partSilver() {
  state.part = 'silver';
  const w = makeWin('silver');
  await w.open({ fresh: true, warp: true });
  check('Silverstone picked', await w.pickTrackWarp('gb-1948'));
  const info = await w.js(`(function () { var t = F1.game.track, P = t.pit, d = F1.game.trackData, S = t.samples, s0 = S[0], c = F1.game.car.state, geo = d.geo;
    var lat = geo ? geo.lat0 + s0.z / geo.kz : null, lon = geo ? geo.lon0 + s0.x / geo.kx : null;
    return { N: S.length, start: c.sampleIndex, line: lat !== null ? [+lat.toFixed(6), +lon.toFixed(6)] : null, pit: { from: P.from, to: P.to, entry: P.entry, exit: P.exit, side: P.side, limit: P.limitKmh, box0: P.boxes[0].index },
      grid0: t.grid[0].index }; })()`);
  note('Silverstone: ' + J(info));
  check('Silverstone: the line between the pit entry and exit (the pits beside the start straight), 16 grid boxes behind it', info.pit.entry > info.N / 2 && info.pit.exit < info.N / 2 && info.grid0 > info.N - 30, info);
  await w.frames(30);
  await w.shot('silver-01-start', true);
  // the pit stop on the pad
  await pitStop(w, 'silver-pit', 80);
  // the Grand Prix: the starting compound (soft) chosen in the 大獎賽 tab, qualifying skipped, the grid
  await w.tap('Escape'); await w.until(`!F1.game.running`, 3000, 'menu');
  await w.click('#tab-gp');
  await w.click('#gp-tyre button[data-c="S"]');
  const panel = await w.js(`({ tyre: [].map.call(document.querySelectorAll('#gp-tyre button'), function (b) { return b.getAttribute('data-c') + (b.classList.contains('on') ? '*' : ''); }).join(' '), label: __t.text('gp-tyre-label'), next: F1.game.nextCompound })`);
  check('大獎賽 tab: 起跑輪胎 軟 picked with the mouse (main.js next set S)', /S\*/.test(panel.tyre) && panel.next === 'S' && panel.label === '起跑輪胎', panel);
  // (v7.2: the Grand Prix starts from the start panel: the loaded track's card, 大獎賽, Q / R, 重新開始)
  await w.card('gb-1948'); await w.mode('gp');
  await w.field('gp-q', '1'); await w.field('gp-r', '1');
  await w.shot('silver-02-gp-panel');
  const sp = await w.js(`[].map.call(document.querySelectorAll('#setup-tyre button'), function (b) { return b.getAttribute('data-c') + (b.classList.contains('on') ? '*' : ''); }).join(' ')`);
  check('the start panel shows the same 起跑輪胎 (軟)', /S\*/.test(sp), sp);
  check('開始 (大獎賽) clicked', await w.go());
  await w.until(`F1.gp.phase === 'quali'`, 5000, 'qualifying');
  await w.js(`__v.hookRenderer() && __e.hookCar()`);
  await w.frames(5);
  await w.tap('Escape'); await w.until(`!F1.game.running`, 3000, 'menu');
  await w.click('#tab-gp');
  const lbl = await w.js(`__t.text('gp-tyre-label')`);
  check('in a session the row reads 下一組輪胎', lbl === '下一組輪胎', lbl);
  check('跳過排位 clicked', await w.click('#gp-skip'));
  await w.until(`F1.gp.phase === 'grid' && F1.game.running`, 8000, 'grid');
  await w.js(`__v.hookRenderer() && __e.hookCar()`);
  await w.frames(20);
  const grid = await w.js(`({ phase: F1.gp.phase, i: F1.game.car.state.sampleIndex, grid0: F1.game.track.grid[0].index, compound: F1.game.car.tyres.state.compound, locked: F1.gp.inputLocked, d: F1.game.car.state.d })`);
  await w.shot('silver-03-grid', true);
  note('grid: ' + J(grid));
  check('Silverstone grid: the car in grid box 1 (behind the new line), on new softs, held', grid.phase === 'grid' && Math.abs(grid.i - grid.grid0) < 4 && grid.compound === 'S' && grid.locked, grid);
  await w.noErrors();
  w.destroy();
}

/* ================= the Chinese names and the search ================= */
async function partNames() {
  state.part = 'names';
  const w = makeWin('names');
  await w.open({ fresh: true });
  const cards = await w.js(`[].map.call(document.querySelectorAll('#track-grid .card'), function (c) { var e = c.querySelector('.card-en'); return { zh: c.querySelector('.card-name').textContent, en: e ? e.textContent : null }; })`);
  note('cards: ' + cards.slice(0, 6).map(c => c.zh + ' / ' + c.en).join(', ') + ' ...');
  check('40 cards, each with a Chinese name and the English one under it', cards.length === 40 && cards.every(c => /[一-鿿]/.test(c.zh) && c.en), cards.filter(c => !c.en || !/[一-鿿]/.test(c.zh)));
  await w.shot('names-01-menu');
  const tips = await w.js(`[].filter.call(document.querySelectorAll('#track-grid .card'), function (c) { return c.title; }).map(function (c) { return F1_TRACKS[+c.getAttribute('data-i')].id + ': ' + c.title; })`);
  check('the only layout note (Estoril, post-2000 layout) is the card\'s tooltip, in Chinese', tips.length === 1 && /^pt-1972: 2000 年改建後的賽道佈局/.test(tips[0]), tips);
  const ids = await w.js(`F1_TRACKS.map(function (t) { return t.id; })`);
  const by = cc => ids.filter(i => i.split('-')[0] === cc).sort();
  const Q = [
    ['japan', ['jp-1962']], ['日本', ['jp-1962']], ['鈴鹿', ['jp-1962']], ['suzuka', ['jp-1962']], ['铃鹿', ['jp-1962']], ['japanese gp', ['jp-1962']],
    ['monza', ['it-1922']], ['蒙札', ['it-1922']], ['italy', by('it')], ['義大利', by('it')], ['us', by('us')], ['美國', by('us')], ['uk', by('gb')], ['英國', by('gb')],
    ['nurburgring', ['de-1927']], ['nürburgring', ['de-1927']], ['摩納哥', ['mc-1929']], ['singapore', ['sg-2008']], ['新加坡', ['sg-2008']],
    ['las vegas', ['us-2023']], ['拉斯維加斯', ['us-2023']], ['巴西', by('br')],
    ['spa', ['be-1925', 'es-1991', 'es-2026']],      // (1..3 letters match the START of a word: Spa, and Spain / Spanish so far)
    ['spa francorchamps', ['be-1925']], ['斯帕', ['be-1925']]
  ];
  for (const [q, want] of Q) {
    await w.click('#track-search');
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    await sleep(40); await w.tap('Backspace'); await sleep(60);
    if (/^[\x20-\x7e]+$/.test(q)) for (const ch of q) { w.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(15); }
    else w.webContents.insertText(q);
    await sleep(250);
    const got = await w.js(`({ v: document.getElementById('track-search').value, ids: [].filter.call(document.querySelectorAll('#track-grid .card'), function (c) { return !c.classList.contains('hidden'); }).map(function (c) { return F1_TRACKS[+c.getAttribute('data-i')].id; }).sort(),
      names: [].filter.call(document.querySelectorAll('#track-grid .card'), function (c) { return !c.classList.contains('hidden'); }).map(function (c) { return c.querySelector('.card-name').textContent; }), count: __t.text('track-count') || null })`);
    check('search "' + q + '" (typed) finds ' + want.join(', '), got.v === q && J(got.ids) === J(want.slice().sort()), got);
    if (q === 'japan' || q === '鈴鹿' || q === '蒙札' || q === 'us') await w.shot('names-search-' + (q === '鈴鹿' ? 'suzuka-zh' : q === '蒙札' ? 'monza-zh' : q));
  }
  // Enter / a click on the one card found
  await w.click('#track-search');
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  await w.tap('Backspace'); w.webContents.insertText('鈴鹿'); await sleep(200);
  const i = await w.trackIndex('jp-1962');
  check('the card found is clicked: the start panel of 鈴鹿賽道; 開始: Suzuka loads', await w.click(`#track-grid .card[data-i="${i}"]`) &&
    await w.until(`F1.game.setup.show === 'setup' && F1.game.setup.trackId === 'jp-1962' && /鈴鹿/.test(__t.text('setup-track-name'))`, 2000, 'suzuka panel') &&
    await w.mode('free') && await w.go() && await w.until(`F1.game.running && F1.game.trackData.id === 'jp-1962'`, 15000, 'suzuka'));
  await sleep(600);
  const hud = await w.js(`__t.text('hud-timing')`);
  check('HUD timing box title 鈴鹿賽道', /鈴鹿賽道/.test(hud), hud);
  await w.shot('names-02-suzuka-hud');
  await w.noErrors();
  w.destroy();
}

/* ================= 設定 → 視野 ================= */
async function partFov() {
  state.part = 'fov';
  let w = makeWin('fov', { partition: 'v62-fov' });
  await w.open({ fresh: true });
  await w.click('#tab-set');
  const f0 = await w.js(`({ v: document.getElementById('set-fov').value, label: __t.text('set-fov-val'), ui: F1.ui.getFov(), stored: localStorage.getItem('f1drive.fov'), cock: F1.game.cockpit ? F1.game.cockpit.info().fov : null })`);
  check('設定 → 視野: 60° by default, nothing stored', f0.v === '60' && f0.label === '60°' && f0.ui === 60 && f0.stored === null, f0);
  await w.shot('fov-01-settings');
  await w.js(`document.getElementById('set-fov').focus(); true`);
  for (let k = 0; k < 5; k++) await w.tap('Right');
  const f1 = await w.js(`({ v: document.getElementById('set-fov').value, label: __t.text('set-fov-val'), ui: F1.ui.getFov(), stored: localStorage.getItem('f1drive.fov'), cock: F1.game.cockpit ? F1.game.cockpit.info().fov : null })`);
  check('→ ×5 on the slider (real keys): 65°, remembered (the cockpit is made with the first track)', f1.v === '65' && f1.label === '65°' && f1.ui === 65 && f1.stored === '{"fov":65}' && (!f1.cock || f1.cock.setting === 65), f1);
  check('Monza picked', await w.pickTrack('it-1922'));
  await sleep(500);
  const c65 = await w.js(`({ fov: F1.game.camera.fov, info: F1.game.cockpit.info().fov, v: F1.game.car.state.speed })`);
  await w.shot('fov-02-65-standing');
  check('standing at Monza: the camera at 65°', Math.abs(c65.fov - 65) < 0.01, c65);
  for (const [key, want] of [['End', 75], ['Home', 50]]) {
    await w.tap('Escape'); await sleep(300);
    await w.click('#tab-set');
    await w.js(`document.getElementById('set-fov').focus(); true`);
    await w.tap(key); await sleep(200);
    const still = await w.js(`F1.game.camera.fov`);
    await w.shot('fov-03-menu-' + want);
    await w.tap('Escape'); await sleep(500);
    const c = await w.js(`({ fov: F1.game.camera.fov, running: F1.game.running, ui: F1.ui.getFov() })`);
    await w.shot('fov-04-' + want + '-standing');
    check(key + ' on the slider: ' + want + '° (the still behind the menu at once), resumed at ' + want + '°', c.ui === want && c.running && Math.abs(c.fov - want) < 0.01 && Math.abs(still - want) < 0.01, { still, c });
  }
  // driving: the FOV widens with speed (60 -> 70.3 at top speed)
  await w.tap('Escape'); await sleep(300); await w.click('#tab-set'); await w.js(`document.getElementById('set-fov').focus(); true`);
  for (let k = 0; k < 10; k++) await w.tap('Right');
  await w.tap('Escape'); await sleep(400);
  w.key('W', true); await sleep(3000);
  const drv = await w.js(`({ fov: F1.game.camera.fov, kmh: F1.game.car.state.speed * 3.6, ui: F1.ui.getFov() })`);
  w.key('W', false);
  await w.shot('fov-05-60-driving');
  check('back to 60° (→ ×10 from 50), driving: the FOV widens with speed', drv.ui === 60 && drv.fov > 60.3 && drv.fov < 70.4 && drv.kmh > 60, drv);
  await w.noErrors();
  w.destroy();
  // a restart remembers it
  w = makeWin('fov2', { partition: 'v62-fov' });
  await w.open({ fresh: true });
  const r = await w.js(`({ ui: F1.ui.getFov(), stored: localStorage.getItem('f1drive.fov'), label: __t.text('set-fov-val') })`);
  check('after a restart: 60° (stored {"fov":60})', r.ui === 60 && r.stored === '{"fov":60}', r);
  await w.noErrors();
  w.destroy();
}

/* ================= pit stops at Zandvoort and Singapore, by season ================= */
async function partPits() {
  state.part = 'pits';
  for (const [id, name, years] of [['nl-1948', 'zandvoort', [[2024, 60], [2025, 80]]], ['sg-2008', 'singapore', [[2024, 60], [2026, 80]]]]) {
    const w = makeWin('pits-' + name);
    await w.open({ fresh: true, warp: true });
    const y0 = await w.pickYear(years[0][0]);
    check(name + ': year ' + years[0][0] + ' picked in the 車輛 tab', y0 === String(years[0][0]), y0);
    check(name + ' picked', await w.pickTrackWarp(id));
    const spec0 = await w.js(`F1.game.spec.id`);
    await pitStop(w, name + '-' + years[0][0], years[0][1]);
    // another season in free practice (the menu), back on the track: the lane's limit follows
    await w.tap('Escape'); await w.until(`!F1.game.running`, 3000, 'menu');
    const y1 = await w.pickYear(years[1][0]);
    await w.tap('Escape');
    await w.until(`F1.game.running && __e.queued() === 1`, 5000, 'resumed');
    await w.js(`__v.hookRenderer() && __e.hookCar()`);
    await w.frames(5);
    const spec1 = await w.js(`F1.game.spec.id`);
    note(name + ': ' + J({ spec0, y1, spec1 }));
    await pitStop(w, name + '-' + years[1][0], years[1][1]);
    await w.noErrors();
    w.destroy();
  }
}

const PARTS = { hairpin: partHairpin, tunnel: partTunnel, spa: partSpa, bank: partBank, suzuka: partSuzuka, silver: partSilver, names: partNames, fov: partFov, pits: partPits };

app.whenReady().then(async () => {
  const t0 = Date.now();
  L.host.register(ipcMain);
  try {
    for (const k of Object.keys(PARTS)) {
      if (ONLY.length && ONLY.indexOf(k) < 0) continue;
      console.log('=== ' + k);
      try { await PARTS[k](); } catch (e) { check('part ' + k + ' threw', false, String(e && e.stack || e)); }
    }
  } finally {
    const failed = results.filter(r => !r.ok);
    console.log('\n' + (results.length - failed.length) + ' / ' + results.length + ' checks passed in ' + Math.round((Date.now() - t0) / 1000) + ' s');
    for (const f of failed) console.log('FAILED: ' + f.name);
    try { await L.host.stopServer(); } catch (e) {}
    app.exit(failed.length ? 1 : 0);
  }
});
app.on('window-all-closed', () => {});
