// npx electron devtests/handling-test/bank-shots.js     (MUTED: devtests/electron-userdata.js; never set SOUND=1)
// Screenshots of the real game (index.html of APP_ROOT, default the project) at the real banked corners: the car is
// put on the racing line before the corner, an analog autopilot in the page (pursuit of the racing line, pedals from
// its colour; it only fills the input object main.js hands to car.update) drives it through, and at each shot's sample
// the physics is frozen (car.update skipped) while the cockpit view is captured; then the camera is lifted out of the
// cockpit to a trackside point for an outside view of the same moment. Writes devtests/handling-test/out/shots/*.png
// and out/shots/shots.json (pose, speed, roll, the camera's tilt per shot).
//   APP_ROOT   the game to load (e.g. a `git archive HEAD` copy: another workflow edits js/main.js meanwhile)
//   SHOTS      'name:trackId:startSample:shotSample[:ext dx,dy,dz][:variant]' joined by ';' (default: the list below)
//   HEADROLL   prototype of a visual cue: the head counter-rolls k x the car's roll (0 = today's camera)
//   EYEDROP    prototype: the eye drops this many m per g of normal load above 1 g (max 5 cm)
//   TAG        suffix of the file names (default '')
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'bank-shots');
const APP = path.resolve(process.env.APP_ROOT || ROOT);
const OUT = path.join(__dirname, 'out', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const DEF = [
  // name, track, start sample, shot sample, outside camera offset (m: along the track normal of the shot sample, up,
  // along the tangent) - the normal side is chosen towards the outside of the corner when dx > 0
  'nl-t3-entry:nl-1948:380:430:30,8,-25',
  'nl-t3-apex:nl-1948:380:455:34,9,0',
  'nl-t3-exit:nl-1948:380:485:30,8,20',
  'nl-t14-mid:nl-1948:1800:1920:40,10,0',
  'es-t12-mid:es-2026:1080:1230:45,12,0',
  'es-t12-late:es-2026:1080:1330:45,12,0',
  'sa-t13-mid:sa-2021:1100:1200:35,10,0',
  'nl-t1:nl-1948:150:249:30,8,0',              // Tarzan: an ordinary corner (derived banking 4.8 deg)
  'mc-hairpin:mc-1929:600:634:25,8,0'          // Monaco's Fairmont hairpin
].join(';');
const SHOTS = (process.env.SHOTS || DEF).split(';').filter(Boolean).map(s => {
  const [name, id, a, b, ext] = s.split(':');
  return { name, id, start: +a, at: +b, ext: ext ? ext.split(',').map(Number) : [30, 8, 0] };
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PAGE = `(function () {
  if (window.__bs) return true;
  var F1 = window.F1, B = window.__bs = { frozen: false, ext: null, ap: true, target: -1, headRoll: HEADROLL, eyeDrop: EYEDROP };
  function hook() {
    var g = F1.game, car = g.car, ck = g.cockpit;
    if (!car || car.__bsHooked) return;
    car.__bsHooked = true;
    var up = car.update;
    car.update = function (dt, input, track) {
      if (B.frozen) return;                      // pose held for the screenshot
      if (B.ap && input) {
        var rl = g.raceLine, st = car.state;
        if (rl && track) {
          var S = track.samples, N = S.length, ds = track.length / N, P = rl.points, v = Math.max(0, st.speed);
          var lv = rl.levels ? rl.levels[2] : 0;
          var Ld = Math.min(35, Math.max(7, 5 + 0.3 * v)), tp = P[(st.sampleIndex + Math.round(Ld / ds)) % N];
          var dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
          var kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz), sg = kap >= 0 ? 1 : -1;
          var K = car.perf, lock = typeof K.steerLockAt === 'function' ? K.steerLockAt(v, S[st.sampleIndex].bank || 0, sg) : 0.35 / (1 + (v / 22) * (v / 22));
          input.steerAxis = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock)) || 1e-6;
          input.left = input.right = false;
          input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5; input.throttle = null; input.brake = null;
        }
      }
      var r = up.call(this, dt, input, track);
      if (B.target >= 0 && track) {
        var NN = track.samples.length, dd = (car.state.sampleIndex - B.target + NN) % NN;
        if (dd < 30) { B.frozen = true; B.target = -1; }
      }
      return r;
    };
    var cu = ck.update;
    ck.update = function (state, dt) {
      if (B.ext) return;                         // camera parked outside
      var r = cu.call(this, state, dt);
      // prototype (HEADROLL = k): the driver's head keeps the horizon k x more level than the chassis (camera roll
      // about its own view axis; the camera looks along the car's +z through a PI yaw, so +k x roll counters the car)
      if (B.headRoll) g.camera.rotation.z += B.headRoll * (state.roll || 0);
      if (B.eyeDrop && car.perf && car.perf.normalAccel) {     // prototype (EYEDROP = m per g of load above 1 g)
        var an = car.perf.normalAccel(state.speed, state.roll, state.pitch, 0, 0) / 9.81;
        g.camera.position.y -= Math.min(0.05, Math.max(0, an - 1) * B.eyeDrop);
      }
      return r;
    };
  }
  B.place = function (i, at) {
    hook();
    var g = F1.game, car = g.car, tr = g.track, rl = g.raceLine, st = car.state, S = tr.samples, p = rl.points[i];
    car.reset(tr, i);
    var s = S[i];
    st.x = p.x; st.z = p.z; st.heading = Math.atan2(s.tx, s.tz); st.speed = p.speed; st.steer = 0;
    car.update(1e-4, { steerAxis: 1e-6 }, tr);
    B.frozen = false; B.target = at;
    return { i: st.sampleIndex, v: st.speed * 3.6 };
  };
  B.state = function () {
    var g = F1.game, st = g.car.state, tr = g.track, s = tr.samples[st.sampleIndex], cam = g.camera;
    cam.updateMatrixWorld(true);
    var e = cam.matrixWorld.elements;                  // camera's up axis (column 1) against the world up
    var upTilt = Math.atan2(Math.hypot(e[4] - 0, e[6] - 0), e[5]) * 180 / Math.PI;
    return { i: st.sampleIndex, d: +st.d.toFixed(2), kmh: +(st.speed * 3.6).toFixed(1), rollDeg: +(st.roll * 180 / Math.PI).toFixed(2),
      bankDeg: +((s.bank || 0) * 180 / Math.PI).toFixed(2), pitchDeg: +(st.pitch * 180 / Math.PI).toFixed(2), steer: +st.steer.toFixed(3),
      camUpTiltDeg: +upTilt.toFixed(2), halfW: s.halfW };
  };
  B.extView = function (dx, dy, dz) {
    var g = F1.game, cam = g.camera, st = g.car.state, tr = g.track, S = tr.samples, s = S[st.sampleIndex], T = window.THREE;
    var N = S.length, a = S[(st.sampleIndex - 3 + N) % N], b = S[(st.sampleIndex + 3) % N];
    var turn = (b.tx - a.tx) * s.nx + (b.tz - a.tz) * s.nz;      // > 0: turning towards +n (the inside is +n)
    var side = turn > 0 ? -1 : 1;                                 // outside of the corner
    B.ext = { parent: cam.parent };
    cam.parent.remove(cam);
    var sc = g.cockpit.group.parent; sc.add(cam);
    var x = st.x + s.nx * side * dx + s.tx * dz, z = st.z + s.nz * side * dx + s.tz * dz;
    var y = (tr.surfaceY ? tr.surfaceY(st.sampleIndex, side * dx) : st.y) + dy;
    if (!isFinite(y)) y = st.y + dy;
    cam.position.set(x, y, z); cam.rotation.set(0, 0, 0); cam.up.set(0, 1, 0);
    cam.lookAt(st.x, st.y + 0.5, st.z);
    cam.fov = 55; cam.updateProjectionMatrix();
    return true;
  };
  B.cockpitView = function () {
    if (!B.ext) return true;
    var g = F1.game, cam = g.camera;
    cam.parent.remove(cam); B.ext.parent.add(cam);
    cam.rotation.order = 'YXZ';
    B.ext = null;
    return true;
  };
  return true;
})()`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  w.webContents.setAudioMuted(true);
  w.webContents.setFrameRate(30);
  const errs = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => { if (level >= 2 && !/Security Warning/.test(msg)) { errs.push(msg); console.log('[console]', msg, (src || '').split('/').pop() + ':' + line); } });
  const js = c => w.webContents.executeJavaScript(c);
  const shot = async n => { await sleep(350); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); console.log('shot', n); };
  const results = [];
  try {
    await w.loadFile(path.join(APP, 'index.html'));
    await sleep(1500);
    let cur = null;
    for (const sh of SHOTS) {
      if (cur !== sh.id) {
        if (cur) { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await sleep(80); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await sleep(800); }
        const clicked = await js(`(function(){ var c=[].slice.call(document.querySelectorAll('.card')); var td=(window.F1_TRACKS||[]).findIndex(function(t){return t.id===${JSON.stringify(sh.id)};});
          var tdName = td>=0 ? window.F1_TRACKS[td].name.toLowerCase() : ''; var n=c.filter(function(x){return x.textContent.toLowerCase().indexOf(tdName)>=0;})[0];
          if(!n) return 'no card for ' + tdName; n.click(); return n.textContent.slice(0,40); })()`);
        console.log('track', sh.id, '->', clicked);
        for (let k = 0; k < 100; k++) { if (await js('!!(window.F1 && F1.game && F1.game.running && F1.game.car && F1.game.raceLine && F1.game.track && F1.game.track.samples)')) break; await sleep(100); }
        await sleep(1200);
        await js(PAGE.replace('HEADROLL', String(+(process.env.HEADROLL || 0))).replace('EYEDROP', String(+(process.env.EYEDROP || 0))));
        cur = sh.id;
      }
      await js('__bs.cockpitView(); __bs.frozen = false; true');
      const pl = await js(`__bs.place(${sh.start}, ${sh.at})`);
      const end = Date.now() + 25000;
      let ok = false;
      while (Date.now() < end) { if (await js('__bs.frozen')) { ok = true; break; } await sleep(30); }
      await js('__bs.frozen = true; true');
      const st = await js('__bs.state()');
      await shot(sh.name + (process.env.TAG || '') + '-cockpit');
      await js(`__bs.extView(${sh.ext.join(',')})`);
      if (!process.env.NOEXT) await shot(sh.name + (process.env.TAG || '') + '-outside');
      await js('__bs.cockpitView(); true');
      results.push(Object.assign({ name: sh.name, track: sh.id, reached: ok, placedKmh: pl.v }, st));
      console.log(sh.name, JSON.stringify(st));
    }
  } catch (e) { console.log('ERR', e && e.stack || e); }
  fs.writeFileSync(path.join(OUT, 'shots' + (process.env.TAG || '') + '.json'), JSON.stringify({ app: APP, results, errors: errs }, null, 1));
  app.exit(0);
});
