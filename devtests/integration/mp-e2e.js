// End-to-end multiplayer test: two offscreen windows of the real game, real preload, real host IPC + server.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'mp-e2e');
const host = require(ROOT + '/net/host');
const OUT = path.join(__dirname, 'mp');
const PORT = Number(process.env.PORT || 24731);
const DEAD_PORT = Number(process.env.DEAD_PORT || 24999);   // a port nobody listens on (failed-join check)
const TRACK = (process.env.TRACK || 'monza').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}

function makeWin(tag, withPreload) {
  const w = new BrowserWindow({
    width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'mp-' + tag,
      preload: withPreload ? ROOT + '/preload.js' : undefined, backgroundThrottling: false
    }
  });
  w.webContents.setFrameRate(60);
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level >= 2) console.log('[' + tag + ' console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  if (withPreload) host.attach(w);
  w.tag = tag;
  w.js = code => w.webContents.executeJavaScript(code);
  w.shot = async n => fs.writeFileSync(OUT + '-' + tag + '-' + n + '.png', (await w.webContents.capturePage()).toPNG());
  w.key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: k });
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js(code)) return true; await sleep(50); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  return w;
}
const setField = (id, v) => `(function(){var e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(v)};
  e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return e.value;})()`;
const CAR = `(function(){var s=F1.game.car.state; return {x:s.x,y:s.y||0,z:s.z,h:s.heading,v:s.speed,i:s.sampleIndex,d:s.d,hit:s.hit};})()`;
// the car measured in the frame of grid box slot + 1 (js/track.js paints it: front bar (slot + 1) * 8 m behind the line, 3 m
// left / right): nose = metres from the front of the bar back to the car's nose, off = metres off the box centreline
const BOX = slot => `(function(slot){var tr=F1.game.track,S=tr.samples,n=S.length,k=slot+1,c=F1.game.car.state;
  var s=S[((n-Math.round(k*8/(tr.length/n)))%n+n)%n], lat=k%2?3:-3, nx=c.x+Math.sin(c.heading)*2.8, nz=c.z+Math.cos(c.heading)*2.8, t=c.heading-Math.atan2(s.tx,s.tz);
  return {nose:-((nx-s.x)*s.tx+(nz-s.z)*s.tz), off:(nx-s.x)*s.nx+(nz-s.z)*s.nz-lat, turn:Math.atan2(Math.sin(t),Math.cos(t))};})(${slot})`;
const REMOTE = `(function(){var p=F1.net.players[0]; if(!p) return null; var s=p.state; return {name:p.name,colour:p.colour,active:p.active,x:s.x,y:s.y,z:s.z,h:s.heading,v:s.speed};})()`;

