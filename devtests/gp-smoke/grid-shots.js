// Screenshots of the starting grid in the REAL game (offscreen Electron, real preload / host IPC / server): are the
// cars in the painted grid boxes?
//   npx electron devtests/gp-smoke/grid-shots.js
//   env TRACKS=monza,monaco,spa,suzuka,rodr (name parts)   SLOTS=0,1,15   PORT=24806
// The window hosts a room, so that main.js puts its car on the room slot: placeStart() -> placeOnGrid(net.slot).
// net.slot is overridden in the page (the harness picks it), everything else is the game's own code. For every track
// and slot: the car is measured against the painted box (computed here from the rule, as in smoke.js) and a cockpit
// screenshot is saved; the 15 other boxes get a parked car model each (placed by the same rule, NOT by main.js), so
// the pictures show a full grid. Then two pictures from above, scenery hidden: the whole grid and the front rows.
// Output: devtests/gp-smoke/out/grid-<track id>-slot<N>.png, -top.png, -front.png. Exit code 1 when a check fails.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'grid-shots');
const host = require(path.join(ROOT, 'net', 'host'));
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.env.PORT || 24806);
const TRACKS = (process.env.TRACKS || 'monza,monaco,spa,suzuka,rodr').toLowerCase().split(',').filter(Boolean);
const SLOTS = (process.env.SLOTS || '0,1,15').split(',').map(Number);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : J(detail)) : ''));
}

