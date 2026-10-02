// npx electron devtests/pit-test/shots.js
//   env TRACKS=it-1922,mc-1929,jp-1962,be-1925,sg-2008 (ids)   VIEWS=far,approach,entry,lane,box,exit,across,top,topbare
//       W=1280 H=720
//
// The pit lane of js/track.js in the REAL game (index.html, offscreen, main.js as it is: it does not call track.update,
// so the light curtains do not pulse here). For each track the car is put at points computed from track.pit (the page's
// F1.game peek; the game loop runs and renders the cockpit view) and a picture is saved:
//   far       on the track, 220 m before the entry line, looking ahead (the lane peels off, the amber curtain far away)
//   approach  on the lane centre 50 m before the entry line (the amber curtain ahead)
//   entry     14 m before the entry line, looking a little towards the garages (the line, the speed-limit sign)
//   lane      on the lane centre next to box 10, turned 25 deg towards the boxes (numbers, stop bars, garage doors)
//   box       standing in box 3, looking ahead down the lane
//   exit      on the lane centre 40 m before the exit line (the green curtain, the end-of-limit sign)
//   across    on the far edge of the track abeam the exit line, looking across the track at the green curtain
//   top       from above, the whole pit complex, scenery shown (nothing of it may stand in the lane)
//   topbare   the same with the scenery hidden
// Output: devtests/pit-test/out/<track id>-<view>.png. Prints the pit summary and any console error. Exit code 1 on an
// error overlay / console error or a track that has no pit lane.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'pit-shots');
const OUT = path.join(__dirname, 'out');
const TRACKS = (process.env.TRACKS || 'it-1922,mc-1929,jp-1962,be-1925,sg-2008').split(',').filter(Boolean);
const VIEWS = (process.env.VIEWS || 'far,approach,entry,lane,box,exit,across,top,topbare').split(',').filter(Boolean);
const W = +(process.env.W || 1280), H = +(process.env.H || 720);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);

