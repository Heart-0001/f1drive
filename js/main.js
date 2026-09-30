/* main.js — renderer/scene/camera/lights, input, main loop, lap timing, track switching, multiplayer glue. */
(function () {
  'use strict';
  var F1 = (window.F1 = window.F1 || {});

  function fail(msg) {
    if (F1.showError) F1.showError(msg);
    else {
      var d = document.createElement('pre');
      d.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;background:#0b0d10;color:#ffb4ae;z-index:999;white-space:pre-wrap';
      d.textContent = msg;
      document.body.appendChild(d);
    }
    if (window.console) console.error(msg);
  }

  var SKY = F1.SKY_HORIZON_COLOR || 0x87b8e8;   // fog/clear colour must match the sky dome's horizon
  var MAX_DT = 0.25;                         // longest real frame time simulated (avoids a jump after a stall)
  var STEP = 1 / 120;                        // physics step
  var START_BACK = 10;                       // samples behind the start line
  var GRID_GAP = 8;                          // metres between grid slots along the track (multiplayer)
  var GRID_SIDE = 2.6;                       // lateral offset of a grid slot from the centreline
  var GEAR_KMH = [60, 100, 140, 180, 220, 260, 300]; // upshift thresholds for gears 1..7

  var THREE, ui, tracks, net = null;
  var canvas, renderer, scene, camera;
  var track = null, trackData = null, car = null, cockpit = null;
  var raceLine = null, lineOn = true;
  var scenery = null, sky = null;
  var running = false, rafId = 0, lastT = 0, acc = 0;
  var input = { up: false, down: false, left: false, right: false };
  var hud = { speedKmh: 0, gear: 'N', lap: 0, curTime: null, lastTime: null, bestTime: null, x: 0, z: 0, heading: 0, others: null };

  // lap timing
  var lap = { started: false, n: 0, time: 0, last: null, best: null, prevIdx: 0, sector: 0 };

  // multiplayer
  var netUi = { status: '', statusKind: '', busy: false, lockText: '' };
  var remoteModels = {};                     // player id -> F1.createCarModel()
  var others = [];                           // states of the active remote cars this frame (for collisions)
  var otherIds = [];                         // player ids, parallel to others
  var contacts = [];                         // impacts of this frame, filled by F1.resolveCarCollisions
  var impacts = {};                          // per player id: {sx, sz: owed to them, not sent yet; lx, lz, t: what we took}
  var lastHitSend = 0, netHit = 0;
  var HIT_SEND_MS = 50;                      // impact reports are batched to 20 Hz
  var HIT_MEMORY_MS = 400;                   // how long an impact we resolved ourselves offsets a reported one
  var HIT_RANGE = 15;                        // m: reports from a car that is nowhere near us are ignored
  var mapOthers = [];                        // [{x, z, colour}] for the minimap
  var eye = { x: 0, y: 0, z: 0 };
  var sharedLast = null, sharedBest = null;
  var knownPlayers = null;                   // id -> name, to announce joins / leaves

  var KEYMAP = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right'
  };
  var BLOCK = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1 };

  /* ---------- setup ---------- */

  function checkModules() {
    var missing = [];
    if (!window.THREE) missing.push('lib/three.min.js（THREE）');
    if (!window.F1_TRACKS || !window.F1_TRACKS.length) missing.push('tracks-data.js（F1_TRACKS）');
    if (typeof F1.buildTrack !== 'function') missing.push('js/track.js（F1.buildTrack）');
    if (typeof F1.createCar !== 'function') missing.push('js/car.js（F1.createCar）');
    if (typeof F1.createCockpit !== 'function') missing.push('js/cockpit.js（F1.createCockpit）');
    if (!F1.ui) missing.push('js/ui.js（F1.ui）');
    if (missing.length) {
      fail('缺少必要的模組：\n  ' + missing.join('\n  '));
      return false;
    }
    return true;
  }

  function initGraphics() {
    canvas = document.getElementById('game');
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 300, 2500);

    camera = new THREE.PerspectiveCamera(70, window.innerWidth / Math.max(window.innerHeight, 1), 0.1, 4000);
    camera.position.set(0, 1, 0);

    scene.add(new THREE.HemisphereLight(0xdcebff, 0x556644, 0.85));
    var sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(300, 600, 200);
    scene.add(sun);

    if (typeof F1.createSky === 'function') {
      sky = F1.createSky();
      scene.add(sky);
    }

    window.addEventListener('resize', onResize);
  }

  function onResize() {
    var w = window.innerWidth, h = Math.max(window.innerHeight, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!running) renderer.render(scene, camera);
  }

  /* ---------- track switching ---------- */

  function resetLap(startIdx) {
    lap.started = false; lap.n = 0; lap.time = 0; lap.last = null; lap.best = null;
    lap.prevIdx = startIdx; lap.sector = 0;
    sharedLast = null; sharedBest = null;
  }

  // Multiplayer: every player starts on a different grid slot behind the line — two columns, left/right of
  // the centreline alternately, GRID_GAP metres apart along the track (slot 0 = pole, in join order).
  function placeOnGrid(slot) {
    var S = track.samples, n = S.length;
    var spacing = track.length > 0 ? track.length / n : 2;
    var back = START_BACK + Math.round(slot * GRID_GAP / Math.max(spacing, 0.5));
    var idx = ((n - back) % n + n) % n;
    car.reset(track, idx);
    var s = S[car.state.sampleIndex] || S[idx];
    var hw = typeof s.halfW === 'number' ? s.halfW : track.halfWidth;
    var side = Math.max(0, Math.min(GRID_SIDE, (hw || 7) - 1.8));
    var d = (slot % 2 === 0 ? 1 : -1) * side;
    car.state.x += s.nx * d;
    car.state.z += s.nz * d;
    car.update(1e-4, null, track);          // no input, standing still: just re-locates (d, height) at the new spot
    car.state.speed = 0;
    return car.state.sampleIndex;
  }

  function selectTrack(data) {
    try {
      if (raceLine) {
        scene.remove(raceLine.group);
        raceLine.dispose();
        raceLine = null;
      }
      if (scenery) {
        scene.remove(scenery.group);
        scenery.dispose();
        scenery = null;
      }
      if (track) {
        scene.remove(track.group);
        if (track.dispose) track.dispose();
        track = null;
      }
      trackData = data;
      track = F1.buildTrack(data);
      scene.add(track.group);
      if (typeof F1.buildScenery === 'function') {
        try {
          scenery = F1.buildScenery(track, data, window.F1_SCENERY ? window.F1_SCENERY[data.id] : undefined);
          scene.add(scenery.group);
        } catch (err) {
          // scenery is decoration: never block driving because of it
          scenery = null;
          if (window.console) console.error(err);
        }
      }
      if (typeof F1.buildRaceLine === 'function') {
        raceLine = F1.buildRaceLine(track);
        raceLine.setVisible(lineOn);
        scene.add(raceLine.group);
      }

      if (!car) car = F1.createCar();
      if (!cockpit) {
        cockpit = F1.createCockpit(camera);
        scene.add(cockpit.group);
      }

      var n = track.samples.length;
      var startIdx = ((n - START_BACK) % n + n) % n;
      if (net && net.connected) startIdx = placeOnGrid(net.slot || 0);
      else car.reset(track, startIdx);
      resetLap(startIdx);
      clearInput();

      ui.setTrack(data);
      cockpit.update(car.state, 0);
      if (raceLine && lineOn) raceLine.update(car.state);
      pushHUD();
      if (ui.setResumeHandler) ui.setResumeHandler(resume);
      resume();
    } catch (err) {
      fail('載入賽道失敗：' + (data && data.name ? data.name : '') + '\n' + (err && err.stack ? err.stack : err));
    }
  }

  // In a room we only drive on the room's track (the one everybody else has loaded).
  function inRoomTrack() {
    return !!(net && net.connected && trackData && net.trackId === trackData.id);
  }
  function canResume() {
    if (!track || !car) return false;
    return !(net && net.connected) || inRoomTrack();
  }

  function resume() {
    if (!canResume()) return;
    ui.hideMenu();
    clearInput();
    if (running) return;
    running = true;
    lastT = 0; acc = 0;
    rafId = requestAnimationFrame(frame);
  }

  function exitToMenu() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    clearInput();
    // multiplayer: our car stays where it is, visible and solid for the others, reported as standing still
    if (net && net.connected) net.park();
    ui.showMenu(tracks);
    if (renderer) renderer.render(scene, camera); // static frame behind the menu
  }

  /* ---------- multiplayer ---------- */

  function findTrack(id) {
    for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return tracks[i];
    return null;
  }

  function refreshNetUi() {
    if (!ui.setNet) return;
    ui.setNet({
      canCreate: !!(net && net.canCreate),
      connected: !!(net && net.connected),
      busy: netUi.busy,
      isHost: !!(net && net.isHost),
      hostInfo: net ? net.hostInfo : null,
      roster: net ? net.roster : [],
      status: netUi.status, statusKind: netUi.statusKind, lockText: netUi.lockText
    });
    if (ui.setResumeHandler) ui.setResumeHandler(canResume() ? resume : null);
  }

  function setStatus(text, kind) { netUi.status = text || ''; netUi.statusKind = kind || ''; }

  function clearRemoteModels() {
    for (var id in remoteModels) {
      scene.remove(remoteModels[id].group);
      remoteModels[id].dispose();
    }
    remoteModels = {};
    others.length = 0; otherIds.length = 0; mapOthers.length = 0;
    impacts = {}; netHit = 0;
  }

  // Interpolate the remote cars for this frame; fills `others` (collision) and `mapOthers` (minimap).
  function updateRemotes(dt) {
    others.length = 0; otherIds.length = 0;
    var m = 0, id;
    if (!inRoomTrack() || typeof F1.createCarModel !== 'function') {
      for (id in remoteModels) { clearRemoteModels(); break; }
      mapOthers.length = 0;
      return;
    }
    net.update();
    var list = net.players, seen = {};
    eye.x = car.state.x; eye.y = (car.state.y || 0) + 0.8; eye.z = car.state.z;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      seen[p.id] = true;
      var model = remoteModels[p.id];
      if (!model) {
        model = remoteModels[p.id] = F1.createCarModel(p.colour, p.name);
        scene.add(model.group);
      }
      model.setColour(p.colour);
      model.setName(p.name);
      model.group.visible = p.active;
      if (!p.active) continue;
      model.update(p.state, dt, eye);
      others.push(p.state);
      otherIds.push(p.id);
      var o = mapOthers[m] || (mapOthers[m] = { x: 0, z: 0, colour: '' });
      o.x = p.state.x; o.z = p.state.z; o.colour = p.colour;
      m++;
    }
    mapOthers.length = m;
    for (id in remoteModels) {
      if (!seen[id]) {
        scene.remove(remoteModels[id].group);
        remoteModels[id].dispose();
        delete remoteModels[id];
      }
    }
  }

  // Each game resolves only its own car, and a car that gets hit usually never sees the overlap (the
  // hitter has already stopped by the time its position arrives). So the hitter reports the impulse and
  // the victim applies whatever part of it its own resolver has not already applied.
  function collectContacts(now) {
    var i, c, id, r;
    for (i = 0; i < contacts.length; i++) {
      c = contacts[i]; id = otherIds[c.i];
      if (id == null) continue;
      r = impacts[id] || (impacts[id] = { sx: 0, sz: 0, lx: 0, lz: 0, t: 0 });
      if (now - r.t > HIT_MEMORY_MS) { r.lx = 0; r.lz = 0; }
      r.lx += c.ix; r.lz += c.iz; r.t = now;
      r.sx -= c.ix; r.sz -= c.iz;             // the other car is owed the opposite velocity change
    }
    contacts.length = 0;
    if (now - lastHitSend < HIT_SEND_MS) return;
    for (id in impacts) {
      r = impacts[id];
      if (r.sx * r.sx + r.sz * r.sz > 0.04) { net.sendHit(Number(id), r.sx, r.sz); lastHitSend = now; }
      r.sx = 0; r.sz = 0;
    }
  }

  function onRemoteHit(from, imp) {
    if (!running || !inRoomTrack() || typeof F1.applyCarImpulse !== 'function') return;
    var k = otherIds.indexOf(from);
    if (k < 0) return;
    var o = others[k], dx = o.x - car.state.x, dz = o.z - car.state.z;
    if (dx * dx + dz * dz > HIT_RANGE * HIT_RANGE) return;
    var mag = Math.sqrt(imp[0] * imp[0] + imp[1] * imp[1]);
    if (!(mag > 0.2)) return;
    var ux = imp[0] / mag, uz = imp[1] / mag, now = performance.now();
    var r = impacts[from] || (impacts[from] = { sx: 0, sz: 0, lx: 0, lz: 0, t: 0 });
    if (now - r.t > HIT_MEMORY_MS) { r.lx = 0; r.lz = 0; }
    var already = Math.max(0, r.lx * ux + r.lz * uz);   // what our own resolver did for the same impact
    var rest = mag - already;
    if (rest < 0.2) return;
    var h = F1.applyCarImpulse(car.state, ux * rest, uz * rest);
    if (h > netHit) netHit = h;
    r.lx += ux * rest; r.lz += uz * rest; r.t = now;
  }

  function shareLap() {
    if (lap.last === sharedLast && lap.best === sharedBest) return;
    sharedLast = lap.last; sharedBest = lap.best;
    net.sendLap(lap.last, lap.best);
  }

  function announce(roster) {
    var now = {}, i, id;
    for (i = 0; i < roster.length; i++) now[roster[i].id] = roster[i].name;
    if (knownPlayers && ui.toast) {
      for (i = 0; i < roster.length; i++) {
        if (!(roster[i].id in knownPlayers) && !roster[i].isSelf) ui.toast(roster[i].name + ' 加入了房間');
      }
      for (id in knownPlayers) if (!(id in now)) ui.toast(knownPlayers[id] + ' 離開了房間');
    }
    knownPlayers = now;
  }

  function initNet() {
    net = F1.net || null;
    if (!net) { refreshNetUi(); return; }
    if (ui.getProfile) net.setProfile(ui.getProfile());

    net.on('connected', function () {
      netUi.lockText = '';
      setStatus(net.isHost ? '房間已建立，你是房主。選一條賽道開始。' : '已加入房間。', 'ok');
      refreshNetUi();
    });
    net.on('players', function (roster) {
      var wasHost = netUi.wasHost;
      netUi.wasHost = net.isHost;
      if (knownPlayers && net.isHost && wasHost === false) {
        setStatus('原本的房主離開了，現在你是房主。', 'ok');
        if (ui.toast) ui.toast('你現在是房主');
      }
      announce(roster);
      refreshNetUi();
    });
    net.on('track', function (id) {
      var data = findTrack(id);
      if (!data) {
        netUi.lockText = '房主選了這個版本沒有的賽道（' + id + '），請更新遊戲。';
        setStatus('無法載入房主選的賽道', 'err');
        refreshNetUi();
        return;
      }
      netUi.lockText = '';
      clearRemoteModels();
      selectTrack(data);                      // spawns on our grid slot and starts driving
      refreshNetUi();
    });
    net.on('hit', onRemoteHit);
    net.on('disconnected', function (reason) {
      clearRemoteModels();
      knownPlayers = null; netUi.wasHost = undefined; netUi.lockText = '';
      netUi.busy = false;
      var left = reason === '已離開房間';
      setStatus(reason || '連線中斷', left ? '' : 'err');
      if (!left && ui.toast) ui.toast((reason || '連線中斷') + '，已回到單人模式', 6000);
      refreshNetUi();
      if (!running && renderer) renderer.render(scene, camera);
    });
    refreshNetUi();
  }

  function roomResult(res, what) {
    netUi.busy = false;
    if (!res || !res.ok) setStatus((res && res.error) || (what + '失敗'), 'err');
    refreshNetUi();
  }

  function createRoom(port) {
    if (!net || netUi.busy) return;
    netUi.busy = true;
    setStatus('正在建立房間…', '');
    refreshNetUi();
    net.create(port).then(function (r) { roomResult(r, '建立房間'); }, function () { roomResult(null, '建立房間'); });
  }

  function joinRoom(address) {
    if (!net || netUi.busy) return;
    if (!address) { setStatus('請輸入房主的 IP 位址', 'err'); refreshNetUi(); return; }
    netUi.busy = true;
    setStatus('正在連線到 ' + address + ' …', '');
    refreshNetUi();
    net.join(address).then(function (r) { roomResult(r, '加入房間'); }, function () { roomResult(null, '加入房間'); });
  }

  // A card in the track grid was clicked.
  function onPickTrack(data) {
    if (net && net.connected) {
      // the host's choice goes through the server; everybody (incl. us) loads it on the 'track' event
      if (net.isHost) net.selectTrack(data.id);
      return;
    }
    selectTrack(data);
  }

  /* ---------- input ---------- */

  function clearInput() { input.up = input.down = input.left = input.right = false; }

  function isTyping(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true;
  }

  function onKeyDown(e) {
    var typing = isTyping(e);
    if (e.code === 'Escape') {
      if (running) { e.preventDefault(); exitToMenu(); }
      else if (typing) { e.preventDefault(); e.target.blur(); }   // Esc in a text field only leaves the field
      else if (canResume()) { e.preventDefault(); resume(); }
      return;
    }
    if (!running || typing) return;     // menu / text fields: keys are for typing, not for driving
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (BLOCK[e.code]) e.preventDefault();
    var k = KEYMAP[e.code];
    if (k) { input[k] = true; return; }
    if (e.code === 'KeyL' && !e.repeat) {
      lineOn = !lineOn;
      if (raceLine) raceLine.setVisible(lineOn);
      return;
    }
    if (e.code === 'KeyR' && !e.repeat) {
      car.reset(track, car.state.sampleIndex);
      // timing keeps running; the car is back on the centreline at its current progress
      lap.prevIdx = car.state.sampleIndex;
    }
  }

  function onKeyUp(e) {
    var k = KEYMAP[e.code];
    if (k) input[k] = false;
  }

  /* ---------- lap timing ---------- */

  // The lap is split in 4 quarters. `sector` is the furthest quarter reached IN ORDER since the last
  // valid start/finish crossing; a lap only counts when quarters 1, 2, 3 were each entered from the previous one.
  function updateLap(dt) {
    var n = track.samples.length;
    var idx = car.state.sampleIndex;
    var prev = lap.prevIdx;
    lap.prevIdx = idx;

    if (lap.started) lap.time += dt;
    if (idx === prev) return;

    var q = Math.min(3, Math.floor(idx * 4 / n));
    var pq = Math.min(3, Math.floor(prev * 4 / n));
    var forward = car.state.speed > 0;

    if (pq === 3 && q === 0 && forward) {
      // forward crossing of the start/finish line
      if (!lap.started) {
        lap.started = true; lap.n = 1; lap.time = 0; lap.sector = 0;
      } else if (lap.sector === 3) {
        lap.last = lap.time;
        if (lap.best == null || lap.time < lap.best) lap.best = lap.time;
        lap.n += 1; lap.time = 0; lap.sector = 0;
      }
      // otherwise: crossed without completing the loop (e.g. reversed over the line and came back) — ignore
    } else if (lap.started && q === lap.sector + 1 && pq === lap.sector) {
      lap.sector = q;
    }
  }

  function gearFor(speed) {
    if (speed < -0.5) return 'R';
    if (speed < 0.5) return 'N';
    var kmh = speed * 3.6;
    for (var i = 0; i < GEAR_KMH.length; i++) if (kmh < GEAR_KMH[i]) return i + 1;
    return 8;
  }

  function pushHUD() {
    var s = car.state;
    hud.speedKmh = Math.abs(s.speed) * 3.6;
    hud.gear = gearFor(s.speed);
    hud.lap = lap.n;
    hud.curTime = lap.started ? lap.time : null;
    hud.lastTime = lap.last;
    hud.bestTime = lap.best;
    hud.x = s.x; hud.z = s.z; hud.heading = s.heading;
    hud.others = mapOthers.length ? mapOthers : null;
    ui.updateHUD(hud);
  }

  /* ---------- loop ---------- */

  function frame(t) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    var dt = lastT ? (t - lastT) / 1000 : 0;
    lastT = t;
    if (dt > MAX_DT) dt = MAX_DT;
    if (dt < 0) dt = 0;
    try {
      var mp = inRoomTrack();
      if (mp || mapOthers.length) updateRemotes(dt);
      var collide = others.length && typeof F1.resolveCarCollisions === 'function';
      // fixed physics steps so the car and lap clock keep real-time pace at low frame rates
      acc += dt;
      var hit = netHit, stepped = false;
      netHit = 0;
      while (acc >= STEP) {
        car.update(STEP, input, track);
        // our car against the other players' cars; the next car.update re-clamps against the walls
        if (collide) F1.resolveCarCollisions(car.state, others, STEP, contacts);
        if (car.state.hit > hit) hit = car.state.hit;
        stepped = true;
        updateLap(STEP);
        acc -= STEP;
      }
      if (stepped) car.state.hit = hit;   // strongest impact of the frame (car.update clears it every step)
      else netHit = hit;
      if (mp) collectContacts(performance.now());
      cockpit.update(car.state, dt);
      if (mp) {
        net.sendState(car.state);
        shareLap();
      }
      if (raceLine && lineOn) raceLine.update(car.state);
      if (sky && sky.update) sky.update(camera);
      pushHUD();
      renderer.render(scene, camera);
    } catch (err) {
      running = false;
      cancelAnimationFrame(rafId); rafId = 0;
      fail('執行時發生錯誤：\n' + (err && err.stack ? err.stack : err));
    }
  }

  /* ---------- boot ---------- */

  function boot() {
    if (!checkModules()) return;
    THREE = window.THREE; ui = F1.ui; tracks = window.F1_TRACKS;
    try {
      initGraphics();
    } catch (err) {
      fail('無法建立 WebGL 繪圖環境：\n' + (err && err.message ? err.message : err));
      return;
    }
    ui.init({
      onSelectTrack: onPickTrack, onExitToMenu: exitToMenu,
      onCreateRoom: createRoom, onJoinRoom: joinRoom,
      onLeaveRoom: function () { if (net) net.leave(); },
      onProfile: function (p) { if (F1.net) F1.net.setProfile(p); }
    });
    initNet();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', function () { if (document.hidden) clearInput(); lastT = 0; });
    ui.showMenu(tracks);
    renderer.render(scene, camera);
  }

  // read-only peek for tests / debugging
  F1.game = {
    get car() { return car; }, get track() { return track; }, get trackData() { return trackData; },
    get running() { return running; }, get camera() { return camera; }, get remoteModels() { return remoteModels; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