app.whenReady().then(async () => {
  let A, B, C;
  try {
    host.register(ipcMain);
    A = makeWin('A', true); B = makeWin('B', true);
    await A.loadFile(ROOT + '/index.html'); await B.loadFile(ROOT + '/index.html');
    await sleep(800);
    check('no startup error (A, B)', !(await A.js(`!document.getElementById('error').classList.contains('hidden')`)) &&
      !(await B.js(`!document.getElementById('error').classList.contains('hidden')`)), await A.js(`document.getElementById('error-text').textContent`));
    check('preload API present, Create enabled', await A.js(`!!window.f1host && F1.net.canCreate && !document.getElementById('mp-create').disabled`));
    await A.shot('1-menu');

    // typing in a field in the menu must not start / drive anything; Esc only blurs the field
    await A.js(`document.getElementById('mp-name').focus()`);
    for (const k of ['R', 'W', 'L']) { A.key(k, true); A.key(k, false); }
    A.key('Escape', true); A.key('Escape', false);
    await sleep(100);
    check('Esc in a text field blurs it and keeps the menu', await A.js(`document.activeElement.id !== 'mp-name' && !document.getElementById('menu').classList.contains('hidden') && !F1.game.running`));

    // ---- A creates the room ----
    await A.js(setField('mp-name', 'Alice'));
    await A.js(`document.querySelectorAll('.mp-swatch')[1].click()`);
    await A.js(setField('mp-port', String(PORT)));
    await A.js(`document.getElementById('mp-create').click()`);
    check('A connected as host', await A.until(`F1.net.connected && F1.net.isHost`, 5000), await A.js(`document.getElementById('mp-status').textContent`));
    await sleep(200);
    console.log('A host panel:', (await A.js(`document.getElementById('mp-online').innerText`)).replace(/\s+/g, ' '));
    await A.shot('2-hosting');

    // ---- B joins ----
    await B.js(setField('mp-name', 'Bob'));
    await B.js(`document.querySelectorAll('.mp-swatch')[2].click()`);
    await B.js(setField('mp-addr', '127.0.0.1:' + PORT));
    await B.js(`document.getElementById('mp-join').click()`);
    check('B connected, not host', await B.until(`F1.net.connected && !F1.net.isHost`, 5000), await B.js(`document.getElementById('mp-status').textContent`));
    await sleep(200);
    // v7.2: B sees the room lobby (no cards), waiting for the host's track
    check('B in the lobby: no cards, waiting for the host to pick the track (準備 disabled)', await B.js(`F1.game.setup.show === 'setup' && document.getElementById('track-grid').offsetParent === null &&
      document.getElementById('setup-status').textContent === '等待房主選擇賽道…' && document.getElementById('setup-ready').disabled && !F1.game.running`));
    await B.js(`document.querySelector('.card').click()`);
    await sleep(200);
    check('B clicking a (hidden) card does nothing', await B.js(`!F1.game.track && !F1.game.running && F1.net.room.set.track === null`));
    check('rosters agree', JSON.stringify(await A.js(`F1.net.roster.map(function(p){return p.name+p.colour+p.slot+p.isHost})`)) ===
      JSON.stringify(await B.js(`F1.net.roster.map(function(p){return p.name+p.colour+p.slot+p.isHost})`)), await B.js(`F1.net.roster`));
    await B.shot('3-joined-waiting');

    // ---- A picks the track (the lobby's picker: nothing loads), B presses 準備, A 開始: both load (the barrier) ----
    const picked = await A.js(`(function(){var c=[].slice.call(document.querySelectorAll('#track-grid .card')).filter(function(n){return n.textContent.toLowerCase().indexOf(${JSON.stringify(TRACK)})>=0;})[0]; if(!c) return null; c.click(); return c.textContent;})()`);
    console.log('A picked:', picked);
    check('the host\'s card sets the room\'s track; B sees it; nobody loads it before 開始', await B.until(`!!F1.net.room.set.track && F1.game.setup.trackId === F1.net.room.set.track`, 3000, 'B sees the track') &&
      await A.js(`!F1.game.track && !F1.game.running`) && await B.js(`!F1.game.track && !F1.game.running`));
    await B.js(`document.getElementById('setup-ready').click()`);
    check('B presses 準備: A\'s 開始 enabled', await A.until(`F1.game.setup.go.enabled`, 3000, 'A go enabled'));
    await A.js(`document.getElementById('setup-go').click()`);
    const okA = await A.until(`F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id`, 15000, 'A loads track');
    const okB = await B.until(`F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id`, 15000, 'B loads track');
    const ids = [await A.js(`F1.game.trackData && F1.game.trackData.id`), await B.js(`F1.game.trackData && F1.game.trackData.id`)];
    check('both loaded the same track and are driving', okA && okB && ids[0] === ids[1], ids);
    // the room has a track now: the host's status says how the lobby works, the guest's lobby no longer waits for a track
    const texts = { host: await A.js(`document.getElementById('mp-status').textContent`), guest: await B.js(`document.getElementById('mp-status').textContent`), guestLobby: await B.js(`F1.game.setup.ready.status`) };
    check('room texts once the track is picked: the host status (房間已建立，你是房主。在房間大廳選賽道和設定…), the guest status (已加入房間。選好車就按「準備」。), the guest\'s lobby no longer waits for a track',
      texts.host === '房間已建立，你是房主。在房間大廳選賽道和設定，大家準備好就按「開始」。' && texts.guest === '已加入房間。選好車就按「準備」。' && !/等待房主選擇賽道/.test(texts.guestLobby), texts);
    await sleep(1200);
    const a0 = await A.js(CAR), b0 = await B.js(CAR);
    console.log('A car', a0, '\nB car', b0);
    const gap = Math.hypot(a0.x - b0.x, a0.z - b0.z);
    // room slots 0 and 1 = the painted grid boxes 1 and 2: front bars 8 and 16 m behind the line, 3 m left / right of the
    // centreline (10 m between the two cars), the nose at the rear edge of the bar (0.25 m behind its front)
    const boxA = await A.js(BOX(0)), boxB = await B.js(BOX(1));
    const inBox = b => Math.abs(b.nose - 0.25) < 0.02 && Math.abs(b.off) < 0.02 && Math.abs(b.turn) < 1e-6;
    check('different grid slots (8 m apart along, 6 m across, opposite sides)', gap > 9.7 && gap < 10.3 && a0.d > 0 && b0.d < 0, { gap, dA: a0.d, dB: b0.d });
    check('each car stands in its painted grid box (A in box 1, B in box 2), standing still', inBox(boxA) && inBox(boxB) && a0.v === 0 && b0.v === 0, { boxA, boxB });
    const rB = await B.js(REMOTE), rA = await A.js(REMOTE);
    console.log('B sees', rB, '\nA sees', rA);
    check('B sees Alice at A\'s position', rB && rB.active && rB.name === 'Alice' && Math.hypot(rB.x - a0.x, rB.z - a0.z) < 0.05 && Math.abs(rB.y - a0.y) < 0.05, rB);
    check('A sees Bob at B\'s position', rA && rA.active && rA.name === 'Bob' && Math.hypot(rA.x - b0.x, rA.z - b0.z) < 0.05, rA);
    check('remote car model in B\'s scene, visible', await B.js(`(function(){var m=F1.game.remoteModels, k=Object.keys(m); return k.length===1 && m[k[0]].group.visible && !!m[k[0]].group.parent;})()`));
    check('HUD player list + minimap others', await B.js(`!document.getElementById('hud-players').classList.contains('hidden') && /Alice/.test(document.getElementById('hud-players').textContent)`));
    await B.shot('4-grid-sees-A');
    await A.shot('4-grid-pole');

    // ---- interpolation while A drives: B's view of A follows smoothly ----
    await B.js(`window.__rec=[]; (function loop(){ if(!window.__rec) return; var p=F1.net.players[0]; if(p&&p.active) window.__rec.push([performance.now(),p.state.x,p.state.z,p.state.speed]); requestAnimationFrame(loop); })(); 1`);
    await A.js(`window.__ft=[]; (function loop(t){ if(!window.__ft) return; window.__ft.push(t); requestAnimationFrame(loop); })(performance.now()); 1`);
    A.key('W', true);
    await sleep(3000);
    const rec = await B.js(`(function(){var r=window.__rec; window.__rec=null; return r;})()`);
    A.key('W', false);
    await B.shot('5-A-drives-away');
    const ft = await A.js(`(function(){var r=window.__ft; window.__ft=null; return r;})()`);
    let aMaxDt = 0; for (let i = 1; i < ft.length; i++) aMaxDt = Math.max(aMaxDt, ft[i] - ft[i - 1]);
    console.log('A frames during drive:', ft.length, 'max frame gap ms', aMaxDt, 'B frames', rec.length);
    let maxDev = 0, moved = 0, maxDt = 0;
    for (let i = 1; i < rec.length; i++) {
      const dt = (rec[i][0] - rec[i - 1][0]) / 1000, st = Math.hypot(rec[i][1] - rec[i - 1][1], rec[i][2] - rec[i - 1][2]);
      moved += st; maxDt = Math.max(maxDt, dt);
      maxDev = Math.max(maxDev, Math.abs(st - 0.5 * (rec[i][3] + rec[i - 1][3]) * dt));
    }
    check('B copy of A moves smoothly while A accelerates', rec.length > 30 && moved > 10 && maxDev < 1.2,
      { frames: rec.length, moved, maxDevMetresPerFrame: maxDev, maxFrameDt: maxDt, endSpeed: rec.length && rec[rec.length - 1][3] });
    A.key('S', true); await A.until('F1.game.car.state.speed < 1', 8000, 'A brakes'); A.key('S', false);
    await A.js('F1.game.car.state.speed = 0; 1');   // test setup: make sure A stands still
    await sleep(600);
    console.log('A parked at', await A.js(CAR));
    await sleep(400);

    // ---- collision: put B 14 m straight behind A, then full throttle into A's rear ----
    const a1 = await A.js(CAR);
    await B.js(`(function(){var s=F1.game.car.state, a=${JSON.stringify(a1)};
      s.x=a.x-Math.sin(a.h)*14; s.z=a.z-Math.cos(a.h)*14; s.heading=a.h; s.speed=0; s.steer=0; return 1;})()`);
    await sleep(500);
    await B.shot('6-behind-A');
    await B.js(`window.__maxHit=0; window.__iv=setInterval(function(){ if(F1.game.car.state.hit>window.__maxHit) window.__maxHit=F1.game.car.state.hit; },4); 1`);
    await A.js(`window.__maxHit=0; window.__maxV=0; window.__iv=setInterval(function(){ var s=F1.game.car.state; if(s.hit>window.__maxHit) window.__maxHit=s.hit; if(s.speed>window.__maxV) window.__maxV=s.speed; },4); 1`);
    B.key('W', true);
    let minGap = Infinity, maxVB = 0, minAlong = Infinity, shotDone = false;
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      const [ca, cb] = await Promise.all([A.js(CAR), B.js(CAR)]);
      // signed distance from B to A along A's heading: must stay positive (B never gets past / inside A)
      const along = (ca.x - cb.x) * Math.sin(ca.h) + (ca.z - cb.z) * Math.cos(ca.h);
      minAlong = Math.min(minAlong, along);
      minGap = Math.min(minGap, Math.hypot(ca.x - cb.x, ca.z - cb.z));
      maxVB = Math.max(maxVB, cb.v);
      if (!shotDone && along < 6.2) { shotDone = true; await B.shot('7-contact'); }
    }
    B.key('W', false);
    const a2 = await A.js(CAR), b2 = await B.js(CAR);
    const hitB = await B.js(`clearInterval(window.__iv), window.__maxHit`);
    const aStats = await A.js(`clearInterval(window.__iv), {hit: window.__maxHit, maxV: window.__maxV}`);
    const pushedA = Math.hypot(a2.x - a1.x, a2.z - a1.z);
    console.log('collision: minAlong', minAlong, 'minGap', minGap, 'B maxV', maxVB, 'B hit', hitB, 'A', aStats, 'A pushed', pushedA, '\nA end', a2, '\nB end', b2);
    check('B reached A and was stopped by it (no pass-through)', minAlong > 4.3 && minAlong < 7, { minAlong, minGap });
    check('B felt the hit (state.hit > 0)', hitB > 0.05, hitB);
    check('A was pushed forward by the contact', pushedA > 0.5 && aStats.maxV > 0.5, { pushedA, maxV: aStats.maxV, hitA: aStats.hit });
    await B.shot('8-after-collision');
    await A.shot('8-after-collision');

    // ---- B opens the menu: its car stays visible to A, parked ----
    B.key('Escape', true); B.key('Escape', false);
    await sleep(800);
    const rA2 = await A.js(REMOTE);
    check('B in menu: still visible to A, reported standing still', !(await B.js(`F1.game.running`)) && rA2 && rA2.active && Math.abs(rA2.v) < 0.01, rA2);
    await B.shot('9-menu-in-room');
    B.key('Escape', true); B.key('Escape', false);
    await sleep(300);
    check('B resumes with Esc', await B.js(`F1.game.running`));

    // ---- host changes the track (v7.2: 回到大廳, the picker, 開始): everyone reloads ----
    A.key('Escape', true); A.key('Escape', false);
    await sleep(300);
    await A.js(`document.getElementById('setup-lobby').click()`);
    check('host: 回到大廳 from the room menu: both in the lobby, off the track', await A.until(`F1.net.room.st === 'lobby' && !F1.game.running`, 3000) && await B.until(`F1.net.room.st === 'lobby' && !F1.game.running`, 3000));
    const picked2 = await A.js(`(function(){var cur=F1.game.trackData.id, i=F1_TRACKS.findIndex(function(t){return t.id!==cur;}); document.getElementById('setup-track-btn').click(); document.querySelector('#track-grid .card[data-i="' + i + '"]').click(); return F1_TRACKS[i].id;})()`);
    await B.until(`F1.net.room.set.track === ${JSON.stringify(picked2)}`, 3000, 'B sees the new track');
    await B.js(`document.getElementById('setup-ready').click()`);
    await A.until(`F1.game.setup.go.enabled`, 3000, 'A go enabled');
    await sleep(1100);                                       // (START_MIN_MS after 回到大廳)
    await A.js(`document.getElementById('setup-go').click()`);
    const sw = await B.until(`F1.game.trackData.id === ${JSON.stringify(picked2)} && F1.game.running`, 15000, 'B follows track change');
    check('track change by host is followed by B', sw && await A.js(`F1.game.trackData.id === ${JSON.stringify(picked2)} && F1.game.running`), picked2);
    await sleep(1000);
    await B.shot('10-second-track');

    // ---- host leaves: B gets a clear message and keeps driving alone ----
    A.key('Escape', true); A.key('Escape', false);
    await sleep(200);
    await A.js(`document.getElementById('mp-leave').click()`);
    const disc = await B.until(`!F1.net.connected`, 5000, 'B disconnected');
    await sleep(300);
    const toast = await B.js(`document.getElementById('hud-toast').textContent`);
    const status = await B.js(`document.getElementById('mp-status').textContent`);
    check('B told "連線中斷" and back to single player', disc && /連線中斷/.test(toast) && /連線中斷/.test(status) &&
      await B.js(`F1.game.running && Object.keys(F1.game.remoteModels).length === 0 && !document.getElementById('track-grid').classList.contains('locked')`), { toast, status });
    await B.shot('11-disconnected');
    const before = await B.js(CAR);
    B.key('W', true); await sleep(1500); B.key('W', false);
    const after = await B.js(CAR);
    check('B still drives in single player after the disconnect', after.v > 5 && Math.hypot(after.x - before.x, after.z - before.z) > 3, after.v);
    check('A back to offline panel; port released', await A.js(`!F1.net.connected && !document.getElementById('mp-offline').classList.contains('hidden')`));
    // the room can be created again on the same port (server really stopped)
    await A.js(`document.getElementById('mp-create').click()`);
    check('A can re-create the room on the same port', await A.until(`F1.net.connected && F1.net.isHost`, 5000), await A.js(`document.getElementById('mp-status').textContent`));
    // port already in use -> readable error (B tries to host on the same port)
    B.key('Escape', true); B.key('Escape', false);
    await sleep(200);
    await B.js(setField('mp-port', String(PORT)));
    await B.js(`document.getElementById('mp-create').click()`);
    await sleep(800);
    // note: same process, so host.js replaces A's server here rather than hitting EADDRINUSE
    console.log('B create on same port ->', await B.js(`document.getElementById('mp-status').textContent`));

    // ---- plain browser (no preload): Create disabled with an explanation, Join still there ----
    C = makeWin('C', false);
    await C.loadFile(ROOT + '/index.html');
    await sleep(600);
    check('no preload: Create disabled + explanation, Join enabled', await C.js(`!window.f1host && document.getElementById('mp-create').disabled && !document.getElementById('mp-create-note').classList.contains('hidden') && !document.getElementById('mp-join').disabled`),
      await C.js(`document.getElementById('mp-create-note').textContent`));
    await C.shot('12-browser-mode');
    // joining an address nobody listens on -> readable error, UI usable again
    await C.js(setField('mp-addr', '127.0.0.1:' + DEAD_PORT));
    await C.js(`document.getElementById('mp-join').click()`);
    await C.until(`/無法連線|逾時/.test(document.getElementById('mp-status').textContent)`, 10000, 'join failure message');
    check('failed join shows an error and re-enables the buttons', await C.js(`/無法連線|逾時/.test(document.getElementById('mp-status').textContent) && !document.getElementById('mp-join').disabled`), await C.js(`document.getElementById('mp-status').textContent`));
    // single player in the browser-mode window still works (v7.2: the card's start panel, 開始)
    await C.js(`document.querySelector('.card').click(); document.getElementById('setup-go').click()`);
    await C.until(`F1.game.running`, 15000, 'single player start');
    C.key('W', true); await sleep(1500); C.key('W', false);
    check('single player unaffected (no room)', await C.js(`F1.game.running && F1.game.car.state.speed > 5 && Math.abs(F1.game.car.state.d) < 0.5 && document.getElementById('hud-players').classList.contains('hidden')`), await C.js(CAR));
    await C.shot('13-single-player');
  } catch (e) {
    console.log('ERR', e && e.stack);
    results.push({ name: 'exception', ok: false });
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed' + (bad.length ? ' — FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  await host.stopServer();
  app.exit(bad.length ? 1 : 0);
});