const PAGE_LIB = `(function () {
  var hidden = [];
  var p = window.__p = {
    tr: function () { return F1.game.track; },
    wq: function (q) { var n = p.tr().samples.length; return ((q % n) + n) % n; },
    k: function (i) { return p.wq(i - p.tr().pit.from); },
    // a point on the lane path, k samples from pit.from, lateral offset dOff from the lane centre (towards the garages
    // for dOff > 0), heading along the path
    lane: function (k, dOff, turn) {
      var tr = p.tr(), S = tr.samples, pit = tr.pit, i = p.wq(pit.from + k), s = S[i];
      var d = pit.laneD(i) + pit.side * (dOff || 0);
      var a = S[p.wq(i - 1)], b = S[p.wq(i + 1)], da = pit.laneD(p.wq(i - 1)), db = pit.laneD(p.wq(i + 1));
      if (!isFinite(da)) da = d; if (!isFinite(db)) db = d;
      var hx = (b.x + b.nx * db) - (a.x + a.nx * da), hz = (b.z + b.nz * db) - (a.z + a.nz * da);
      return { x: s.x + s.nx * d, z: s.z + s.nz * d, heading: Math.atan2(hx, hz) + (turn || 0) * pit.side };
    },
    // the car standing there (as main.js's placeOnGrid does it)
    place: function (q) {
      var car = F1.game.car, tr = p.tr();
      car.reset(tr, tr.locate(q.x, q.z, -1).index);
      car.state.x = q.x; car.state.z = q.z; car.state.heading = q.heading;
      car.update(1e-4, null, tr);
      car.state.speed = 0;
      return { i: car.state.sampleIndex, d: +car.state.d.toFixed(2), k: p.k(car.state.sampleIndex), hit: car.state.hit };
    },
    info: function () {
      var tr = p.tr(), pit = tr.pit, n = tr.samples.length, ds = tr.length / n;
      if (!pit) return null;
      var rel = function (i) { return Math.round((i > n / 2 ? i - n : i) * ds); };
      return { side: pit.side, limit: pit.limitKmh, from: rel(pit.from), entry: rel(pit.entry), exit: rel(pit.exit), to: rel(pit.to),
        K: p.k(pit.to), kEn: p.k(pit.entry), kEx: p.k(pit.exit), meshes: tr.group.children.map(function (m) { return m.name; }).join(',') };
    },
    scene: function () { var o = p.tr().group; while (o.parent) o = o.parent; return o; },
    // camera straight down over lane samples k0..k1 (the game loop must be stopped: menu open)
    above: function (k0, k1, bare) {
      var tr = p.tr(), S = tr.samples, pit = tr.pit, cam = F1.game.camera, scene = p.scene();
      if (!p.rig) p.rig = cam.parent;
      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, y = -Infinity;
      for (var k = k0; k <= k1; k++) {
        var i = p.wq(pit.from + k), s = S[i];
        [-s.wallNegDist, s.wallPosDist].forEach(function (d) {
          var x = s.x + s.nx * d, z = s.z + s.nz * d;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        });
        y = Math.max(y, s.y || 0);
      }
      scene.children.forEach(function (o) {
        if (o === tr.group || o === p.rig || o.isLight) return;
        if (bare || o.name === 'cockpit' || o === p.rig) { if (o.visible) { o.visible = false; hidden.push(o); } }
      });
      p.rig.visible = false; hidden.push(p.rig);
      scene.add(cam);
      var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      // the lane's overall direction to the right of the picture
      var a = S[p.wq(pit.from + k0)], b = S[p.wq(pit.from + k1)], ang = Math.atan2(b.z - a.z, b.x - a.x);
      var ux = Math.cos(ang), uz = Math.sin(ang), along = 0, across = 0;
      for (k = k0; k <= k1; k++) {
        s = S[p.wq(pit.from + k)];
        [-s.wallNegDist, s.wallPosDist].forEach(function (d) {
          var x = s.x + s.nx * d - cx, z = s.z + s.nz * d - cz;
          along = Math.max(along, Math.abs(x * ux + z * uz)); across = Math.max(across, Math.abs(-x * uz + z * ux));
        });
      }
      along += 8; across += 8;
      cam.fov = 40; cam.aspect = innerWidth / innerHeight;
      var t = Math.tan(cam.fov * Math.PI / 360), hgt = Math.max(along / (t * cam.aspect), across / t);
      cam.position.set(cx, y + hgt, cz);
      cam.up.set(-uz, 0, ux);
      cam.lookAt(cx, y, cz);
      cam.far = Math.max(cam.far, hgt * 2);
      cam.updateProjectionMatrix();
      window.dispatchEvent(new Event('resize'));
      return { height: Math.round(hgt), pxPerMetre: +(innerHeight / (2 * hgt * t)).toFixed(2) };
    },
    restore: function () {
      hidden.forEach(function (o) { o.visible = true; }); hidden = [];
      var cam = F1.game.camera;
      if (p.rig) p.rig.add(cam);
      cam.up.set(0, 1, 0); cam.position.set(0, 0, 0); cam.rotation.set(0, 0, 0);
      return true;
    }
  };
  return true;
})()`;

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false } });
  w.webContents.setFrameRate(30);
  const errors = [];
  let bad = 0;
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    errors.push(msg); console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  const js = code => w.webContents.executeJavaScript(code);
  const shot = async n => { await sleep(350); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  const until = async (code, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js('!!(' + code + ')')) return true; await sleep(50); } return false; };
  const key = async k => { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(50); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(200); };
  try {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(800);
    await js(PAGE_LIB);
    for (const id of TRACKS) {
      const clicked = await js(`(function () {
        var i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; });
        var c = document.querySelector('.card[data-i="' + i + '"]');
        if (!c) { var cs = [].slice.call(document.querySelectorAll('.card')); c = cs.filter(function (n) { return n.textContent.indexOf(F1_TRACKS[i].name) >= 0; })[0]; }
        if (!c) return false; c.click(); var __g=document.getElementById('setup-go'); if(__g) __g.click(); return true; })()`);
      const ok = clicked && await until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)}`, 20000);
      if (!ok) { console.log('FAIL ' + id + ': the track did not load'); bad++; await key('Escape'); continue; }
      await js(`F1.ui.toast && F1.ui.toast(''); true`);
      const info = await js(`__p.info()`);
      console.log(id + ' pit: ' + J(info));
      if (!info) { bad++; continue; }
      const K = info.K, kEn = info.kEn, kEx = info.kEx;
      const box = n => `(function () { var b = F1.game.track.pit.boxes[${n - 1}]; return { x: b.x, z: b.z, heading: b.heading }; })()`;
      const views = {
        far: `__p.lane(Math.max(0, ${kEn} - 110), 0)`,       // (before `from` the lane centre is on the road)
        approach: `__p.lane(${kEn} - 25, 0)`,
        entry: `__p.lane(${kEn} - 7, 0, 0.12)`,
        lane: `(function () { var b = F1.game.track.pit.boxes[9], q = __p.lane(__p.k(b.index) - 6, 0, 0.45); return q; })()`,
        box: box(3),
        exit: `__p.lane(${kEx} - 20, 0)`,
        across: `(function () { var tr = F1.game.track, pit = tr.pit, i = pit.exit, s = tr.samples[i], d = -pit.side * (s.halfW - 1);
                 return { x: s.x + s.nx * d, z: s.z + s.nz * d, heading: Math.atan2(s.nx * pit.side, s.nz * pit.side) - pit.side * 0.35 }; })()`
      };
      if (info.kEn - 110 < 0) {   // the lane starts less than 220 m before the entry line: from the track further back
        views.far = `(function () { var tr = F1.game.track, pit = tr.pit, s = tr.samples[__p.wq(pit.entry - 110)]; return { x: s.x, z: s.z, heading: Math.atan2(s.tx, s.tz) }; })()`;
      }
      for (const v of VIEWS) {
        if (views[v]) {
          const r = await js(`__p.place(${views[v]})`);
          await sleep(300);
          await shot(id + '-' + v);
          console.log('  ' + v + ': sample ' + r.i + ' (lane k ' + r.k + '), d ' + r.d + (r.hit ? ', HIT ' + r.hit : ''));
        }
      }
      if (VIEWS.includes('top') || VIEWS.includes('topbare')) {
        await key('Escape');
        await until(`!F1.game.running`, 3000);
        await js(`document.getElementById('menu').classList.add('hidden'); document.getElementById('hud-toast').classList.add('hidden'); true`);
        for (const v of ['top', 'topbare']) {
          if (!VIEWS.includes(v)) continue;
          const a = await js(`__p.above(-10, ${K} + 10, ${v === 'topbare'})`);
          await shot(id + '-' + v);
          console.log('  ' + v + ': ' + J(a));
          await js(`__p.restore()`);
        }
        await js(`document.getElementById('menu').classList.remove('hidden'); true`);
      } else {
        await key('Escape');
        await until(`!F1.game.running`, 3000);
      }
    }
    const overlay = await js(`(function () { var e = document.getElementById('error'); return e && !e.classList.contains('hidden') ? document.getElementById('error-text').textContent : ''; })()`);
    if (overlay) { console.log('ERROR OVERLAY: ' + overlay); bad++; }
  } catch (e) {
    console.log('harness error: ' + (e && e.stack || e)); bad++;
  }
  if (errors.length) bad++;
  console.log(bad ? 'problems: ' + bad : 'pictures written to ' + OUT);
  app.exit(bad ? 1 : 0);
});
