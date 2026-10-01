/* main.js — renderer/scene/camera/lights, input (keyboard + controller), main loop, lap timing, track switching,
   multiplayer and Grand Prix glue; v6: seasons and cars, battery, pit limiter, tyres and pit stops, sound, telemetry. */
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
  var START_BACK = 10;                       // samples behind the start line (alone, free practice)
  var CAR_NOSE = 2.8;                        // metres from the car's origin (car.state.x / z) to the tip of its nose
  var PAD_MENU_MS = 100;                     // the controller is polled this often while the loop is not running (menu)
  var RUMBLE_MIN = 0.03;                     // weakest impact (0..1) the controller rumbles for
  // A fresh install drives the reference car (F1.REF_SPEC, the v5 car = '2025-standard'): the season the menu opens on
  // until the player picks one.
  var START_YEAR = 2025;
  var PIT_REACH = 40;                        // m around the pit complex in which a remote car is checked for the pit lane

  var THREE, ui, tracks, net = null;
  var gp = null;                             // F1.gp, the Grand Prix session (set at boot)
  var pad = null;                            // F1.gamepad, optional
  var cars = null;                           // F1.cars (seasons and their cars), optional
  var audio = null;                          // F1.audio, optional
  var pit = null;                            // F1.createPit() (pit lane visits, stops), optional
  var canvas, renderer, scene, camera;
  var track = null, trackData = null, car = null, cockpit = null;
  var raceLine = null, lineOn = true;
  var scenery = null, sky = null;
  var running = false, rafId = 0, lastT = 0, acc = 0;
  var goFrame = false;                       // the Grand Prix lights went out in the frame being simulated
  var input = { up: false, down: false, left: false, right: false };   // keyboard (the arrows / WASD)
  var boostKey = false;                      // E held: deploy the battery
  var limiterOn = false;                     // pit limiter engaged (Q / LB toggle it)
  var nextCompound = 'M';                    // the tyres the next set will be (T / Back cycle S -> M -> H)
  // keyboard + controller: what car.update() gets (filled every frame)
  var driveInput = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false, limiter: false };
  // the HUD / telemetry object handed to ui.updateHUD every frame (one object, filled in place)
  var hud = {
    speedKmh: 0, gear: 0, lap: 0, lapTotal: null, curTime: null, lastTime: null, bestTime: null, x: 0, z: 0, heading: 0, others: null,
    rpm: 0, rpmIdle: 4000, rpmShift: 11800, rpmMax: 12500, throttle: 0, brake: 0, battery: null, deploy: 0, harvest: 0,
    limiter: false, inPit: false, limitKmh: 80, tyres: null, nextCompound: 'M', team: '', car: '', colour: '#888888', colour2: '#888888'
  };
  var pitView = { inLane: false, limiter: false, speeding: false, service: null, limitKmh: 80, boxAhead: null, slot: -1, pending: 0 };
  var pitOpt = { slot: 0, limiter: false };
  var pitBox = null;                         // bounding box of the pit complex of this track (+ PIT_REACH), or null
  var listener = { x: 0, y: 0, z: 0, heading: 0 };   // where the driver's ears are, for F1.audio
  var audioOthers = [];                      // [{id, x, y, z, heading, speed, spec}] remote cars for F1.audio
  var audioKicked = false;                   // F1.audio.init() has been called from a user input
  var beepLights = -1, beepGo = false;       // start lights as last shown (a beep for every lamp and at lights out)

  // lap timing: one counter per loaded track (js/laps.js)
  var lap = null;
  // Grand Prix: our laps of the phase are done (qualifying completed, flag taken, results): the timing box as it stood
  // then, {last, best}; null otherwise. Laps driven afterwards count for nothing and must not replace those times.
  var lapsDone = null;

  // seasons: the years there are cars for (year -> true)
  var seasonYears = Object.create(null);
  var carsKey = '';                          // what ui.setCars was last given (so it is only called on a change)

  // multiplayer
  var netUi = { status: '', statusKind: '', busy: false, lockText: '' };
  var HOST_PICK = '房間已建立，你是房主。選一條賽道開始。';   // the host's status until the room has a track
  var remoteModels = {};                     // player id -> F1.createCarModel()
  var remoteCars = {};                       // player id -> {car, year, colour, spec}: the car that player drives
  var others = [];                           // states of the active, solid remote cars this frame (for collisions)
  var otherIds = [];                         // player ids, parallel to others
  var ghostNow = {};                         // player id -> true: a ghost this frame (Grand Prix or pit lane)
  var contacts = [];                         // impacts of this frame, filled by F1.resolveCarCollisions
  var impacts = {};                          // per player id: {sx, sz: owed to them, not sent yet; lx, lz, t: what we took}
  var lastHitSend = 0, netHit = 0;
  var HIT_SEND_MS = 50;                      // impact reports are batched to 20 Hz
  var HIT_MEMORY_MS = 400;                   // how long an impact we resolved ourselves offsets a reported one
  var HIT_RANGE = 15;                        // m: reports from a car that is nowhere near us are ignored
  var GHOST_CLEAR = 6;                       // m between centres: two cars further apart than this cannot touch
  var soft = {};                             // ids of cars that were ghosts and have not got clear of ours since
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
  var COMPOUND_NAME = { S: '軟胎', M: '中性胎', H: '硬胎' };
  var WHEEL_NAME = ['左前輪', '右前輪', '左後輪', '右後輪'];   // car.tyres.state order: FL, FR, RL, RR
  var puncture = -1;                         // the punctured wheel as last announced (-1: none)

  /* ---------- setup ---------- */

  function checkModules() {
    var missing = [];
    if (!window.THREE) missing.push('lib/three.min.js（THREE）');
    if (!window.F1_TRACKS || !window.F1_TRACKS.length) missing.push('tracks-data.js（F1_TRACKS）');
    if (typeof F1.buildTrack !== 'function') missing.push('js/track.js（F1.buildTrack）');
    if (typeof F1.createCar !== 'function') missing.push('js/car.js（F1.createCar）');
    if (typeof F1.createCockpit !== 'function') missing.push('js/cockpit.js（F1.createCockpit）');
    if (typeof F1.createLapCounter !== 'function') missing.push('js/laps.js（F1.createLapCounter）');
    if (!F1.gp) missing.push('js/gp.js（F1.gp）');
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

  /* ---------- seasons and cars ---------- */

  function isSeason(y) { return typeof y === 'number' && seasonYears[y] === true; }

  // The season our car must be of: a running Grand Prix's, else the room's, else the player's own pick.
  function activeYear() {
    var s = gp && gp.phase !== 'free' && gp.snapshot ? gp.snapshot.year : null;
    if (isSeason(s)) return s;
    var r = net && net.connected ? net.year : null;
    if (isSeason(r)) return r;
    return ownYear();
  }
  // The season the player picked in the menu (remembered by ui.js), else the reference car's.
  function ownYear() {
    var y = ui && ui.getYear ? ui.getYear() : null;
    if (isSeason(y)) return y;
    if (isSeason(START_YEAR)) return START_YEAR;
    return cars ? cars.DEFAULT_YEAR : START_YEAR;
  }

  function profileColour() {
    var p = ui && ui.getProfile ? ui.getProfile() : null;
    return p && typeof p.colour === 'string' ? p.colour : null;
  }

  function carName(spec) {
    return (spec.teamZh || spec.team || '') + (spec.car ? ' ' + spec.car : '');
  }

  // Our car: the player's pick resolved into the active season (the same team, or that season's standard car).
  // -> true when the car changed.
  function applyCar() {
    if (!cars || !car) { pushCars(); return false; }
    var spec = cars.resolve(ui.getCar ? ui.getCar() : null, activeYear());
    var changed = !car.spec || car.spec.id !== spec.id;
    if (changed) {
      car.setSpec(spec);
      car.setBattery(1);                      // a car out of the garage: charged
      if (cockpit && cockpit.setCar) cockpit.setCar(car.spec, profileColour());
      if (audio && audio.setEngine) audio.setEngine(car.spec);
      if (track) {                            // this car's racing line (its grip, power, drag)
        buildLine();
        if (raceLine && lineOn) raceLine.update(car.state);
      }
    }
    if (net) net.setProfile({ car: car.spec.id });
    pushCars();
    return changed;
  }

  // The 車輛 tab: the active season's cars, ours highlighted; what may be changed right now.
  function pushCars() {
    if (!cars || !ui.setCars) return;
    var y = activeYear(), session = !!(gp && gp.phase !== 'free'), room = !!(net && net.connected);
    var guest = room && !net.isHost;
    var canYear = !session && !guest, canCar = !session;
    var reason = session ? '賽事進行中不能換車' : (guest ? '年份由房主選擇，大家都從這一年的車裡挑。' : '');
    var sel = car && car.spec ? car.spec.id : null;
    var key = y + '|' + sel + '|' + canYear + '|' + canCar + '|' + reason;
    if (key === carsKey) return;
    carsKey = key;
    ui.setCars({ year: y, cars: cars.list(y), selected: sel, canPickYear: canYear, canPickCar: canCar, seasons: cars.seasons, reason: reason });
  }

  // 年份 picked in the menu. Alone: at once. The host: through the server (the answer is the room's 'year' event).
  function onPickYear(y) {
    if (net && net.connected) {
      if (net.isHost && net.setYear && net.setYear(y)) return;
      carsKey = '';                           // refused / not ours to change: the list shows the room's year again
      pushCars();
      return;
    }
    if (applyCar()) renderStill();            // (the cockpit behind the menu shows the new car)
  }

  function onPickCar() {
    var before = car ? car.spec.id : '';
    applyCar();
    if (car && car.spec.id !== before && !running) renderStill();
  }

  // The racing line for this car on this track (rebuilt when either changes).
  function buildLine() {
    if (raceLine) {
      scene.remove(raceLine.group);
      raceLine.dispose();
      raceLine = null;
    }
    if (!track || typeof F1.buildRaceLine !== 'function') return;
    raceLine = F1.buildRaceLine(track, car.perf);
    raceLine.setVisible(lineOn);
    scene.add(raceLine.group);
  }

  function renderStill() { if (renderer && !running) renderer.render(scene, camera); }

  /* ---------- track switching ---------- */

  // The car was placed: timing starts again at the next crossing of the line.
  function resetLap(idx) {
    lap.reset(idx);
    sharedLast = sharedBest = undefined;    // shareLap() tells the room that our times are gone
  }

  // Alone: on the centreline, START_BACK samples before the line.
  function placeAtStart() {
    var n = track.samples.length;
    car.reset(track, ((n - START_BACK) % n + n) % n);
    return car.state.sampleIndex;
  }

  // Multiplayer / Grand Prix grid: every car stands in its own painted grid box behind the line (slot 0 = pole,
  // two columns left / right of the centreline alternately; js/track.js paints them and lists them in
  // track.grid): the nose at the box's front bar, the car on the box's centreline, facing the way the box does.
  function placeOnGrid(slot) {
    var G = track.grid, g = G[Math.max(0, Math.min(G.length - 1, Math.floor(slot) || 0))];
    car.reset(track, g.index);              // stopped, steering centred, attitude of the road there
    car.state.heading = g.heading;
    car.state.x = g.x - Math.sin(g.heading) * CAR_NOSE;
    car.state.z = g.z - Math.cos(g.heading) * CAR_NOSE;
    car.update(1e-4, null, track);          // no input, standing still: just re-locates (sample, d, height) at the new spot
    car.state.speed = 0;
    return car.state.sampleIndex;
  }

  // Where a freshly loaded track (and qualifying) puts us: our slot in a room (join order), the start position alone.
  function placeStart() {
    return net && net.connected ? placeOnGrid(net.slot || 0) : placeAtStart();
  }

  // The tyre wear multiplier: the Grand Prix option during a session, normal in free practice.
  function wearRate() {
    var s = gp && gp.phase !== 'free' ? gp.snapshot : null;
    return s && typeof s.wear === 'number' && s.wear >= 1 ? s.wear : 1;
  }

  // The car was placed for a new start (track loaded, qualifying, grid): full battery, a new set of the chosen compound,
  // limiter off, no pit visit / pending penalty.
  function freshStart() {
    car.setBattery(1);
    if (car.tyres) {
      car.tyres.fit(nextCompound);
      car.tyres.setWearRate(wearRate());
    }
    limiterOn = false;
    if (pit) pit.reset();
  }

  // Bounding box of the pit complex (+ PIT_REACH): only a remote car inside it is looked up in the pit lane.
  function pitBounds() {
    var P = track.pit;
    if (!P || typeof P.contains !== 'function') return null;
    var S = track.samples, n = S.length, from = ((P.from | 0) % n + n) % n, to = ((P.to | 0) % n + n) % n;
    var b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (var i = from, k = 0; k <= n; i = (i + 1) % n, k++) {
      var s = S[i];
      if (s.x < b.x0) b.x0 = s.x; if (s.x > b.x1) b.x1 = s.x;
      if (s.z < b.z0) b.z0 = s.z; if (s.z > b.z1) b.z1 = s.z;
      if (i === to) break;
    }
    b.x0 -= PIT_REACH; b.x1 += PIT_REACH; b.z0 -= PIT_REACH; b.z1 += PIT_REACH;
    return b;
  }

  function selectTrack(data) {
    try {
      if (gp) gp.trackChanged();              // another track ends a Grand Prix (alone; in a room the server does it)
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
      pitBox = pitBounds();
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
      buildLine();

      if (!cockpit) {
        cockpit = F1.createCockpit(camera);
        scene.add(cockpit.group);
        if (cockpit.setCar) cockpit.setCar(car.spec, profileColour());
      }

      lap = F1.createLapCounter(track.samples.length, placeStart());
      if (cockpit.setSources) cockpit.setSources({ car: car, lap: lap });
      freshStart();
      sharedLast = null; sharedBest = null;
      clearInput();

      ui.setTrack(data);
      cockpit.update(car.state, 0);
      if (raceLine && lineOn) raceLine.update(car.state);
      pushHUD();
      pushGp();                               // a Grand Prix can be started now
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
    if (audio) audio.setActive(true);
    if (running) return;
    running = true;
    lastT = 0; acc = 0;
    rafId = requestAnimationFrame(frame);
  }

  function exitToMenu() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    clearInput();
    if (audio) audio.setActive(false);
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
      roomTrack: !!(net && net.connected && net.trackId),
      status: netUi.status, statusKind: netUi.statusKind, lockText: netUi.lockText
    });
    if (ui.setResumeHandler) ui.setResumeHandler(canResume() ? resume : null);
    pushGp();                                 // who may start a Grand Prix follows the room too
  }

  function setStatus(text, kind) { netUi.status = text || ''; netUi.statusKind = kind || ''; }
  // the host's room asks for a password (told in his status, so he remembers to pass it on)
  function passwordNote() { return net && net.isHost && net.hostInfo && net.hostInfo.hasPassword ? '（已設定房間密碼）' : ''; }

  function clearRemoteModels() {
    for (var id in remoteModels) {
      scene.remove(remoteModels[id].group);
      remoteModels[id].dispose();
    }
    remoteModels = {}; remoteCars = {}; soft = {}; ghostNow = {};
    others.length = 0; otherIds.length = 0; mapOthers.length = 0; audioOthers.length = 0;
    impacts = {}; netHit = 0;
  }

  // Our car is on the pit lane's asphalt (lane, boxes, tapers): every other car is a ghost to it.
  function ownInPit() {
    var P = track && track.pit;
    if (!P) return false;
    var s = car.state;
    return typeof P.paved === 'function' ? !!P.paved(s.sampleIndex, s.d) : !!(s.inPit || (P.inLane && P.inLane(s.sampleIndex, s.d)));
  }
  // A remote car on the pit lane's asphalt (only looked up near the pit complex).
  function remoteInPit(st) {
    var b = pitBox;
    if (!b || !(st.x >= b.x0 && st.x <= b.x1 && st.z >= b.z0 && st.z <= b.z1)) return false;
    return !!track.pit.contains(st.x, st.z);
  }

  // The car a remote player drives (their pick resolved into the active season): livery and engine sound.
  function remoteCar(p, model, year) {
    var rc = remoteCars[p.id];
    if (!rc) rc = remoteCars[p.id] = { car: null, year: 0, colour: null, spec: null };
    if (rc.car !== p.car || rc.year !== year) {
      rc.car = p.car; rc.year = year;
      rc.spec = cars ? cars.resolve(p.car, year) : null;
      rc.colour = null;
      if (model.setHalo) model.setHalo(!rc.spec || rc.spec.cockpit !== 'modern');   // no halo before 2018, like the cockpit
    }
    if (rc.colour !== p.colour) {              // (setLivery allocates: only on a change)
      rc.colour = p.colour;
      if (rc.spec && model.setLivery) model.setLivery(rc.spec.colour, rc.spec.colour2, p.colour);
      else model.setColour(p.colour);
    }
    return rc;
  }

  // Interpolate the remote cars for this frame; fills `others` (collision), `mapOthers` (minimap), `audioOthers`.
  function updateRemotes(dt) {
    others.length = 0; otherIds.length = 0;
    var m = 0, a = 0, id;
    if (!inRoomTrack() || typeof F1.createCarModel !== 'function') {
      for (id in remoteModels) { clearRemoteModels(); break; }
      mapOthers.length = 0; audioOthers.length = 0;
      return;
    }
    net.update();
    var list = net.players, seen = {}, year = activeYear(), inPit = ownInPit();
    eye.x = car.state.x; eye.y = (car.state.y || 0) + 0.8; eye.z = car.state.z;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      seen[p.id] = true;
      var model = remoteModels[p.id];
      if (!model) {
        model = remoteModels[p.id] = F1.createCarModel(p.colour, p.name);
        scene.add(model.group);
      }
      var rc = remoteCar(p, model, year);
      model.setName(p.name);
      // Grand Prix ghosts (qualifying, spectators) and cars in the pit lane (ours or theirs): translucent, no
      // collisions. A car that stops being one only turns solid once it is clear of ours, so nothing jumps when two
      // cars overlap at that moment.
      var ghost = gp.isGhost(p.id) || inPit || (p.active && remoteInPit(p.state));
      if (ghost) soft[p.id] = true;
      else if (soft[p.id]) {
        var gx = p.state.x - car.state.x, gz = p.state.z - car.state.z;
        if (p.active && gx * gx + gz * gz > GHOST_CLEAR * GHOST_CLEAR) delete soft[p.id];
        else ghost = true;
      }
      if (ghost) ghostNow[p.id] = true; else delete ghostNow[p.id];
      if (model.setGhost) model.setGhost(ghost);
      model.group.visible = p.active;
      if (!p.active) continue;
      model.update(p.state, dt, eye);
      if (!ghost) {
        others.push(p.state);
        otherIds.push(p.id);
      }
      var o = mapOthers[m] || (mapOthers[m] = { x: 0, z: 0, colour: '' });
      o.x = p.state.x; o.z = p.state.z; o.colour = p.colour;
      m++;
      var s = audioOthers[a] || (audioOthers[a] = { id: 0, x: 0, y: 0, z: 0, heading: 0, speed: 0, spec: null });
      s.id = p.id; s.x = p.state.x; s.y = p.state.y || 0; s.z = p.state.z; s.heading = p.state.heading; s.speed = p.state.speed;
      s.spec = rc.spec;
      a++;
    }
    mapOthers.length = m;
    audioOthers.length = a;
    for (id in remoteModels) {
      if (!seen[id]) {
        scene.remove(remoteModels[id].group);
        remoteModels[id].dispose();
        delete remoteModels[id];
        delete remoteCars[id];
        delete soft[id];
        delete ghostNow[id];
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
      // (nothing is reported against a car that has become a ghost since the contact: Grand Prix or pit lane)
      if (r.sx * r.sx + r.sz * r.sz > 0.04 && !gp.isGhost(Number(id)) && !ghostNow[id]) { net.sendHit(Number(id), r.sx, r.sz); lastHitSend = now; }
      r.sx = 0; r.sz = 0;
    }
  }

  function onRemoteHit(from, imp) {
    if (!running || !inRoomTrack() || typeof F1.applyCarImpulse !== 'function') return;
    if (gp.inputLocked || gp.isGhost(from)) return;     // frozen on the grid / that car is not solid for us
    if (pit && pit.state.service) return;               // held in the pit box
    var k = otherIds.indexOf(from);
    if (k < 0) return;                        // (also: a ghost, or a former ghost that is not clear of our car yet)
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

  // What the room sees of us: name, colour and car.
  function sendProfile(p) {
    if (!net) return;
    p = p || (ui.getProfile ? ui.getProfile() : {});
    net.setProfile({ name: p.name, colour: p.colour, car: car && car.spec ? car.spec.id : undefined });
  }

  function initNet() {
    net = F1.net || null;
    if (!net) { refreshNetUi(); return; }
    sendProfile();

    net.on('connected', function () {
      netUi.lockText = '';
      setStatus(net.isHost ? HOST_PICK + passwordNote() : '已加入房間。', 'ok');
      // the host brings his season into the room (the answer is the 'year' event)
      if (net.isHost && net.setYear && isSeason(ownYear()) && net.year !== ownYear()) net.setYear(ownYear());
      refreshNetUi();
      pushCars();
    });
    // The room's season: everybody drives a car of it. (Fired after 'connected', before 'track', and on every change.)
    net.on('year', function (y) {
      var changed = applyCar();
      if (changed && car && !net.isHost && isSeason(y)) toast('房間是 ' + y + ' 賽季：你的車換成 ' + carName(car.spec), 6000);
      renderStill();
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
      pushCars();                             // (a new host may pick the year now)
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
      if (netUi.status === HOST_PICK + passwordNote()) setStatus('房間已建立，你是房主。' + passwordNote(), 'ok');   // the room has its track now
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
      applyCar();                             // back to our own season
      if (!running && renderer) renderer.render(scene, camera);
    });
    refreshNetUi();
  }

  function roomResult(res, what) {
    netUi.busy = false;
    if (!res || !res.ok) setStatus((res && res.error) || (what + '失敗'), 'err');
    refreshNetUi();
  }

  // opts.password (optional): the room's password. js/net.js takes it as create(port, {password}) /
  // join(address, {password}); an older js/net.js (one parameter) cannot, and a room is then not opened with one.
  function passwordOf(opts) {
    return opts && typeof opts.password === 'string' ? opts.password : '';
  }

  function createRoom(port, opts) {
    if (!net || netUi.busy) return;
    var pw = passwordOf(opts);
    if (pw && net.create.length < 2) { setStatus('這個版本不支援房間密碼，請清空密碼欄再建立房間', 'err'); refreshNetUi(); return; }
    netUi.busy = true;
    setStatus('正在建立房間…', '');
    refreshNetUi();
    var p = pw ? net.create(port, { password: pw }) : net.create(port);
    p.then(function (r) { roomResult(r, '建立房間'); }, function () { roomResult(null, '建立房間'); });
  }

  function joinRoom(address, opts) {
    if (!net || netUi.busy) return;
    if (!address) { setStatus('請輸入房主的 IP 位址', 'err'); refreshNetUi(); return; }
    var pw = passwordOf(opts);
    netUi.busy = true;
    setStatus('正在連線到 ' + address + ' …', '');
    refreshNetUi();
    var p = pw && net.join.length >= 2 ? net.join(address, { password: pw }) : net.join(address);
    p.then(function (r) { roomResult(r, '加入房間'); }, function () { roomResult(null, '加入房間'); });
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

  /* ---------- Grand Prix ---------- */

  var LAP_REJECTED = {                       // reason codes of net/session.js
    'too-fast': '圈速快得不合理', 'too-soon': '距離上一圈太近', 'inconsistent': '圈速和比賽時間對不上',
    'not-driven': '伺服器沒有看到你跑完這一圈', 'no-data': '這一圈的行車資料沒有傳到伺服器（連線不穩？）'
  };

  function toast(text, ms) { if (ui.toast) ui.toast(text, ms); }

  // The car of a classified driver, for the standings (team name, livery chip).
  function rowCar(r) {
    if (!cars) return null;
    if (r.isSelf) return car ? car.spec : null;
    var rc = remoteCars[r.id];
    if (rc && rc.spec) return rc.spec;
    var ro = net && net.roster ? net.roster : [];
    for (var i = 0; i < ro.length; i++) if (ro[i].id === r.id) return cars.resolve(ro[i].car, activeYear());
    return null;
  }

  // The session for the menu panel / HUD: gp.view() plus whether a Grand Prix can be started from here.
  function pushGp() {
    if (!gp || !ui.setGp) return;
    var v = gp.view(), room = !!(net && net.connected);
    v.sid = gp.sid;                           // a new session re-opens a closed results overlay
    // (the session says so after the lap counter has completed our last lap: lap.last / best are the counted ones)
    if (!(v.taking && (v.done || v.phase === 'results'))) lapsDone = null;
    else if (!lapsDone && lap) lapsDone = { last: roundMs(lap.last), best: roundMs(lap.best) };
    v.canStart = !!(track && car) && (!room || (net.isHost && inRoomTrack()));
    v.startHint = v.canStart ? '' : (room ? '先幫房間選一條賽道' : '先選一條賽道');
    for (var i = 0; v.rows && i < v.rows.length; i++) {
      var c = rowCar(v.rows[i]);
      if (c) { v.rows[i].team = c.teamZh || c.team; v.rows[i].colour2 = c.colour; }
    }
    ui.setGp(v);
    pushCars();                               // parc fermé: the car controls follow the session
  }

  // 開始大獎賽 in the menu panel. Alone: a track must be loaded; the host: the room's track.
  function startGp(cfg) {
    if (!track || !car || !canResume()) return;
    cfg = cfg || {};
    // the answer is the 'phase' event (in a room: from the server, whose session year is the room's)
    gp.start({ q: cfg.q, r: cfg.r, wear: cfg.wear, year: car.spec ? car.spec.year : undefined }, track.length);
  }

  // A phase of the Grand Prix put us on the track: out of the menu (keys held while driving stay held).
  function leaveMenu() { if (!running) resume(); }

  // 'race' needs nothing here: the lap counter is armed by 'go', which can come before or after it.
  function onGpPhase(phase, prev) {
    var s = gp.snapshot;
    var ready = !!(track && car && lap && canResume());   // the track the session runs on is loaded
    // the session's season decides the cars: ours follows it (parc fermé from here on)
    var switched = applyCar() && phase !== 'free';
    var carNote = switched ? '（' + activeYear() + ' 賽季：你的車換成 ' + carName(car.spec) + '）' : '';
    if (car && car.tyres) car.tyres.setWearRate(wearRate());
    if (phase === 'free') {
      if (track && car && lap) resetLap(car.state.sampleIndex);
      if (pit) pit.reset();
      toast('大獎賽已結束，回到自由練習');
      return;
    }
    if (!gp.taking) {
      // we joined a room whose Grand Prix is already on: our car is not moved, it roams as a ghost
      if (prev === 'free') toast('大獎賽進行中，你正在觀戰，下一場開始時才會加入' + carNote, 6000);
      return;
    }
    if (phase === 'quali') {
      if (!ready) return;
      resetLap(placeStart());                 // timing starts at the first crossing of the line
      freshStart();
      leaveMenu();
      toast('大獎賽開始：排位 ' + s.q + ' 圈，正賽 ' + s.r + ' 圈' + carNote, 6000);
    } else if (phase === 'grid') {
      if (!ready || gp.gridSlot < 0) return;
      resetLap(placeOnGrid(gp.gridSlot));     // frozen there until the lights go out (gp.inputLocked)
      freshStart();
      cockpit.centreLook();
      leaveMenu();
      toast('起跑位置 P' + (gp.gridSlot + 1) + ' / ' + s.grid.length + '，燈號全滅就起跑' + carNote, 6000);
    } else if (phase === 'results') {
      var v = gp.view(), me = v.pos > 0 ? v.rows[v.pos - 1] : null;
      toast(me && me.done ? '正賽結束：你是第 ' + v.pos + ' 名（共 ' + v.count + ' 位車手）' : '正賽結束：你沒有完賽', 6000);
    }
  }

  // Lights out (fired by gp.update() in frame()): the race clock runs from goAt, and the first crossing of the
  // line does not complete a lap.
  function onGpGo() {
    goFrame = true;
    if (!track || !car || !lap) return;
    lap.arm(car.state.sampleIndex);
    // The time since goAt at this frame's timestamp (lastT, set by frame() just before gp.update): includes the part
    // of the frame after goAt (see frame()). The lap clock goes on with the frames' timestamp differences, while a
    // room's session clock (net.serverNow) was read now, when the frame's callback runs, a little after its timestamp;
    // taken as it is, the race clock would run ahead of the session clock by that delay for the whole race.
    // (Alone the session clock is the game clock, fed with the same frame dts: nothing to correct.)
    lap.time = gp.sinceGo;
  }

  function onLapRejected(why) {
    toast('這一圈沒有被採計' + (LAP_REJECTED[why] ? '：' + LAP_REJECTED[why] : ''), 5000);
  }

  function initGp() {
    gp = F1.gp;
    gp.init({ net: F1.net || null, getProfile: ui.getProfile });
    gp.on('phase', onGpPhase);
    gp.on('go', onGpGo);
    gp.on('lapRejected', onLapRejected);
    gp.on('change', pushGp);
    pushGp();
  }

  /* ---------- pit lane ---------- */

  // One step of js/pit.js (every physics step, and every step the car is held for its service).
  function pitStep(dt) {
    var ev = pit.update(dt, car.state, track, pitOpt);
    if (ev) onPitEvent(ev);
  }

  function onPitEvent(ev) {
    if (ev === 'serviceStart') {
      car.state.speed = 0;                    // held in the box from here on (frame())
      if (audio) { audio.play('jack'); audio.play('pitgun'); }
    } else if (ev === 'serviceDone') {
      if (car.tyres) car.tyres.fit(nextCompound);
      if (audio) { audio.play('pitgun'); audio.play('jack', 0.6); }
      toast('換上新胎：' + (COMPOUND_NAME[nextCompound] || nextCompound) + '，出發！', 2500);
    } else if (ev === 'speeding') {
      toast('維修區超速（限速 ' + Math.round(pit.state.limitKmh) + ' km/h）：停站時罰停 5 秒', 5000);
    } else if (ev === 'exit' && limiterOn) {
      // (the limiter does not switch itself off: a car still held at the lane speed on the track looks broken)
      toast('已離開維修區：按 ' + (pad && pad.state.connected ? 'LB' : 'Q') + ' 關閉限速器', 4000);
    }
  }

  // A puncture (worn out, or from a hit): say so once - the telemetry's tyre icon alone is easy to miss, and only a
  // stop in the own box cures it (R does not).
  function checkTyres() {
    var pn = car.tyres ? car.tyres.state.puncture : -1;
    if (pn === puncture) return;
    puncture = pn;
    if (pn >= 0) toast((WHEEL_NAME[pn] || '輪胎') + '爆胎！開進維修區，停在你的維修格換胎', 6000);
  }

  // the pit lane speed limit of this track (km/h; 80 where there is no pit lane, as the limiter of js/car.js)
  function pitLimit() {
    var P = track && track.pit;
    return P && typeof P.limitKmh === 'number' && P.limitKmh > 0 ? P.limitKmh : 80;
  }

  function pushPit() {
    if (!ui.setPit) return;
    var st = pit ? pit.state : null;
    pitView.limiter = limiterOn;
    pitView.limitKmh = pitLimit();
    pitView.inLane = !!(st && st.inLane);
    pitView.speeding = !!(st && st.speeding);
    pitView.service = st ? st.service : null;
    pitView.boxAhead = st ? st.boxAhead : null;
    pitView.slot = st ? st.slot : -1;
    pitView.pending = st ? st.pending : 0;
    ui.setPit(pitView);
  }

  /* ---------- input ---------- */

  function clearInput() { input.up = input.down = input.left = input.right = false; boostKey = false; }

  function toggleLine() {
    lineOn = !lineOn;
    if (raceLine) raceLine.setVisible(lineOn);
  }

  function toggleLimiter() {
    limiterOn = !limiterOn;
    if (audio) audio.play(limiterOn ? 'limiterOn' : 'limiterOff');
  }

  // T / Back: the compound of the next set (fitted at the next stop in the pit box, or at the next start).
  function cycleCompound() {
    nextCompound = F1.Tyres && F1.Tyres.nextCompound ? F1.Tyres.nextCompound(nextCompound) : ({ S: 'M', M: 'H', H: 'S' })[nextCompound] || 'M';
    toast('下一組輪胎：' + (COMPOUND_NAME[nextCompound] || nextCompound) + '（進站換胎時裝上）', 2000);
  }

  function toggleMute() {
    var m = !(audio ? audio.muted : (ui.getAudio ? ui.getAudio().muted : false));
    if (audio) audio.setMuted(m);
    if (ui.setAudio) ui.setAudio({ muted: m });
    toast(m ? '已靜音（M）' : '聲音已開啟（M）', 1500);
  }

  // R / controller A: back onto the centreline at the car's current progress; timing keeps running.
  function resetCar() {
    if (gp.inputLocked) return;               // frozen on the grid
    if (pit && pit.state.service) return;     // held in the pit box
    // while the lap counter waits out an index jump (Suzuka's crossover) it knows better where the car is
    car.reset(track, lap.jumping ? lap.prevIdx : car.state.sampleIndex);
    lap.sync(car.state.sampleIndex);
  }

  // A field that takes the keys (text, numbers, the year select). A focused slider / switch of the 設定 tab is not
  // one: Esc resumes from there as from anywhere else in the menu.
  var NOT_TYPING = { range: 1, checkbox: 1, radio: 1, button: 1, submit: 1 };
  function isTyping(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    if (t.tagName === 'INPUT') return NOT_TYPING[String(t.type).toLowerCase()] !== 1;
    return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true;
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
    if (e.code === 'KeyE') { boostKey = true; return; }
    if (e.repeat) return;
    if (e.code === 'KeyL') toggleLine();
    else if (e.code === 'KeyR') resetCar();
    else if (e.code === 'KeyQ') toggleLimiter();
    else if (e.code === 'KeyT') cycleCompound();
    else if (e.code === 'KeyM') toggleMute();
  }

  function onKeyUp(e) {
    var k = KEYMAP[e.code];
    if (k) input[k] = false;
    else if (e.code === 'KeyE') boostKey = false;
  }

  // What car.update() gets this frame: keyboard + controller, battery (E / RB / B), limiter (the toggle).
  function driveInputs() {
    if (pad) pad.mergeInput(input, driveInput);
    else {
      driveInput.up = input.up; driveInput.down = input.down; driveInput.left = input.left; driveInput.right = input.right;
      driveInput.throttle = driveInput.brake = driveInput.steerAxis = null;
      driveInput.boost = false;
    }
    driveInput.boost = !!driveInput.boost || boostKey;
    driveInput.limiter = limiterOn;
    return driveInput;
  }

  // Held on the grid or in the pit box, car.update() does not run: the engine revs in neutral with the throttle, for
  // the sound, the steering wheel's rev lights and the telemetry. (Outputs of car.update only - it sets them again
  // from the pedals at its next step; the gear is left alone.)
  function revInNeutral(dt) {
    var s = car.state, spec = car.spec, d = driveInputs();
    s.throttle = Math.max(d.up ? 1 : 0, d.throttle > 0 ? Math.min(1, d.throttle) : 0);
    s.brake = Math.max(d.down ? 1 : 0, d.brake > 0 ? Math.min(1, d.brake) : 0);
    var target = spec.rpmIdle + s.throttle * 0.9 * (spec.rpmShift - spec.rpmIdle);
    if (!(s.rpm >= spec.rpmIdle)) s.rpm = spec.rpmIdle;
    s.rpm += (target - s.rpm) * Math.min(1, dt * (target > s.rpm ? 8 : 4));
    s.deploy = 0;
  }

  // Sound starts at boot where the page may play it (Electron); elsewhere at the first key / click / pad input.
  function kickAudio() {
    if (audioKicked || !audio) return;
    audioKicked = true;
    try { audio.init(); } catch (err) { /* no sound */ }
    window.removeEventListener('keydown', kickAudio, true);
    window.removeEventListener('pointerdown', kickAudio, true);
  }

  /* ---------- controller ---------- */

  // Once per frame. The buttons act like their keys: Start = Esc, A / Y = R, X = L, LB = Q, Back = T; the right stick
  // turns the driver's head, a click on it looks straight ahead again. -> false when Start opened the menu.
  function pollPad() {
    var ps = pad.poll();
    if (ps.pressed.menu) { exitToMenu(); return false; }
    if (!audioKicked && pad.active) kickAudio();
    cockpit.setLook(ps.lookX, ps.lookY);      // (0, 0 without a controller)
    if (ps.pressed.recentre) cockpit.centreLook();
    if (ps.pressed.line) toggleLine();
    if (ps.pressed.reset) resetCar();
    if (ps.pressed.limiter) toggleLimiter();
    if (ps.pressed.compound) cycleCompound();
    return true;
  }

  // The loop does not run while the menu is open: poll from a timer so that Start resumes, as Esc does.
  // (Often enough that a press is never swallowed by gamepad.js's 500 ms edge resync.)
  function pollPadInMenu() {
    if (running) return;
    if (pad.poll().pressed.menu && canResume()) resume();
  }

  function initPad() {
    pad = F1.gamepad || null;
    if (!pad) return;
    pad.onChange = function (connected, id) {
      if (ui.setPad) ui.setPad(connected, id);
      toast(connected ? '手把已連接' : '手把已中斷連線');
    };
    pad.poll();
    if (ui.setPad) ui.setPad(pad.state.connected, pad.state.id);
    setInterval(pollPadInMenu, PAD_MENU_MS);
  }

  /* ---------- HUD ---------- */

  // A completed lap, to the millisecond as the session and the room round it (the HUD would cut it off instead,
  // and the timing box would then show 1 ms less than the standings for the same lap).
  function roundMs(t) { return t == null ? null : Math.round(t * 1000) / 1000; }

  function pushHUD() {
    var s = car.state, spec = car.spec;
    hud.speedKmh = Math.abs(s.speed) * 3.6;
    hud.gear = s.gear;                        // -1 R, 0 N, 1..n
    if (gp.lapTotal > 0) {                    // in a session: the lap we are on, of the session's target
      hud.lap = Math.min(gp.lap + 1, gp.lapTotal);
      hud.lapTotal = gp.lapTotal;
    } else {
      hud.lap = lap.n;
      hud.lapTotal = null;
    }
    if (lapsDone) {                           // our laps of this Grand Prix phase are done: the timing box stops there
      hud.curTime = null;
      hud.lastTime = lapsDone.last;
      hud.bestTime = lapsDone.best;
    } else {
      hud.curTime = lap.started ? lap.time : null;
      hud.lastTime = roundMs(lap.last);
      hud.bestTime = roundMs(lap.best);
    }
    hud.x = s.x; hud.z = s.z; hud.heading = s.heading;
    hud.others = mapOthers.length ? mapOthers : null;
    // the broadcast graphic (js/telemetry.js)
    hud.rpm = s.rpm; hud.rpmIdle = spec.rpmIdle; hud.rpmShift = spec.rpmShift; hud.rpmMax = spec.rpmMax;
    hud.throttle = s.throttle; hud.brake = s.brake;
    hud.battery = spec.ers ? s.battery : null;
    hud.deploy = s.deploy; hud.harvest = s.harvest;
    hud.limiter = limiterOn;
    hud.inPit = !!(pit ? pit.state.inLane : s.inPit);
    hud.limitKmh = pitLimit();
    hud.tyres = car.tyres ? car.tyres.state : null;
    hud.nextCompound = nextCompound;
    hud.team = spec.team; hud.car = spec.car; hud.colour = spec.colour; hud.colour2 = spec.colour2;
    ui.updateHUD(hud);
    pushPit();
  }

  // The driver's ears: the head in the cockpit, turned with the head look.
  function updateAudio(dt) {
    var s = car.state;
    listener.x = s.x; listener.y = (s.y || 0) + 0.8; listener.z = s.z;
    listener.heading = s.heading + (camera.rotation.y - Math.PI);    // the camera's yaw in the cockpit = the head look
    audio.update(dt, s, listener, audioOthers);
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
      // the controller first: Start opens the menu before this frame counts for anything (the session clock
      // included), exactly as Esc does between two frames
      if (pad && !pollPad()) return;
      goFrame = false;
      gp.update(dt);                          // session clock, start lights; fires 'go'
      // Grand Prix grid: the car stands still while the lights are on, and in the frame in which they go out
      // too: 'go' has just set the lap clock to the time since lights out, which already covers this frame.
      // (So the lap clock stays in step with the session clock, whichever of 'go' and the race phase comes first.)
      var frozen = gp.inputLocked || goFrame;
      var mp = inRoomTrack();
      if (mp || mapOthers.length) updateRemotes(dt);
      var collide = others.length && typeof F1.resolveCarCollisions === 'function';
      var hit = netHit, stepped = false;
      netHit = 0;
      pitOpt.slot = net && net.connected ? net.slot || 0 : 0;
      pitOpt.limiter = limiterOn;
      if (frozen) {
        // no physics at all: the car does not roll on a slope either, and held keys wait for the lights
        acc = 0;
        car.state.speed = 0; car.state.hit = 0;
        revInNeutral(dt);
      } else {
        var drive = driveInputs();
        // fixed physics steps so the car and lap clock keep real-time pace at low frame rates
        acc += dt;
        while (acc >= STEP) {
          acc -= STEP;
          if (pit && pit.state.service) {
            // held in the pit box for the tyre change, like on the grid (no physics, R ignored); the lap clock runs
            // on (a stop costs time) and the service counts down
            car.state.speed = 0; car.state.hit = 0; car.state.gear = 0;   // (neutral while the car is up on the jacks)
            pitStep(STEP);
            lap.update(car.state.sampleIndex, 0, STEP);
            continue;
          }
          car.update(STEP, drive, track);
          // our car against the other players' cars; the next car.update re-clamps against the walls
          if (collide) {
            var hc = F1.resolveCarCollisions(car.state, others, STEP, contacts);
            if (hc > 0 && car.bump) car.bump(hc);     // the tyres feel it at the next step
          }
          if (car.state.hit > hit) hit = car.state.hit;
          stepped = true;
          if (pit) pitStep(STEP);
          if (lap.update(car.state.sampleIndex, car.state.speed, STEP) === 2) {
            gp.lapDone(lap.last);
            // alone, the last qualifying lap puts us on the grid at once: nothing more moves this frame
            if (gp.inputLocked) { acc = 0; break; }
          }
        }
        if (pit && pit.state.service) revInNeutral(dt);
        if (stepped) {
          car.state.hit = hit;                // strongest impact of the frame (car.update clears it every step)
          if (pad && hit > RUMBLE_MIN) pad.rumble(Math.min(1, 0.2 + hit), 120 + 280 * hit);   // walls and cars
        } else netHit = hit;
      }
      if (mp) collectContacts(performance.now());
      checkTyres();
      cockpit.update(car.state, dt);
      gp.setProgress(lap.progress(car.state.sampleIndex));   // race distance, rides along with the state
      if (mp) {
        net.sendState(car.state);
        shareLap();
      }
      if (raceLine && lineOn) raceLine.update(car.state);
      if (track.update) track.update(t / 1000);   // light curtains of the pit lane
      if (sky && sky.update) sky.update(camera);
      // start lights: for everybody on the session's track, spectators too (they watch: another caption); a beep for
      // every lamp that comes on and at lights out
      var showLights = (gp.phase === 'grid' || gp.goFlash) && (mp || !gp.online);
      var lamps = showLights ? gp.lights : -1, lightsGo = showLights && gp.goFlash;
      if (ui.setLights) ui.setLights(lamps, gp.goFlash, !gp.taking);
      if (audio) {
        if (lamps > beepLights && lamps > 0) audio.beep('light');
        if (lightsGo && !beepGo) audio.beep('go');
        updateAudio(dt);
      }
      beepLights = lamps; beepGo = lightsGo;
      pushHUD();
      renderer.render(scene, camera);
    } catch (err) {
      running = false;
      cancelAnimationFrame(rafId); rafId = 0;
      if (audio) audio.setActive(false);
      fail('執行時發生錯誤：\n' + (err && err.stack ? err.stack : err));
    }
  }

  /* ---------- boot ---------- */

  function initCars() {
    cars = F1.cars && typeof F1.cars.resolve === 'function' ? F1.cars : null;
    if (cars) for (var i = 0; i < cars.seasons.length; i++) seasonYears[cars.seasons[i].year] = true;
    car = F1.createCar(cars ? cars.resolve(ui.getCar ? ui.getCar() : null, ownYear()) : undefined);
    // the credits line: F1DB's full attribution on hover
    var cr = document.querySelector('.brand .credits'), at = cars && cars.attribution;
    if (cr && at && at.f1db) cr.title = at.f1db + (at.sources2026 ? '\n' + at.sources2026 : '');
  }

  function initAudio() {
    audio = F1.audio && typeof F1.audio.update === 'function' && F1.audio.supported !== false ? F1.audio : null;
    if (!audio) return;
    var a = ui.getAudio ? ui.getAudio() : null;
    if (a) { audio.setVolume(a.volume); audio.setMuted(a.muted); }
    audio.setEngine(car.spec);
    // Electron lets the page start sound at once; a browser waits for the first key / click (kickAudio)
    try { audio.init(); } catch (err) { /* no sound */ }
    window.addEventListener('keydown', kickAudio, true);
    window.addEventListener('pointerdown', kickAudio, true);
  }

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
      onProfile: function (p) {
        if (F1.net) sendProfile(p);
        if (cockpit && cockpit.setCar && car) cockpit.setCar(car.spec, p && p.colour);   // the accent is our colour
        pushGp();
      },
      onGpStart: startGp,
      onGpAction: function (a) { gp.action(a); },
      onYear: onPickYear,
      onCar: onPickCar,
      onAudio: function (a) { if (audio && a) { audio.setVolume(a.volume); audio.setMuted(a.muted); } }
    });
    initCars();
    if (typeof F1.createPit === 'function') pit = F1.createPit();
    initAudio();
    initGp();                                 // before initNet: the session hears the room's events before we do
    initPad();
    initNet();
    applyCar();
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
    get running() { return running; }, get camera() { return camera; }, get remoteModels() { return remoteModels; },
    get gp() { return gp; }, get lap() { return lap; }, get input() { return input; }, get raceLine() { return raceLine; },
    get cockpit() { return cockpit; }, get pit() { return pit; }, get tyres() { return car ? car.tyres : null; },
    get spec() { return car ? car.spec : null; }, get audio() { return audio; },
    get limiter() { return limiterOn; }, get boost() { return boostKey; }, get nextCompound() { return nextCompound; },
    get remoteCars() { return remoteCars; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