const PAGE_LIB = `(function () {
  var COLOURS = ['#e10600', '#1e6bff', '#19c8e6', '#35d07f', '#ffd21e', '#c04bff', '#f2f4f7', '#ff7a14'];
  var NOSE = 2.8, extra = [], hidden = [];
  var g = window.__g = {
    // grid box slot + 1, from the rule: front bar (slot + 1) * 8 m behind the line, centred 3 m left (even slot) / right
    boxOf: function (slot) {
      var tr = F1.game.track, S = tr.samples, n = S.length, k = slot + 1;
      var i = ((n - Math.round(k * 8 / (tr.length / n))) % n + n) % n, s = S[i];
      return { i: i, s: s, lat: k % 2 ? 3 : -3, h: Math.atan2(s.tx, s.tz) };
    },
    // our car measured in the frame of that box (see smoke.js __t.box)
    box: function (slot) {
      var b = g.boxOf(slot), s = b.s, c = F1.game.car.state;
      var nx = c.x + Math.sin(c.heading) * NOSE, nz = c.z + Math.cos(c.heading) * NOSE, turn = c.heading - b.h;
      return { nose: -((nx - s.x) * s.tx + (nz - s.z) * s.tz), off: (nx - s.x) * s.nx + (nz - s.z) * s.nz - b.lat,
        turn: Math.atan2(Math.sin(turn), Math.cos(turn)), d: c.d, v: c.speed, i: c.sampleIndex, n: F1.game.track.samples.length, hit: c.hit };
    },
    scene: function () { var o = F1.game.track.group; while (o.parent) o = o.parent; return o; },
    // a parked car model in every box but ours
    fill: function (own) {
      g.clear();
      var tr = F1.game.track, scene = g.scene();
      for (var slot = 0; slot < 16; slot++) {
        if (slot === own) continue;
        var b = g.boxOf(slot), s = b.s;
        var x = s.x + s.nx * b.lat - s.tx * (0.25 + NOSE), z = s.z + s.nz * b.lat - s.tz * (0.25 + NOSE);
        var loc = tr.locate(x, z, b.i), q = tr.samples[loc.index];
        var m = F1.createCarModel(COLOURS[slot % COLOURS.length], '');
        m.update({ x: x, y: tr.surfaceY(loc.index, loc.d), z: z, heading: b.h, pitch: Math.atan(q.grade || 0), roll: q.bank || 0, speed: 0, steer: 0 }, 0, null);
        scene.add(m.group);
        extra.push(m);
      }
      return extra.length;
    },
    clear: function () { extra.forEach(function (m) { if (m.group.parent) m.group.parent.remove(m.group); m.dispose(); }); extra = []; return true; },
    // Camera above the grid, looking straight down; the racing direction at the line points to the right of the picture.
    // from / to: metres behind the line that must be in the picture. The game loop must not be running (menu open):
    // a 'resize' event makes main.js render one frame.
    above: function (from, to) {
      var tr = F1.game.track, S = tr.samples, n = S.length, ds = tr.length / n, cam = F1.game.camera, scene = g.scene();
      if (!g.rig) g.rig = cam.parent;
      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y = -Infinity;
      for (var m = from; m <= to; m += 2) {
        var s = S[((n - Math.round(m / ds)) % n + n) % n];
        minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z); y = Math.max(y, s.y || 0);
      }
      var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, s0 = S[0];
      // extent of the stretch along / across the direction at the line, + the road on both sides
      var along = 0, across = 0;
      for (m = from; m <= to; m += 2) {
        s = S[((n - Math.round(m / ds)) % n + n) % n];
        along = Math.max(along, Math.abs((s.x - cx) * s0.tx + (s.z - cz) * s0.tz));
        across = Math.max(across, Math.abs((s.x - cx) * s0.nx + (s.z - cz) * s0.nz));
      }
      along += 12; across += 12;
      scene.children.forEach(function (o) {
        if (o === tr.group || o === g.rig || o.isLight || o.name === 'remote-car') return;
        if (o.visible) { o.visible = false; hidden.push(o); }
      });
      scene.add(cam);
      cam.fov = 30; cam.aspect = innerWidth / innerHeight;
      var t = Math.tan(cam.fov * Math.PI / 360), hgt = Math.max(along / (t * cam.aspect), across / t);
      cam.position.set(cx, y + hgt, cz);
      cam.up.set(s0.nx, 0, s0.nz);             // driver's left at the line = top of the picture
      cam.lookAt(cx, y, cz);
      cam.updateProjectionMatrix();
      window.dispatchEvent(new Event('resize'));
      return { height: hgt, pxPerMetre: innerHeight / (2 * hgt * t) };
    },
    // back into the cockpit
    restore: function () {
      hidden.forEach(function (o) { o.visible = true; }); hidden = [];
      var cam = F1.game.camera;
      if (g.rig) g.rig.add(cam);
      cam.up.set(0, 1, 0);
      return true;
    }
  };
  // main.js reads net.slot when it places the car: the harness decides which slot that is
  window.__slot = 0;
  Object.defineProperty(F1.net, 'slot', { configurable: true, get: function () { return window.__slot; }, set: function () {} });
  return true;
})()`;

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  host.register(ipcMain);
  const w = new BrowserWindow({ width: 1600, height: 900, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  const errors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    errors.push(msg);
    console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  host.attach(w);
  const js = code => w.webContents.executeJavaScript(code);
  const shot = async n => { await sleep(250); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  const until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await js('!!(' + code + ')')) return true; await sleep(40); }
    console.log('TIMEOUT: ' + (what || code));
    return false;
  };
  const tap = async k => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(60); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(150); };
  try {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(900);
    await js(PAGE_LIB);
    await js(`(function () { var e = document.getElementById('mp-port'); e.value = ${J(String(PORT))}; e.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('mp-create').click(); return true; })()`);
    check('room created (the car is then placed by placeOnGrid(net.slot))', await until(`F1.net.connected && F1.net.isHost`, 5000), await js(`document.getElementById('mp-status').textContent`));

    for (const part of TRACKS) {
      const td = await js(`(function () { var t = F1_TRACKS.filter(function (t) { return (t.name + ' ' + t.id).toLowerCase().indexOf(${J(part)}) >= 0; })[0]; return t ? { id: t.id, name: t.name } : null; })()`);
      if (!td) { check('track "' + part + '" exists', false); continue; }
      for (const slot of SLOTS) {
        // the host picks the track (again): everybody in the room, we too, loads it and is put on its slot
        await js(`window.__slot = ${slot}; window.__old = F1.game.track; F1.net.selectTrack(${J(td.id)}); true`);
        const ok = await until(`F1.game.running && F1.game.track && F1.game.track !== window.__old && F1.game.trackData.id === ${J(td.id)}`, 20000, td.id + ' loads');
        await sleep(500);
        const b = await js(`__g.box(${slot})`);
        check(td.id + ' slot ' + slot + ': main.js put the car in grid box ' + (slot + 1) + ' (nose at the rear edge of the front bar, on the centreline, along the box)',
          ok && near(b.nose, 0.25, 0.02) && near(b.off, 0, 0.02) && near(b.turn, 0, 1e-6) && b.v === 0 && b.hit === 0 && (b.d > 0) === (slot % 2 === 0),
          { nose: +b.nose.toFixed(3), off: +b.off.toFixed(3), turn: +b.turn.toFixed(6), d: +b.d.toFixed(2), sample: 'N-' + (b.n - b.i) });
        await js(`__g.fill(${slot}); F1.ui.toast(''); true`);
        await shot('grid-' + td.id + '-slot' + slot);
      }
      // from above, with our car on the last slot shot and models in the 15 other boxes
      await tap('Escape');
      check(td.id + ': menu open (loop stopped) for the pictures from above', await js(`!F1.game.running`));
      await js(`document.getElementById('menu').classList.add('hidden'); true`);
      const top = await js(`__g.above(-6, 140)`);
      await shot('grid-' + td.id + '-top');
      const front = await js(`__g.above(-4, 42)`);
      await shot('grid-' + td.id + '-front');
      console.log(td.id + ' ' + td.name + ': from above at ' + top.pxPerMetre.toFixed(1) + ' px / m (whole grid), ' + front.pxPerMetre.toFixed(1) + ' px / m (front rows)');
      await js(`__g.restore(); __g.clear(); document.getElementById('menu').classList.remove('hidden'); true`);
      await tap('Escape');
      check(td.id + ': back in the cockpit', await until(`F1.game.running`, 3000));
    }
    const overlay = await js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
    check('no error overlay, no console errors', !overlay && errors.length === 0, overlay || errors.slice(0, 3));
  } catch (e) {
    check('harness ran to the end', false, e && e.stack ? e.stack : String(e));
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '  FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  await host.stopServer();
  app.exit(bad.length ? 1 : 0);
});
