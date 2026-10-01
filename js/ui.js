/* F1.ui — menu (track picker; side panel with the tabs 車輛 (year + that year's cars), 大獎賽, 多人連線, 設定 (volume,
   HUD mirrors)) + HUD (lap times, minimap, player list, Grand Prix session box, start lights, results, pit lane strip;
   speed, gear, pedals, battery and tyres are the telemetry graphic of js/telemetry.js, drawn from updateHUD; the two
   HUD rear-view mirrors are drawn by js/hudmirrors.js into the frames #hud-mirror-l / -r, laid out by index.html).
   Classic script; uses F1.telemetry when it is loaded, F1.cars.ersNote for the battery line of the car cards. */
(function () {
  'use strict';
  var F1 = (window.F1 = window.F1 || {});

  var el = {};
  var callbacks = {
    onSelectTrack: null, onExitToMenu: null,
    onCreateRoom: null, onJoinRoom: null, onLeaveRoom: null, onProfile: null,
    onGpStart: null, onGpAction: null,
    onYear: null, onCar: null, onAudio: null, onMirrors: null
  };
  var inited = false;
  var tele = null;          // F1.telemetry once init() found it and its canvas

  // side panel tabs (the open one is remembered)
  var MENU_STORE_KEY = 'f1drive.menu';
  var TABS = ['car', 'gp', 'mp', 'set'];
  var tab = 'gp';

  // 車輛: the year's cars (setCars) and the player's own pick (remembered)
  var CAR_STORE_KEY = 'f1drive.car';
  var YEAR_MIN = 2010, YEAR_MAX = 2100;
  var CAR_ID_RE = /^[a-z0-9-]{1,40}$/;
  var RATING_KEYS = ['topSpeed', 'accel', 'cornering', 'braking', 'ers'];
  var RATING_NAMES = ['極速', '加速', '過彎', '煞車', '電池'];
  var pick = { year: null, car: null };  // what the player chose last (getYear / getCar)
  var carsView = null;      // last object given to setCars
  var carsYear = null;      // year of the list on screen
  var carSel = null;        // id highlighted in the list
  var carById = {};         // id -> CarSpec of the list on screen (own properties only)
  var canPick = { year: false, car: false };   // what the controls allow right now (flags of setCars, no session)

  // 設定: audio
  var AUDIO_STORE_KEY = 'f1drive.audio';
  var audio = { volume: 0.8, muted: false };

  // 設定: the HUD rear-view mirrors (on by default, remembered); `available` false when the game cannot draw them
  // (main.js: js/hudmirrors.js missing / failed): the switch is disabled and the HUD laid out without them
  var VIEW_STORE_KEY = 'f1drive.hud';
  var view = { mirrors: true, available: true };

  // pit strip: the last input, in the units shown (setPit is called every frame)
  var pitC = { shown: false, inLane: false, limiter: false, speeding: false, limit: 0, slot: -1, box: 0,
    tenths: -1, frac: -1, pen: -1, penNow: false, pending: -1, served: false, pad: false };
  var PIT_NONE = {};
  var PIT_BOX_HIDDEN = -99999;

  // menu state
  var builtFor = null;      // tracks array the grid was built for
  var cards = [];           // [{node, key}]
  var trackById = {};

  // minimap state
  var MAP_CSS = 190, MAP_PAD = 14;
  var mapBase = null;       // offscreen canvas with the pre-rendered outline
  var mapCtx = null;
  var mapPx = 0, mapRatio = 1;
  var mapScale = 1, mapOx = 0, mapOz = 0;

  // multiplayer panel state
  var STORE_KEY = 'f1drive.mp';
  var COLOURS = ['#ff7a14', '#e10600', '#1e6bff', '#19c8e6', '#35d07f', '#ffd21e', '#c04bff', '#f2f4f7'];
  var DEFAULT_PORT = 24500;
  var mp = { name: '', colour: COLOURS[0], addr: '', port: DEFAULT_PORT };
  var netView = {};         // last object given to setNet
  var gridLocked = false;
  var nameTimer = 0, toastTimer = 0, ipReq = 0;

  // Grand Prix panel / HUD session box state
  var GP_STORE_KEY = 'f1drive.gp';
  var GP_Q_MAX = 20, GP_R_MAX = 99;
  var PHASE_NAME = { quali: '排位賽', grid: '起跑', race: '正賽', results: '成績' };
  var WEAR_MAX = 5;
  var gpCfg = { q: 3, r: 5, wear: 1 };   // laps typed into the panel and the tyre wear multiplier (remembered)
  var gpView = {};              // last object given to setGp
  var gpOn = false;             // a session is on: the session box replaces the room roster box in the HUD
  var gpPhase = 'free';         // phase of the last setGp (a session starting opens the 大獎賽 tab, locks the cars)
  var inGpRender = false;
  var gpKey = '';               // phase (+ session) the 關閉 of the results overlay belongs to
  var gpClosed = false;
  var gpEndsAt = 0;             // performance.now() time at which the race closes, 0 = no countdown
  var lightsN = -1, lightsGo = false, lightsWatch = false;
  var padOn = false, padId = '';

  // HUD text cache (only touch the DOM when the string changed)
  var cache = {};

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setText(key, node, str) {
    if (cache[key] !== str) {
      cache[key] = str;
      if (node) node.textContent = str;
    }
  }

  function setHtml(key, node, html) {
    if (cache[key] !== html) {
      cache[key] = html;
      if (node) node.innerHTML = html;
    }
  }

  // show / hide through the .hidden class
  function setShown(key, node, on) {
    on = !!on;
    if (cache[key] !== on) {
      cache[key] = on;
      if (node) node.classList.toggle('hidden', !on);
    }
  }

  function cleanColour(c) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#888888'; }
  function isColour(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c); }

  // className through the cache (the pit strip's chips change colour)
  function setClass(key, node, cls) {
    if (cache[key] !== cls) {
      cache[key] = cls;
      if (node) node.className = cls;
    }
  }

  function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

  // a season: a whole number 2010..2100, else null (never clamped: a clamped year would be another season)
  function cleanYear(v) {
    var n = typeof v === 'string' && v.trim() ? Number(v) : v;
    return typeof n === 'number' && Math.floor(n) === n && n >= YEAR_MIN && n <= YEAR_MAX ? n : null;
  }

  function cleanCarId(v) { return typeof v === 'string' && CAR_ID_RE.test(v) ? v : null; }

  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '--';
    if (t < 0) t = 0;
    var ms = Math.floor(t * 1000 + 1e-6);
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var r = ms % 1000;
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + (r < 10 ? '00' : r < 100 ? '0' : '') + r;
  }

  // gap to the leader: "+1.234", from a minute on "+1:02.345"
  function fmtGap(g) {
    if (!(g > 0)) g = 0;
    return '+' + (g < 60 ? (Math.floor(g * 1000 + 1e-6) / 1000).toFixed(3) : fmtTime(g));
  }

  function bounds(points) {
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (var i = 0; i < points.length; i++) {
      var x = points[i][0], z = points[i][1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (!isFinite(minX)) { minX = maxX = minZ = maxZ = 0; }
    return { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ, w: Math.max(maxX - minX, 1), h: Math.max(maxZ - minZ, 1) };
  }

  /* ---------- menu ---------- */

  function thumbSvg(points) {
    if (!points || points.length < 2) return '<svg viewBox="0 0 10 10"></svg>';
    var b = bounds(points);
    // normalise to a ~1000-unit box so coordinates stay short; x -> right, z -> down
    var k = 1000 / Math.max(b.w, b.h);
    var w = Math.round(b.w * k), h = Math.round(b.h * k), pad = 40;
    var d = '';
    for (var i = 0; i < points.length; i++) {
      d += (i ? 'L' : 'M') + Math.round((points[i][0] - b.minX) * k) + ' ' + Math.round((points[i][1] - b.minZ) * k);
    }
    d += 'Z';
    var sx = Math.round((points[0][0] - b.minX) * k), sz = Math.round((points[0][1] - b.minZ) * k);
    return '<svg viewBox="' + (-pad) + ' ' + (-pad) + ' ' + (w + pad * 2) + ' ' + (h + pad * 2) +
      '" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="' + d + '"/>' +
      '<circle cx="' + sx + '" cy="' + sz + '" r="' + Math.round(Math.max(w, h) * 0.035 + 8) + '"/></svg>';
  }

  function fmtKm(v) {
    var n = Number(v);
    return isFinite(n) ? n.toFixed(3) + ' km' : '';
  }

  function buildGrid(tracks) {
    builtFor = tracks;
    cards = [];
    trackById = {};
    var html = '';
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      html += '<button type="button" class="card" data-i="' + i + '">' + thumbSvg(t.points) +
        '<div class="card-info"><div class="card-name">' + esc(t.name) + '</div>' +
        '<div class="card-meta"><span>' + esc(t.location) + '</span><b>' + fmtKm(t.lengthKm) + '</b></div></div></button>';
    }
    el.grid.innerHTML = html;
    var nodes = el.grid.children;
    for (var j = 0; j < nodes.length; j++) {
      var tr = tracks[j];
      cards.push({ node: nodes[j], key: ((tr.name || '') + ' ' + (tr.location || '') + ' ' + (tr.id || '')).toLowerCase() });
    }
    applyFilter();
  }

  function applyFilter() {
    var q = (el.search.value || '').trim().toLowerCase();
    var terms = q ? q.split(/\s+/) : [];
    var shown = 0;
    for (var i = 0; i < cards.length; i++) {
      var ok = true;
      for (var k = 0; k < terms.length; k++) {
        if (cards[i].key.indexOf(terms[k]) < 0) { ok = false; break; }
      }
      cards[i].node.classList.toggle('hidden', !ok);
      if (ok) shown++;
    }
    el.empty.classList.toggle('hidden', shown > 0);
    el.count.textContent = terms.length ? shown + ' / ' + cards.length + ' 條賽道' : cards.length + ' 條賽道';
  }

  /* ---------- multiplayer panel ---------- */

  function loadStore() {
    try {
      var o = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
      if (o && typeof o === 'object') {
        if (typeof o.name === 'string') mp.name = o.name.slice(0, 16);
        if (typeof o.colour === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.colour)) mp.colour = o.colour.toLowerCase();
        if (typeof o.addr === 'string') mp.addr = o.addr.slice(0, 255);
        var pt = Number(o.port);
        if (pt >= 1024 && pt <= 65535 && Math.floor(pt) === pt) mp.port = pt;
      }
    } catch (err) { /* storage unavailable or corrupt: defaults */ }
    if (!mp.name.trim()) mp.name = '車手' + (100 + Math.floor(Math.random() * 900));
  }

  function saveStore() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(mp)); } catch (err) { /* ignore */ }
  }

  function sendProfile() {
    clearTimeout(nameTimer); nameTimer = 0;
    saveStore();
    if (callbacks.onProfile) callbacks.onProfile({ name: mp.name, colour: mp.colour });
  }

  function buildSwatches() {
    var html = '';
    for (var i = 0; i < COLOURS.length; i++) {
      html += '<button type="button" class="mp-swatch" data-c="' + COLOURS[i] + '" style="background:' + COLOURS[i] +
        '" aria-label="車色 ' + (i + 1) + '"></button>';
    }
    el.mpColours.innerHTML = html;
    markSwatch();
  }

  function markSwatch() {
    var n = el.mpColours.children;
    for (var i = 0; i < n.length; i++) n[i].classList.toggle('on', n[i].getAttribute('data-c') === mp.colour);
  }

  function playerRows(roster, withTimes) {
    var html = '';
    for (var i = 0; i < roster.length; i++) {
      var r = roster[i];
      var colour = /^#[0-9a-fA-F]{6}$/.test(r.colour) ? r.colour : '#888888';
      if (withTimes) {
        html += '<div class="prow"><span class="mp-dot" style="background:' + colour + '"></span>' +
          '<span class="mp-pname">' + esc(r.name) + '</span><span class="pt">' + fmtTime(r.best) + '</span></div>';
      } else {
        html += '<li><span class="mp-dot" style="background:' + colour + '"></span>' +
          '<span class="mp-pname">' + esc(r.name) + '</span>' +
          (r.isSelf ? '<span class="mp-tag">你</span>' : '') +
          (r.isHost ? '<span class="mp-tag">房主</span>' : '') + '</li>';
      }
    }
    return html;
  }

  function showPublicIp() {
    var req = ++ipReq, port = (netView.hostInfo && netView.hostInfo.port) || DEFAULT_PORT;
    el.mpPubOut.innerHTML = '<p class="mp-note">查詢中…</p>';
    var fail = function () {
      if (req !== ipReq) return;
      el.mpPubOut.innerHTML = '<p class="mp-note">查不到公網 IP（沒有網路或服務無回應）。可以用瀏覽器搜尋「what is my ip」，' +
        '再把查到的 IP 加上 :' + port + ' 給朋友。</p>';
    };
    try {
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); fail(); }, 7000);
      fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http')); })
        .then(function (j) {
          clearTimeout(timer);
          if (req !== ipReq) return;
          var ip = j && typeof j.ip === 'string' ? j.ip : '';
          if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) { fail(); return; }
          var shown = ip.indexOf(':') >= 0 ? '[' + ip + ']:' + port : ip + ':' + port;
          el.mpPubOut.innerHTML = '<span class="mp-addr">' + esc(shown) + '</span>';
        })
        .catch(function () { clearTimeout(timer); fail(); });
    } catch (err) { fail(); }
  }

  function renderNet() {
    if (!inited) return;
    var v = netView, connected = !!v.connected, busy = !!v.busy, roster = v.roster || [];
    el.mpOffline.classList.toggle('hidden', connected);
    el.mpOnline.classList.toggle('hidden', !connected);
    el.mpCreate.disabled = busy || !v.canCreate;
    el.mpPort.disabled = busy || !v.canCreate;
    el.mpJoin.disabled = busy;
    el.mpAddr.disabled = busy;
    if (el.mpCreatePass) el.mpCreatePass.disabled = busy || !v.canCreate;
    if (el.mpJoinPass) el.mpJoinPass.disabled = busy;
    el.mpCreateNote.classList.toggle('hidden', !!v.canCreate);
    if (!v.canCreate) {
      el.mpCreateNote.textContent = '瀏覽器版無法建立房間（需要桌面版 F1Drive.exe 才能開伺服器），但仍然可以加入別人的房間。';
    }

    var status = v.status || '';
    el.mpStatus.textContent = status;
    el.mpStatus.className = status ? (v.statusKind || '') : 'hidden';

    var hosting = connected && v.isHost && v.hostInfo;
    el.mpHost.classList.toggle('hidden', !hosting);
    if (hosting) {
      var port = v.hostInfo.port, list = v.hostInfo.addresses || [], html = '';
      for (var i = 0; i < list.length; i++) html += '<span class="mp-addr">' + esc(list[i] + ':' + port) + '</span>';
      if (!html) html = '<p class="mp-note">找不到區域網路位址（沒有連上網路？）</p>';
      if (cache.lan !== html) { cache.lan = html; el.mpLan.innerHTML = html; }
      setText('portnote', el.mpPortNote, String(port));
    } else if (!connected) {
      ipReq++;
      if (el.mpPubOut.firstChild) el.mpPubOut.innerHTML = '';
    }

    if (connected) {
      setText('ptitle', el.mpPlayersTitle, '玩家（' + roster.length + ' / 16）');
      var rows = playerRows(roster, false);
      if (cache.prows !== rows) { cache.prows = rows; el.mpPlayers.innerHTML = rows; }
    }

    // track grid: only the host picks
    gridLocked = connected && !v.isHost;
    el.grid.classList.toggle('locked', gridLocked);
    var lock = connected ? (v.isHost ? '你是房主：點選賽道，房間裡所有人會一起載入並回到起跑格。' :
      (v.roomTrack ? '賽道由房主選擇；房主換賽道時，所有人會一起載入。' : '等待房主選擇賽道…')) : '';
    if (connected && v.lockText) lock = v.lockText;
    el.lock.textContent = lock;
    el.lock.classList.toggle('hidden', !lock);

    // HUD player list
    var hudRows = connected ? playerRows(roster, true) : '';
    if (cache.hudrows !== hudRows) { cache.hudrows = hudRows; el.hudPlayers.innerHTML = hudRows; }
    showRoster();
    setShown('tabmp', el.tabMpDot, connected);   // the 多人連線 tab says we are in a room
  }

  // The room roster box gives way to the session box while a Grand Prix is on.
  function showRoster() {
    el.hudPlayers.classList.toggle('hidden', !cache.hudrows || gpOn);
  }

  // the room password typed in (create / join); '' = none. Never stored.
  function passOf(input) { return input && typeof input.value === 'string' ? input.value : ''; }

  function initNetPanel() {
    loadStore();
    el.mpName.value = mp.name;
    el.mpAddr.value = mp.addr;
    el.mpPort.value = String(mp.port);
    buildSwatches();

    el.mpName.addEventListener('input', function () {
      mp.name = el.mpName.value;
      clearTimeout(nameTimer);
      nameTimer = setTimeout(sendProfile, 500);
    });
    el.mpName.addEventListener('change', function () {
      if (!el.mpName.value.trim()) el.mpName.value = mp.name = '車手' + (100 + Math.floor(Math.random() * 900));
      else mp.name = el.mpName.value;
      sendProfile();
    });
    el.mpColours.addEventListener('click', function (e) {
      var c = e.target && e.target.getAttribute && e.target.getAttribute('data-c');
      if (!c) return;
      mp.colour = c;
      markSwatch();
      sendProfile();
    });
    var create = function () {
      if (el.mpCreate.disabled) return;
      var pt = Number(el.mpPort.value);
      if (pt >= 1024 && pt <= 65535 && Math.floor(pt) === pt) { mp.port = pt; }
      sendProfile();
      if (callbacks.onCreateRoom) callbacks.onCreateRoom(el.mpPort.value === '' ? DEFAULT_PORT : pt, { password: passOf(el.mpCreatePass) });
    };
    var join = function () {
      if (el.mpJoin.disabled) return;
      mp.addr = el.mpAddr.value.trim();
      sendProfile();
      if (callbacks.onJoinRoom) callbacks.onJoinRoom(mp.addr, { password: passOf(el.mpJoinPass) });
    };
    el.mpCreate.addEventListener('click', create);
    el.mpJoin.addEventListener('click', join);
    el.mpPort.addEventListener('keydown', function (e) { if (e.key === 'Enter') create(); });
    el.mpAddr.addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
    if (el.mpCreatePass) el.mpCreatePass.addEventListener('keydown', function (e) { if (e.key === 'Enter') create(); });
    if (el.mpJoinPass) el.mpJoinPass.addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
    el.mpLeave.addEventListener('click', function () { if (callbacks.onLeaveRoom) callbacks.onLeaveRoom(); });
    el.mpPub.addEventListener('click', showPublicIp);

    renderNet();
  }

  /* ---------- Grand Prix: menu panel, HUD session box, start lights, results ---------- */

  // A lap count typed by the user / read from storage -> integer 1..max; `def` when it is not a number at all.
  function cleanLaps(v, max, def) {
    if (typeof v === 'string') { if (!v.trim()) return def; }
    else if (typeof v !== 'number') return def;
    var n = Math.round(Number(v));
    if (!isFinite(n)) return def;
    return n < 1 ? 1 : (n > max ? max : n);
  }

  // tyre wear multiplier: a whole 1..5, `def` when it is not a number
  function cleanWear(v, def) {
    var n = typeof v === 'number' ? Math.round(v) : NaN;
    return isFinite(n) ? (n < 1 ? 1 : n > WEAR_MAX ? WEAR_MAX : n) : def;
  }

  function loadGpStore() {
    try {
      var o = JSON.parse(window.localStorage.getItem(GP_STORE_KEY) || 'null');
      if (o && typeof o === 'object') {
        gpCfg.q = cleanLaps(o.q, GP_Q_MAX, gpCfg.q);
        gpCfg.r = cleanLaps(o.r, GP_R_MAX, gpCfg.r);
        gpCfg.wear = cleanWear(o.wear, gpCfg.wear);
      }
    } catch (err) { /* storage unavailable or corrupt: defaults */ }
  }

  function saveGpStore() {
    try { window.localStorage.setItem(GP_STORE_KEY, JSON.stringify(gpCfg)); } catch (err) { /* ignore */ }
  }

  // Fields -> gpCfg (clamped), and the cleaned values back into the fields.
  function commitLaps() {
    gpCfg.q = cleanLaps(el.gpQ.value, GP_Q_MAX, gpCfg.q);
    gpCfg.r = cleanLaps(el.gpR.value, GP_R_MAX, gpCfg.r);
    el.gpQ.value = String(gpCfg.q);
    el.gpR.value = String(gpCfg.r);
    saveGpStore();
  }

  function count(n) { n = Math.floor(Number(n)); return n > 0 ? n : 0; }

  // Fastest race lap of the field (shown in purple), null when nobody has a lap yet.
  function fastestLap(rows) {
    var best = null;
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i] && rows[i].best;
      if (typeof b === 'number' && b > 0 && (best === null || b < best)) best = b;
    }
    return best;
  }

  // Race / results: what a driver's gap column says. lead = first of the classification; final = results.
  function gapText(r, lead, final) {
    if (r.left && !r.done) return '離線';
    if (r.dnf || (final && !r.done)) return '未完賽 DNF';
    if (lead) return r.done ? '完賽' : '領先';
    if (r.down > 0) return '+' + count(r.down) + ' 圈';
    if (typeof r.gap === 'number' && isFinite(r.gap)) return fmtGap(r.gap);
    return r.done ? '完賽' : '--';
  }

  // The driver's car, when main.js puts it into the view rows (optional): a livery chip (row.colour2) and the
  // team / car name (row.team; only where there is room for it).
  function carChip(r) { return isColour(r.colour2) ? '<span class="gp-chip" style="background:' + r.colour2 + '"></span>' : ''; }
  function carTeam(r) { return typeof r.team === 'string' && r.team ? '<span class="gp-team">' + esc(r.team) + '</span>' : ''; }

  // Standings rows for the menu panel and the HUD session box. Qualifying / grid: best lap (qualifying also
  // laps done); race: gap to the leader; results: the winner's total time, then gaps (withBest: + best lap).
  // withTeam: the car's name after the driver's (menu panel only; the HUD box is too narrow).
  function gpRowsHtml(v, phase, withBest, withTeam) {
    var rows = v.rows || [], html = '';
    var race = phase === 'race', final = phase === 'results';
    var fl = withBest ? fastestLap(rows) : null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {}, val, sub = '', out = false;
      if (race || final) {
        out = final ? !r.done : !!(r.dnf || (r.left && !r.done));
        val = final && i === 0 && r.done && r.time != null ? fmtTime(r.time) : gapText(r, i === 0, final);
      } else {
        val = fmtTime(r.best);
        if (phase === 'quali') sub = r.done ? '完成' : count(r.laps) + (v.q > 0 ? '/' + count(v.q) : ' 圈');
      }
      html += '<div class="gp-row' + (r.isSelf ? ' self' : '') + (out ? ' out' : '') + '">' +
        '<span class="gp-pos">' + (count(r.pos) || i + 1) + '</span>' +
        '<span class="mp-dot" style="background:' + cleanColour(r.colour) + '"></span>' + carChip(r) +
        '<span class="mp-pname">' + esc(r.name) + '</span>' + (withTeam ? carTeam(r) : '') +
        (sub ? '<span class="gp-sub">' + sub + '</span>' : '') +
        '<span class="gp-val">' + val + '</span>' +
        (withBest ? '<span class="gp-best' + (fl !== null && r.best === fl ? ' fl' : '') + '">' + fmtTime(r.best) + '</span>' : '') +
        '</div>';
    }
    return html;
  }

  // Final classification for the results overlay.
  function resultsHtml(v) {
    var rows = v.rows || [], fl = fastestLap(rows);
    if (!rows.length) return '<p class="mp-note">這場大獎賽沒有成績。</p>';
    var html = '<table><thead><tr><th class="c-pos">名次</th><th class="c-name">車手</th><th class="c-laps">圈數</th>' +
      '<th class="c-time">總時間</th><th class="c-gap">差距</th><th class="c-best">最快圈</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      html += '<tr class="' + (r.isSelf ? 'self' : '') + (r.done ? '' : ' out') + '">' +
        '<td class="c-pos">' + (count(r.pos) || i + 1) + '</td>' +
        '<td class="c-name"><div class="res-name"><span class="mp-dot" style="background:' + cleanColour(r.colour) + '"></span>' + carChip(r) +
        '<span class="mp-pname">' + esc(r.name) + '</span>' + (r.isSelf ? '<span class="mp-tag">你</span>' : '') + carTeam(r) + '</div></td>' +
        '<td class="c-laps">' + count(r.laps) + '</td>' +
        '<td class="c-time">' + (r.done ? fmtTime(r.time) : '--') + '</td>' +
        '<td class="c-gap">' + (i === 0 && r.done ? '' : gapText(r, i === 0, true)) + '</td>' +
        '<td class="c-best' + (fl !== null && r.best === fl ? ' fl' : '') + '">' + fmtTime(r.best) + '</td></tr>';
    }
    return html + '</tbody></table>';
  }

  function spectatorText(list) {
    var names = [];
    for (var i = 0; i < list.length; i++) if (list[i]) names.push(String(list[i].name == null ? '' : list[i].name));
    return names.length ? '觀戰：' + names.join('、') : '';
  }

  // "比賽將在 1:23 後結束": runs on our own clock between two setGp calls (updateHUD ticks it every frame).
  function tickGpCountdown() {
    var txt = '';
    if (gpEndsAt) {
      var s = Math.max(0, Math.ceil((gpEndsAt - performance.now()) / 1000));
      txt = '比賽將在 ' + Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60) + ' 後結束';
    }
    setText('gpends', el.hudGpEnds, txt);
    setShown('gpendson', el.hudGpEnds, txt);
  }

  // The season a session is raced in (view.year, else the year of the car list), for the panel, box and results.
  function gpYear() {
    var y = gpPhase !== 'free' ? cleanYear(gpView.year) : null;
    return y || carsYear;
  }

  function renderGp() {
    if (!inited) return;
    var v = gpView, phase = PHASE_NAME[v.phase] ? v.phase : 'free', on = phase !== 'free';
    var ctl = !!v.canControl, online = !!v.online;
    var rows = v.rows || [], specs = v.spectators || [];
    var q = count(v.q), r = count(v.r), wear = cleanWear(v.wear, 1);
    var posTxt = v.pos > 0 ? 'P' + count(v.pos) + ' / ' + count(v.count) : '';
    var lapTxt = v.lapTotal > 0 ? count(v.lap) + ' / ' + count(v.lapTotal) : '';
    var specTxt = on ? spectatorText(specs) : '';

    // a Grand Prix starting (qualifying, or straight to the grid) brings its tab to the front of the side panel
    if ((phase === 'quali' || phase === 'grid') && gpPhase === 'free') setTab('gp', false);
    var parc = (phase !== 'free') !== (gpPhase !== 'free');
    gpPhase = phase;
    if (parc) {                               // a session began / ended: the car controls lock / unlock
      inGpRender = true;
      renderCars();
      inGpRender = false;
    }
    setShown('tabgp', el.tabGpDot, on);
    renderGpCar();

    /* menu panel */
    setShown('gpsetup', el.gpSetup, !on && ctl);
    var noStart = on || !ctl || !v.canStart;
    if (el.gpStart.disabled !== noStart) el.gpStart.disabled = noStart;
    var hint = '';
    if (!on) {
      if (!ctl) hint = '由房主開始大獎賽，開始後房間裡所有人會一起進入排位賽。';
      else if (!v.canStart) hint = v.startHint || '先選一條賽道';
      else if (online) hint = '房間裡所有人會一起進入排位賽。';
    } else if (!ctl) {
      hint = phase === 'results' ? '等待房主開始下一場或結束大獎賽。' : '只有房主可以跳過排位或結束大獎賽。';
    }
    setText('gphint', el.gpHint, hint);
    setShown('gphinton', el.gpHint, hint);

    setShown('gpsession', el.gpSession, on);
    gpOn = on;
    showRoster();
    setShown('gpbox', el.hudGp, on);

    var key = phase + '|' + (v.sid == null ? '' : v.sid) + '|' + (online ? 1 : 0);
    if (key !== gpKey) { gpKey = key; gpClosed = false; }
    showResults(phase === 'results' && !gpClosed);

    gpEndsAt = phase === 'race' && typeof v.endsInMs === 'number' && isFinite(v.endsInMs)
      ? performance.now() + Math.max(0, v.endsInMs) : 0;
    tickGpCountdown();
    if (!on) return;

    var detail = phase === 'quali' ? '每人 ' + q + ' 圈，最快圈決定起跑順序'
      : phase === 'grid' ? '正賽 ' + r + ' 圈，燈號全滅就起跑'
      : phase === 'race' ? '共 ' + r + ' 圈' : '正賽 ' + r + ' 圈';
    setHtml('gpstate', el.gpState, '<b>' + PHASE_NAME[phase] + '</b><span>' + detail + '</span>');
    var self = '';
    if (v.spectating) self = '你正在觀戰，下一場大獎賽開始時才會加入。';
    else if (phase === 'quali') self = v.done ? '你的排位已完成，等待其他車手。' : (lapTxt ? '你已完成 ' + lapTxt + ' 圈' : '');
    else if (phase === 'grid') self = posTxt ? '你的起跑位置：' + posTxt : '';
    else if (phase === 'race') self = (v.done ? '你已完賽' : (lapTxt ? '你已完成 ' + lapTxt + ' 圈' : '')) + (posTxt ? '（' + posTxt + '）' : '');
    else self = posTxt ? '你的名次：' + posTxt : '';
    setText('gpself', el.gpSelf, self);
    setShown('gpselfon', el.gpSelf, self);
    setShown('gpactions', el.gpActions, ctl);
    setShown('gpskip', el.gpSkip, ctl && phase === 'quali');
    setShown('gpagain', el.gpAgain, ctl && phase === 'results');
    setHtml('gpmenurows', el.gpStandings, gpRowsHtml(v, phase, phase === 'results', true));
    setText('gpmenuspec', el.gpSpec, specTxt);
    setShown('gpmenuspecon', el.gpSpec, specTxt);

    /* HUD session box */
    var note = '';
    if (v.spectating) note = '觀戰中';
    else if (phase === 'quali' && v.done) note = '排位完成，等待其他車手';
    else if (phase === 'race' && v.done) note = '已完賽，等待其他車手';
    var year = gpYear();
    setText('gptitle', el.hudGpTitle, PHASE_NAME[phase]);
    setText('gpyear', el.hudGpYear, year ? String(year) : '');
    setHtml('gppos', el.hudGpPos, v.pos > 0 ? '<b>P' + count(v.pos) + '</b>/ ' + count(v.count) : '');
    setShown('gplaprow', el.hudGpLapRow, (phase === 'quali' || phase === 'race') && lapTxt && !v.spectating);
    setText('gplap', el.hudGpLap, lapTxt || '--');
    setText('gpnote', el.hudGpNote, note);
    setShown('gpnoteon', el.hudGpNote, note);
    setHtml('gprows', el.hudGpRows, gpRowsHtml(v, phase, false));
    var dense = rows.length > 10;
    if (cache.gpdense !== dense) {
      cache.gpdense = dense;
      el.hudGp.classList.toggle('dense', dense);
      el.gpRes.classList.toggle('dense', dense);
    }
    setText('gpspec', el.hudGpSpec, specTxt);
    setShown('gpspecon', el.hudGpSpec, specTxt);

    /* results overlay */
    if (phase !== 'results') return;
    setHtml('gprestable', el.gpResBody, resultsHtml(v));
    setText('gpressub', el.gpResSub, (cache.track ? cache.track + ' ‧ ' : '') + (year ? year + ' 賽季 ‧ ' : '') +
      '排位 ' + q + ' 圈 ‧ 正賽 ' + r + ' 圈' + (wear > 1 ? ' ‧ 輪胎損耗 ×' + wear : ''));
    setText('gpresspec', el.gpResSpec, specTxt);
    setShown('gpresspecon', el.gpResSpec, specTxt);
    setText('gpresnote', el.gpResNote, ctl ? '' : '等待房主開始下一場或結束大獎賽');
    setShown('gpresagain', el.gpResAgain, ctl);
    setShown('gpresend', el.gpResEnd, ctl);
  }

  // The results overlay. #hud.res-open: in a narrow window the overlay takes the session box's place (index.html).
  function showResults(on) {
    on = !!on;
    setShown('gpres', el.gpRes, on);
    if (cache.resopen !== on) { cache.resopen = on; el.hud.classList.toggle('res-open', on); }
  }

  function renderPad() {
    if (!inited) return;
    setShown('hintkeys', el.hintKeys, !padOn);
    setShown('hintpad', el.hintPad, padOn);
    setShown('padstatus', el.padStatus, padOn);
    if (cache.padid !== padId) { cache.padid = padId; el.padStatus.title = padId; }
  }

  function markWear() {
    var b = el.gpWear.children;
    for (var i = 0; i < b.length; i++) {
      var on = Number(b[i].getAttribute('data-w')) === gpCfg.wear;
      b[i].classList.toggle('on', on);
      if (b[i].getAttribute('aria-checked') !== String(on)) b[i].setAttribute('aria-checked', String(on));
    }
  }

  // The 大獎賽 tab's car line: the season that will be raced (or is being raced) and our car; 換車 opens 車輛.
  function renderGpCar() {
    if (!inited) return;
    var year = gpYear(), c = carSel ? carById[carSel] : null, html = '';
    if (c) {
      html = '<span class="mp-dot" style="background:' + livery(c) + '"></span>' + esc(teamName(c)) +
        (c.car ? ' ' + esc(c.car) : '');
    } else if (year) html = '尚未選車';
    if (gpPhase !== 'free') html += (html ? ' ‧ ' : '') + '輪胎損耗 ×' + cleanWear(gpView.wear, 1);
    setShown('gpcar', el.gpCar, year);
    setText('gpyearbadge', el.gpYear, year ? String(year) : '');
    setHtml('gpcarname', el.gpCarName, html);
    setShown('gpcarchange', el.gpCarChange, gpPhase === 'free' && canPick.car);
  }

  function initGpPanel() {
    loadGpStore();
    el.gpQ.value = String(gpCfg.q);
    el.gpR.value = String(gpCfg.r);

    // while typing: remember a valid value without rewriting the field; leaving the field / Enter cleans it up
    var typed = function () {
      var q = Number(el.gpQ.value), r = Number(el.gpR.value);
      if (el.gpQ.value !== '' && q === Math.floor(q) && q >= 1 && q <= GP_Q_MAX) gpCfg.q = q;
      if (el.gpR.value !== '' && r === Math.floor(r) && r >= 1 && r <= GP_R_MAX) gpCfg.r = r;
      saveGpStore();
    };
    var start = function () {
      if (el.gpStart.disabled) return;
      commitLaps();
      if (callbacks.onGpStart) callbacks.onGpStart({ q: gpCfg.q, r: gpCfg.r, wear: gpCfg.wear });
    };
    // 輪胎損耗 ×1..×5
    markWear();
    el.gpWear.addEventListener('click', function (e) {
      var w = e.target && e.target.getAttribute && Number(e.target.getAttribute('data-w'));
      if (!(w >= 1 && w <= WEAR_MAX)) return;
      gpCfg.wear = w;
      markWear();
      saveGpStore();
    });
    el.gpCarChange.addEventListener('click', function () { el.gpCarChange.blur(); setTab('car', true); });
    var action = function (btn, a) {
      btn.addEventListener('click', function () {
        btn.blur();                          // a focused button would take Space / Enter while driving
        if (callbacks.onGpAction) callbacks.onGpAction(a);
      });
    };
    el.gpQ.addEventListener('input', typed);
    el.gpR.addEventListener('input', typed);
    el.gpQ.addEventListener('change', commitLaps);
    el.gpR.addEventListener('change', commitLaps);
    el.gpQ.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
    el.gpR.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
    el.gpStart.addEventListener('click', start);
    action(el.gpSkip, 'skip'); action(el.gpEnd, 'end'); action(el.gpAgain, 'again');
    action(el.gpResAgain, 'again'); action(el.gpResEnd, 'end');
    el.gpClose.addEventListener('click', function () {
      el.gpClose.blur();
      gpClosed = true;
      showResults(false);
    });

    renderGp();
    renderPad();
  }

  /* ---------- side panel tabs: 車輛 / 大獎賽 / 多人連線 / 設定 ---------- */

  function setTab(t, remember) {
    if (TABS.indexOf(t) < 0) return;
    var moved = t !== tab;
    tab = t;
    if (!inited) return;
    for (var i = 0; i < TABS.length; i++) {
      var k = TABS[i], on = k === t;
      el.tabBtn[k].classList.toggle('on', on);
      if (el.tabBtn[k].getAttribute('aria-selected') !== String(on)) el.tabBtn[k].setAttribute('aria-selected', String(on));
      el.page[k].classList.toggle('hidden', !on);
    }
    if (moved && el.mpPanel.scrollTop) el.mpPanel.scrollTop = 0;
    if (moved && t === 'car') {                // the chosen car in view (it may be far down a list of 12)
      var on = el.carList.querySelector('.car-card.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
    if (remember) {
      try { window.localStorage.setItem(MENU_STORE_KEY, JSON.stringify({ tab: t })); } catch (err) { /* ignore */ }
    }
  }

  function initTabs() {
    try {
      var o = JSON.parse(window.localStorage.getItem(MENU_STORE_KEY) || 'null');
      if (o && typeof o === 'object' && TABS.indexOf(o.tab) >= 0) tab = o.tab;
    } catch (err) { /* storage unavailable or corrupt: the 大獎賽 tab */ }
    el.tabs.addEventListener('click', function (e) {
      var n = e.target;
      while (n && n !== el.tabs && !(n.getAttribute && n.getAttribute('data-tab'))) n = n.parentNode;
      if (!n || n === el.tabs) return;
      setTab(n.getAttribute('data-tab'), true);
    });
    setTab(tab, false);
  }

  /* ---------- 車輛: year selector and the year's cars ---------- */

  function loadCarStore() {
    try {
      var o = JSON.parse(window.localStorage.getItem(CAR_STORE_KEY) || 'null');
      if (o && typeof o === 'object') {
        pick.year = cleanYear(o.year);
        pick.car = cleanCarId(o.car);
      }
    } catch (err) { /* storage unavailable or corrupt: nothing chosen yet */ }
  }

  function saveCarStore() {
    try { window.localStorage.setItem(CAR_STORE_KEY, JSON.stringify({ year: pick.year, car: pick.car })); } catch (err) { /* ignore */ }
  }

  // both livery colours in one chip (a dark main colour alone would vanish on the dark panel)
  function livery(c) {
    var a = cleanColour(c.colour);
    return isColour(c.colour2) ? 'linear-gradient(135deg, ' + a + ' 55%, ' + c.colour2 + ' 55%)' : a;
  }

  // 'Ferrari' / '法拉利' -> the Chinese name; the English one only when it says more
  function teamName(c) { return str(c.teamZh) || str(c.team); }
  function teamHtml(c) {
    var zh = str(c.teamZh), en = str(c.team);
    if (zh && en.indexOf(zh) === 0) en = en.slice(zh.length).trim();   // a team field that already carries both
    if (!zh) return esc(en);
    return esc(zh) + (en && en !== zh ? '<small>' + esc(en) + '</small>' : '');
  }

  function rating(v) {
    var n = typeof v === 'number' ? Math.round(v) : NaN;
    return isFinite(n) ? (n < 0 ? 0 : n > 100 ? 100 : n) : null;
  }

  // the battery bar only for cars with an ERS (spec.ers === null: that season had none)
  function hasErs(c) {
    if (c.ers === null) return false;
    return (c.ers && typeof c.ers === 'object') || rating(c.ratings && c.ratings.ers) !== null;
  }

  // One line about the car's battery (Traditional Chinese, '' when there is none; a car without KERS may have one too):
  // the row's own ersNote if it carries one, else F1.cars.ersNote(id) (the CarSpec does not carry it).
  function ersNote(c) {
    if (typeof c.ersNote === 'string') return c.ersNote;
    var C = F1.cars;
    if (!C || typeof C.ersNote !== 'function') return '';
    try { return str(C.ersNote(c.id)); } catch (err) { return ''; }
  }

  function carCardHtml(c) {
    var r = c.ratings && typeof c.ratings === 'object' ? c.ratings : {}, bars = '', ers = hasErs(c);
    for (var k = 0; k < RATING_KEYS.length; k++) {
      if (k === 4 && !ers) continue;
      var v = rating(r[RATING_KEYS[k]]);
      bars += '<span class="car-bar"><em>' + RATING_NAMES[k] + '<b>' + (v === null ? '--' : v) + '</b></em>' +
        '<i><s style="width:' + (v || 0) + '%"></s></i></span>';
    }
    // a car known to have no battery (spec.ers null: all of 2010, a few 2011-2012 teams): said where its bar would be
    if (c.ers === null) bars += '<span class="car-noers" title="這輛車沒有 KERS（動能回收系統）：E 沒有作用">無 KERS</span>';
    var en = ersNote(c);
    return '<button type="button" class="car-card" data-id="' + c.id + '" aria-pressed="false">' +
      '<span class="car-head"><i class="car-chip" style="background:' + cleanColour(c.colour) + '"></i>' +
      (isColour(c.colour2) ? '<i class="car-chip" style="background:' + c.colour2 + '"></i>' : '') +
      '<span class="car-team">' + teamHtml(c) + '</span><span class="car-model">' + esc(c.car) + '</span></span>' +
      (c.engine ? '<span class="car-engine">' + esc(c.engine) + '</span>' : '') +
      '<span class="car-bars">' + bars + '</span>' +
      (en ? '<span class="car-ers"><b>電池</b>' + esc(en) + '</span>' : '') +
      (c.note ? '<span class="car-note">' + esc(c.note) + '</span>' : '') + '</button>';
  }

  // highlight one card (the others lose it); touches only the cards whose state changes
  function markCar(id) {
    id = cleanCarId(id);
    if (id === carSel) return;
    carSel = id;
    var n = el.carList.children;
    for (var i = 0; i < n.length; i++) {
      var on = n[i].getAttribute('data-id') === id;
      if (n[i].classList.contains('on') !== on) {
        n[i].classList.toggle('on', on);
        n[i].setAttribute('aria-pressed', String(on));
      }
    }
    var c = id ? carById[id] : null;
    setShown('tabchip', el.tabCarChip, c);
    var bg = c ? livery(c) : '';
    if (c && cache.tabchipc !== bg) { cache.tabchipc = bg; el.tabCarChip.style.background = bg; }
    renderGpCar();
  }

  function renderCars() {
    if (!inited) return;
    var v = carsView || {};
    // parc fermé: while a Grand Prix session is on nothing can be changed, whatever the flags say
    var session = gpPhase !== 'free';
    var year = cleanYear(v.year), canYear = v.canPickYear !== false && !session, canCar = v.canPickCar !== false && !session;
    var list = Array.isArray(v.cars) ? v.cars : [];

    // years, newest first (the seasons of F1.cars; the list's own year even if it is missing there)
    var seasons = Array.isArray(v.seasons) ? v.seasons : [], years = [], info = null, i;
    for (i = 0; i < seasons.length; i++) {
      var s = seasons[i], y = s && cleanYear(s.year);
      if (y && years.indexOf(y) < 0) years.push(y);
      if (y && y === year) info = s;
    }
    if (year && years.indexOf(year) < 0) years.push(year);
    years.sort(function (a, b) { return b - a; });
    var opts = '';
    for (i = 0; i < years.length; i++) opts += '<option value="' + years[i] + '">' + years[i] + ' 年</option>';
    setHtml('caryears', el.carYear, opts);
    if (year && el.carYear.value !== String(year)) el.carYear.value = String(year);
    if (el.carYear.disabled !== !(canYear && years.length > 1)) el.carYear.disabled = !(canYear && years.length > 1);
    carsYear = year;
    canPick.year = !!carsView && canYear; canPick.car = !!carsView && canCar;
    el.carList.classList.toggle('locked', !canCar);
    el.carList.classList.toggle('pending', false);

    var n = 0, html = '';
    carById = Object.create(null);
    for (i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || typeof c !== 'object' || !cleanCarId(c.id) || carById[c.id]) continue;
      carById[c.id] = c;
      html += carCardHtml(c);
      n++;
    }
    var seasonTxt = '';
    if (info || n) {
      var label = info && str(info.label) !== String(year) ? str(info.label) : '';
      var engine = (info && str(info.engine)) || '';
      seasonTxt = (label ? label + ' ‧ ' : '') + (engine ? engine + ' ‧ ' : '') + n + ' 輛車';
    }
    setText('carseason', el.carSeason, seasonTxt);
    if (cache.carlist !== html) {
      cache.carlist = html;
      el.carList.innerHTML = html;
      carSel = undefined;                    // new cards: mark the chosen one again
    }
    setShown('carempty', el.carEmpty, !n);

    var lock = '';
    if (session && v.canPickCar !== false) lock = '賽事進行中不能換車';
    else if (!canCar && !canYear) lock = str(v.reason) || '賽事進行中不能換車';
    else if (!canYear) lock = str(v.reason) || '年份由房主選擇，大家都從這一年的車裡挑。';
    else if (!canCar) lock = str(v.reason) || '現在不能換車';
    setText('carlock', el.carLock, lock);
    setShown('carlockon', el.carLock, lock);

    markCar(v.selected);
    renderGpCar();
    if (session && !inGpRender) renderGp();   // the session box / results show the year (the list's, if the view has none)
  }

  function initCarPanel() {
    loadCarStore();
    el.carYear.addEventListener('change', function () {
      var y = cleanYear(el.carYear.value);
      if (!y || !canPick.year) {
        if (carsYear) el.carYear.value = String(carsYear);
        return;
      }
      pick.year = y;
      saveCarStore();
      // until setCars brings that year's cars, the list on screen is last year's: dim it
      el.carList.classList.toggle('pending', y !== carsYear);
      if (callbacks.onYear) callbacks.onYear(y);
    });
    el.carList.addEventListener('click', function (e) {
      var n = e.target;
      while (n && n !== el.carList && !(n.classList && n.classList.contains('car-card'))) n = n.parentNode;
      if (!n || n === el.carList || !canPick.car) return;
      var id = cleanCarId(n.getAttribute('data-id'));
      if (!id || !carById[id]) return;
      n.blur();                              // a focused card would take Space / Enter
      pick.car = id;
      saveCarStore();
      if (id === carSel) return;
      markCar(id);                           // at once; the next setCars has the last word
      if (callbacks.onCar) callbacks.onCar(id);
    });
    renderCars();
  }

  /* ---------- 設定: volume and mute ---------- */

  function cleanVolume(v, def) {
    return typeof v === 'number' && isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : def;
  }

  function loadAudioStore() {
    try {
      var o = JSON.parse(window.localStorage.getItem(AUDIO_STORE_KEY) || 'null');
      if (o && typeof o === 'object') {
        audio.volume = cleanVolume(o.volume, audio.volume);
        if (typeof o.muted === 'boolean') audio.muted = o.muted;
      }
    } catch (err) { /* storage unavailable or corrupt: defaults */ }
  }

  function saveAudioStore() {
    try { window.localStorage.setItem(AUDIO_STORE_KEY, JSON.stringify({ volume: audio.volume, muted: audio.muted })); } catch (err) { /* ignore */ }
  }

  function renderAudio() {
    if (!inited) return;
    var pct = Math.round(audio.volume * 100);
    if (el.setVolume.value !== String(pct)) el.setVolume.value = String(pct);
    setText('volume', el.setVolumeVal, pct + '%');
    if (el.setMute.checked !== audio.muted) el.setMute.checked = audio.muted;
    setText('mutetxt', el.setMuteText, audio.muted ? '開' : '關');
  }

  function initSettings() {
    loadAudioStore();
    var changed = function () {
      renderAudio();
      saveAudioStore();
      if (callbacks.onAudio) callbacks.onAudio({ volume: audio.volume, muted: audio.muted });
    };
    el.setVolume.addEventListener('input', function () {
      var v = cleanVolume(Number(el.setVolume.value) / 100, audio.volume);
      if (v === audio.volume) return;
      audio.volume = v;
      changed();
    });
    el.setMute.addEventListener('change', function () {
      el.setMute.blur();
      if (el.setMute.checked === audio.muted) return;
      audio.muted = el.setMute.checked;
      changed();
    });
    renderAudio();
    initMirrorSetting();
  }

  /* ---------- 設定: HUD rear-view mirrors ---------- */

  function loadViewStore() {
    try {
      var o = JSON.parse(window.localStorage.getItem(VIEW_STORE_KEY) || 'null');
      if (o && typeof o === 'object' && typeof o.mirrors === 'boolean') view.mirrors = o.mirrors;
    } catch (err) { /* storage unavailable or corrupt: mirrors on */ }
  }

  function saveViewStore() {
    try { window.localStorage.setItem(VIEW_STORE_KEY, JSON.stringify({ mirrors: view.mirrors })); } catch (err) { /* ignore */ }
  }

  // the switch, and the HUD laid out with or without the mirrors (#hud.no-mirrors: index.html moves the corner boxes
  // back up and hides the frames)
  function renderMirrors() {
    if (!inited) return;
    var on = view.mirrors && view.available;
    if (el.setMirrors) {
      if (el.setMirrors.checked !== on) el.setMirrors.checked = on;
      if (el.setMirrors.disabled !== !view.available) el.setMirrors.disabled = !view.available;
      setText('mirrorstxt', el.setMirrorsText, view.available ? (on ? '開' : '關') : '無法顯示');
    }
    if (cache.nomirrors !== !on) { cache.nomirrors = !on; el.hud.classList.toggle('no-mirrors', !on); }
  }

  function initMirrorSetting() {
    loadViewStore();
    if (el.setMirrors) el.setMirrors.addEventListener('change', function () {
      el.setMirrors.blur();
      if (!view.available || el.setMirrors.checked === view.mirrors) return;
      view.mirrors = el.setMirrors.checked;
      saveViewStore();
      renderMirrors();
      if (callbacks.onMirrors) callbacks.onMirrors(view.mirrors);
    });
    renderMirrors();
  }

  /* ---------- HUD: pit lane strip ---------- */

  function pitNum(v, def) { return typeof v === 'number' && isFinite(v) ? v : def; }
  function fmtSec(s) { return String(Math.round(s * 10) / 10); }    // 5 -> "5", 2.5 -> "2.5"

  function renderPit() {
    var c = pitC;
    setShown('pit', el.pit, c.shown);
    if (!c.shown) return;
    setHtml('pitlimit', el.pitLimit, '維修區 限速<b>' + c.limit + '</b>');
    setText('pitlim', el.pitLim, c.limiter ? '限速器 開' : '限速器 關');
    setClass('pitlimcls', el.pitLim, 'pit-chip ' + (c.limiter ? 'on' : c.inLane ? 'warn' : 'off'));
    var warn = c.speeding ? '超速！罰停 +5 s' : (c.inLane && !c.limiter && c.tenths < 0 ? '請開啟限速器（' + (c.pad ? 'B' : 'Q') + '）' : '');
    setText('pitwarn', el.pitWarn, warn);
    setShown('pitwarnon', el.pitWarn, warn);
    setClass('pitwarncls', el.pitWarn, 'pit-warn' + (c.speeding ? ' hot' : ''));
    var box = '';
    if (c.box !== PIT_BOX_HIDDEN) {
      box = '你的維修格 <b>' + (c.slot + 1) + '</b> 號：' +
        (c.box > 0 ? '前方 <b>' + c.box + '</b> m' : c.box < 0 ? '已超過' : '到了，停車');
    }
    setHtml('pitbox', el.pitBox, box);
    setShown('pitboxon', el.pitBox, box);
    var pend = c.pending > 0 && !c.speeding && c.tenths < 0 ? (c.served ? '出口線罰停 +' : '下次停站罰停 +') + fmtSec(c.pending / 10) + ' s' : '';
    setText('pitpend', el.pitPending, pend);
    setShown('pitpendon', el.pitPending, pend);
    var svc = c.tenths >= 0;
    setShown('pitsvc', el.pitSvc, svc);
    if (!svc) return;
    setText('pitsvclabel', el.pitSvcLabel, c.penNow ? '罰停中' : '換胎中');
    setClass('pitsvclabelcls', el.pitSvcLabel, c.penNow ? 'pen' : '');
    setText('pitsvctime', el.pitSvcTime, (c.tenths / 10).toFixed(1) + ' s');
    if (cache.pitbar !== c.frac) { cache.pitbar = c.frac; el.pitBar.style.transform = 'scaleX(' + c.frac / 200 + ')'; }
    var pen = c.pen > 0 ? '罰停 +' + fmtSec(c.pen / 10) + ' s' : '';
    setText('pitpen', el.pitPen, pen);
    setShown('pitpenon', el.pitPen, pen);
  }

  /* ---------- minimap ---------- */

  function prepareMap(points) {
    mapRatio = Math.min(window.devicePixelRatio || 1, 2);
    mapPx = Math.round(MAP_CSS * mapRatio);
    el.map.width = mapPx; el.map.height = mapPx;
    mapCtx = el.map.getContext('2d');
    mapBase = document.createElement('canvas');
    mapBase.width = mapPx; mapBase.height = mapPx;
    var c = mapBase.getContext('2d');
    if (!points || points.length < 2) { mapScale = 1; mapOx = mapOz = mapPx / 2; return; }

    var b = bounds(points);
    var inner = mapPx - MAP_PAD * 2 * mapRatio;
    mapScale = inner / Math.max(b.w, b.h);
    mapOx = (mapPx - b.w * mapScale) / 2 - b.minX * mapScale;
    mapOz = (mapPx - b.h * mapScale) / 2 - b.minZ * mapScale;

    c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath();
    for (var i = 0; i < points.length; i++) {
      var px = points[i][0] * mapScale + mapOx, pz = points[i][1] * mapScale + mapOz;
      if (i) c.lineTo(px, pz); else c.moveTo(px, pz);
    }
    c.closePath();
    c.strokeStyle = 'rgba(0,0,0,0.75)'; c.lineWidth = 6 * mapRatio; c.stroke();
    c.strokeStyle = '#f2f4f7'; c.lineWidth = 2.6 * mapRatio; c.stroke();

    // start/finish marker
    c.fillStyle = '#ff4b3a';
    c.beginPath();
    c.arc(points[0][0] * mapScale + mapOx, points[0][1] * mapScale + mapOz, 3.6 * mapRatio, 0, Math.PI * 2);
    c.fill();
  }

  function drawMap(x, z, heading, others) {
    if (!mapCtx || !mapBase) return;
    var c = mapCtx, r = mapRatio;
    c.clearRect(0, 0, mapPx, mapPx);
    c.drawImage(mapBase, 0, 0);
    if (others && others.length) {
      c.lineWidth = 1.2 * r;
      c.strokeStyle = 'rgba(0,0,0,0.85)';
      for (var i = 0; i < others.length; i++) {
        var o = others[i];
        c.beginPath();
        c.arc(o.x * mapScale + mapOx, o.z * mapScale + mapOz, 3.6 * r, 0, Math.PI * 2);
        c.fillStyle = o.colour || '#ffffff';
        c.fill(); c.stroke();
      }
    }
    var px = x * mapScale + mapOx, pz = z * mapScale + mapOz;
    // forward = (sin h, cos h) in (x, z); x -> right, z -> down
    var fx = Math.sin(heading), fz = Math.cos(heading);
    var sx = -fz, sz = fx; // perpendicular
    c.beginPath();
    c.moveTo(px + fx * 9 * r, pz + fz * 9 * r);
    c.lineTo(px - fx * 5 * r + sx * 5.5 * r, pz - fz * 5 * r + sz * 5.5 * r);
    c.lineTo(px - fx * 2 * r, pz - fz * 2 * r);
    c.lineTo(px - fx * 5 * r - sx * 5.5 * r, pz - fz * 5 * r - sz * 5.5 * r);
    c.closePath();
    c.fillStyle = '#ffd400';
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.lineWidth = 1.5 * r;
    c.fill(); c.stroke();
  }

  /* ---------- elements ---------- */

  // Every element the module touches. init() looks them all up before it wires or renders anything, so whatever a
  // callback does from inside init (onProfile -> setGp / setNet / toast ...) finds the whole UI in place.
  function findElements() {
    // menu, HUD
    el.menu = $('menu'); el.hud = $('hud');
    el.grid = $('track-grid'); el.search = $('track-search');
    el.count = $('track-count'); el.empty = $('track-empty');
    el.resume = $('menu-resume');
    el.lap = $('hud-lap');
    el.cur = $('hud-cur'); el.last = $('hud-last'); el.best = $('hud-best');
    el.track = $('hud-track'); el.map = $('minimap');
    el.telemetry = $('hud-telemetry');
    el.menuBtn = $('hud-menu-btn');
    el.toast = $('hud-toast');               // (not inside #hud: shown over the menu too)
    el.loading = $('loading'); el.loadingName = $('loading-name');   // (likewise)
    // side panel tabs
    el.mpPanel = $('mp-panel'); el.tabs = $('menu-tabs');
    el.tabBtn = { car: $('tab-car'), gp: $('tab-gp'), mp: $('tab-mp'), set: $('tab-set') };
    el.page = { car: $('car-panel'), gp: $('gp-panel'), mp: $('mp-section'), set: $('set-panel') };
    el.tabCarChip = $('tab-car-chip'); el.tabGpDot = $('tab-gp-dot'); el.tabMpDot = $('tab-mp-dot');
    // 車輛
    el.carYear = $('car-year'); el.carSeason = $('car-season'); el.carLock = $('car-lock');
    el.carList = $('car-list'); el.carEmpty = $('car-empty');
    // 設定
    el.setVolume = $('set-volume'); el.setVolumeVal = $('set-volume-val');
    el.setMute = $('set-mute'); el.setMuteText = $('set-mute-text');
    el.setMirrors = $('set-mirrors'); el.setMirrorsText = $('set-mirrors-text');   // HUD rear-view mirrors
    el.credits = $('credits'); el.setCredits = $('set-credits');   // credits line -> 資料來源與授權
    // HUD pit strip
    el.pit = $('hud-pit'); el.pitLimit = $('hud-pit-limit'); el.pitLim = $('hud-pit-lim'); el.pitWarn = $('hud-pit-warn');
    el.pitBox = $('hud-pit-box'); el.pitPending = $('hud-pit-pending'); el.pitSvc = $('hud-pit-svc');
    el.pitSvcLabel = $('hud-pit-svc-label'); el.pitSvcTime = $('hud-pit-svc-time'); el.pitBar = $('hud-pit-bar');
    el.pitPen = $('hud-pit-pen');
    // multiplayer panel, HUD roster box
    el.mpName = $('mp-name'); el.mpColours = $('mp-colours');
    el.mpOffline = $('mp-offline'); el.mpOnline = $('mp-online');
    el.mpPort = $('mp-port'); el.mpCreate = $('mp-create'); el.mpCreateNote = $('mp-create-note');
    el.mpAddr = $('mp-addr'); el.mpJoin = $('mp-join');
    el.mpCreatePass = $('mp-create-pass'); el.mpJoinPass = $('mp-join-pass');   // optional room password (not stored)
    el.mpStatus = $('mp-status'); el.mpHost = $('mp-host'); el.mpLan = $('mp-lan');
    el.mpPub = $('mp-pubip'); el.mpPubOut = $('mp-pubip-out'); el.mpPortNote = $('mp-port-note');
    el.mpPlayers = $('mp-players'); el.mpPlayersTitle = $('mp-players-title'); el.mpLeave = $('mp-leave');
    el.lock = $('track-lock'); el.hudPlayers = $('hud-players');
    // Grand Prix panel, HUD session box, start lights, results overlay, controller hints
    el.gpSetup = $('gp-setup'); el.gpQ = $('gp-q'); el.gpR = $('gp-r'); el.gpStart = $('gp-start');
    el.gpHint = $('gp-hint'); el.gpSession = $('gp-session'); el.gpState = $('gp-state'); el.gpSelf = $('gp-self');
    el.gpActions = $('gp-actions'); el.gpSkip = $('gp-skip'); el.gpEnd = $('gp-end'); el.gpAgain = $('gp-again');
    el.gpStandings = $('gp-standings'); el.gpSpec = $('gp-spec');
    el.gpWear = $('gp-wear'); el.gpCar = $('gp-car'); el.gpYear = $('gp-year'); el.gpCarName = $('gp-car-name');
    el.gpCarChange = $('gp-car-change');
    el.hudGp = $('hud-gp'); el.hudGpTitle = $('hud-gp-title'); el.hudGpPos = $('hud-gp-pos'); el.hudGpYear = $('hud-gp-year');
    el.hudGpLapRow = $('hud-gp-laprow'); el.hudGpLap = $('hud-gp-lap'); el.hudGpNote = $('hud-gp-note');
    el.hudGpEnds = $('hud-gp-ends'); el.hudGpRows = $('hud-gp-rows'); el.hudGpSpec = $('hud-gp-spec');
    el.lights = $('hud-lights'); el.lightsText = $('hud-lights-text');
    el.lamps = el.lights.getElementsByTagName('i');
    el.gpRes = $('gp-results'); el.gpResSub = $('gp-results-sub'); el.gpResBody = $('gp-results-body');
    el.gpResSpec = $('gp-results-spec'); el.gpResNote = $('gp-results-note');
    el.gpResAgain = $('gp-res-again'); el.gpResEnd = $('gp-res-end'); el.gpClose = $('gp-close');
    el.hintKeys = $('hud-hint-keys'); el.hintPad = $('hud-hint-pad'); el.padStatus = $('pad-status');
  }

  /* ---------- public API ---------- */

  var ui = {
    init: function (opts) {
      opts = opts || {};
      callbacks.onSelectTrack = opts.onSelectTrack || null;
      callbacks.onExitToMenu = opts.onExitToMenu || null;
      callbacks.onCreateRoom = opts.onCreateRoom || null;
      callbacks.onJoinRoom = opts.onJoinRoom || null;
      callbacks.onLeaveRoom = opts.onLeaveRoom || null;
      callbacks.onProfile = opts.onProfile || null;
      callbacks.onGpStart = opts.onGpStart || null;      // ({q, r, wear}): 開始大獎賽
      callbacks.onGpAction = opts.onGpAction || null;    // ('skip' | 'end' | 'again')
      callbacks.onYear = opts.onYear || null;            // (year): the player picked a season
      callbacks.onCar = opts.onCar || null;              // (id): the player picked a car of the list
      callbacks.onAudio = opts.onAudio || null;          // ({volume, muted}): slider / mute switch moved
      callbacks.onMirrors = opts.onMirrors || null;      // (on): the 後照鏡 switch of 設定 flipped
      if (inited) return;
      findElements();
      inited = true;                         // from here on setNet / setGp / setLights / setPad / setCars render

      el.grid.addEventListener('click', function (e) {
        var n = e.target;
        while (n && n !== el.grid && !(n.classList && n.classList.contains('card'))) n = n.parentNode;
        if (!n || n === el.grid || !builtFor || gridLocked) return;
        var t = builtFor[Number(n.getAttribute('data-i'))];
        if (t && callbacks.onSelectTrack) callbacks.onSelectTrack(t);
      });
      el.search.addEventListener('input', applyFilter);
      if (el.menuBtn) el.menuBtn.addEventListener('click', function () {
        el.menuBtn.blur();
        if (callbacks.onExitToMenu) callbacks.onExitToMenu();
      });
      // the credits line under the title: every source and licence, with its address, is in 設定
      if (el.credits && el.setCredits) el.credits.addEventListener('click', function () {
        setTab('set', true);
        if (el.setCredits.scrollIntoView) el.setCredits.scrollIntoView({ block: 'nearest' });
      });
      initTabs();
      initCarPanel();
      initNetPanel();
      initGpPanel();
      initSettings();
      // the broadcast graphic: sized by its own ResizeObserver once the HUD is shown
      var T = F1.telemetry;
      if (T && typeof T.init === 'function' && typeof T.draw === 'function' && el.telemetry) {
        try { tele = T.init(el.telemetry) ? T : null; } catch (err) { tele = null; }
      }
      // last, with every panel wired and rendered: the stored name / colour (the callback may call anything here)
      if (callbacks.onProfile) callbacks.onProfile({ name: mp.name, colour: mp.colour });
    },

    /**
     * Multiplayer panel / HUD player list. v = { canCreate, connected, busy, isHost, status, statusKind ('ok' | 'err' | ''),
     *   hostInfo: {port, addresses} | null, roster: [{name, colour, best, isHost, isSelf}], roomTrack (the room has a
     *   track: a guest is no longer told to wait for one), lockText (overrides the banner over the track grid) }
     */
    setNet: function (v) {
      netView = v || {};
      renderNet();
    },

    /**
     * Grand Prix: menu panel (Q / R, 開始 / 跳過排位 / 結束 / 再來一場, state, standings), HUD session box (replaces
     * the roster box while a session is on) and the results overlay. v = GpView (js/README-interfaces.md) plus
     * canStart / startHint; an optional v.sid re-opens a closed results overlay when the session changes.
     * Cheap to call a few times a second: the DOM is only touched where the generated text changed.
     */
    setGp: function (v) {
      gpView = v || {};
      renderGp();
    },

    /**
     * Start lights, called every frame. n = -1: hidden; 0..5: that many red lights lit (left to right);
     * go = true (with n >= 0): lights out + green "GO". watching (optional) = true: the viewer is not on the grid
     * (a spectator): the caption says what is happening (正賽即將起跑 / 正賽開始) instead of telling him to get ready.
     */
    setLights: function (n, go, watching) {
      n = n >= 0 ? Math.min(5, Math.floor(n)) : -1;
      go = !!go && n >= 0;
      watching = !!watching;
      if (go) n = 0;
      if (n === lightsN && go === lightsGo && (watching === lightsWatch || n < 0)) return;
      if (!inited) return;
      lightsN = n; lightsGo = go;
      if (n >= 0) lightsWatch = watching;      // (hidden: the caption does not matter)
      for (var i = 0; i < el.lamps.length; i++) el.lamps[i].classList.toggle('on', i < n);
      el.lights.classList.toggle('go', go);
      el.lights.classList.toggle('watch', lightsWatch);
      el.lightsText.textContent = lightsWatch ? (go ? '正賽開始' : '正賽即將起跑') : (go ? 'GO' : '準備起跑');
      el.lights.classList.toggle('hidden', n < 0);
    },

    /** A controller appeared / went away: the HUD hint switches between keyboard and controller wording. */
    setPad: function (connected, id) {
      padOn = !!connected;
      padId = padOn && typeof id === 'string' ? id : '';
      renderPad();
    },

    /** Name / colour chosen in the panel (persisted in localStorage). */
    getProfile: function () { return { name: mp.name, colour: mp.colour }; },

    /**
     * 車輛 tab: the year selector and that year's cars. v = { year, cars: [CarSpec] (F1.cars.list(year): the
     * standard car first), selected (id of the car we drive), canPickYear, canPickCar (false: disabled; a missing
     * flag counts as true), seasons: [{year, label, engine, count}] (F1.cars.seasons; shown newest first),
     * reason (text shown while a control is disabled; defaults: 賽事進行中不能換車 when both are, 年份由房主選擇…
     * when only the year is) }. The selection follows `selected`: a card clicked is highlighted at once and
     * onCar(id) called, and the next setCars decides. Cheap to call again with the same content: the DOM is
     * only touched where something changed (the card list is compared as generated HTML).
     */
    setCars: function (v) {
      carsView = v && typeof v === 'object' ? v : null;
      renderCars();
    },

    /** The car the player picked last (a CarSpec id, remembered), or null: resolve it with F1.cars.resolve. */
    getCar: function () { return pick.car; },

    /** The season the player picked last (2010..2100, remembered), or null (not picked yet / nothing valid stored). */
    getYear: function () { return pick.year; },

    /** Volume 0..1 and mute from the 設定 tab (remembered in localStorage 'f1drive.audio'). */
    getAudio: function () { return { volume: audio.volume, muted: audio.muted }; },

    /**
     * The volume / mute changed elsewhere (e.g. the M key): the 設定 tab shows it and it is remembered. Missing or
     * invalid fields keep their value. Does not call onAudio.
     */
    setAudio: function (a) {
      if (!a || typeof a !== 'object') return;
      var v = cleanVolume(a.volume, audio.volume), m = typeof a.muted === 'boolean' ? a.muted : audio.muted;
      if (v === audio.volume && m === audio.muted) return;
      audio.volume = v; audio.muted = m;
      saveAudioStore();
      renderAudio();
    },

    /** The HUD rear-view mirrors setting of 設定 (on by default, remembered in localStorage 'f1drive.hud'). */
    getMirrors: function () { return view.mirrors; },

    /**
     * The mirrors changed elsewhere: m = { on (bool: the V key; shown and remembered), available (bool: false = the
     * game cannot draw them; the switch is disabled and the HUD laid out without them, the setting itself is kept) }.
     * Missing or invalid fields keep their value. Does not call onMirrors.
     */
    setMirrors: function (m) {
      if (!m || typeof m !== 'object') return;
      var on = typeof m.on === 'boolean' ? m.on : view.mirrors, av = typeof m.available === 'boolean' ? m.available : view.available;
      if (on !== view.mirrors) { view.mirrors = on; saveViewStore(); }
      view.available = av;
      renderMirrors();
    },

    /**
     * Pit lane strip above the telemetry graphic, called every frame. p = { inLane, limiter, speeding,
     * service: null | {left, total, penalty} (s; the penalty part is served first), limitKmh, boxAhead (m to our
     * box along the lane, + ahead / - passed, null: unknown), slot (our box index, -1: none; shown as slot + 1),
     * pending (optional: s of hold waiting for the next stop), served (optional: true = this visit has had its stop, so
     * the pending hold is served at the exit line) }. Shown while in the lane, while the limiter is on
     * and during a service; hidden otherwise (setPit(null) hides it). Only touches the DOM when what it shows changes.
     */
    setPit: function (p) {
      if (!inited) return;
      if (!p || typeof p !== 'object') p = PIT_NONE;
      var s = p.service && typeof p.service === 'object' ? p.service : null;
      var inLane = p.inLane === true, limiter = p.limiter === true, shown = inLane || limiter || !!s;
      var speeding = inLane && p.speeding === true;
      var limit = Math.round(pitNum(p.limitKmh, 80));
      if (!(limit > 0 && limit < 1000)) limit = 80;
      var slot = pitNum(p.slot, -1);
      slot = slot >= 0 && slot < 1000 ? Math.floor(slot) : -1;
      var ahead = p.boxAhead, box = PIT_BOX_HIDDEN;
      if (inLane && !s && slot >= 0 && typeof ahead === 'number' && isFinite(ahead)) {
        box = ahead > 2.5 ? Math.min(99999, Math.round(ahead)) : ahead < -2.5 ? -1 : 0;
      }
      var tenths = -1, frac = -1, pen = -1, penNow = false, pending = -1, served = p.served === true;
      if (s) {
        var total = Math.max(0, pitNum(s.total, 0)), left = Math.min(Math.max(0, pitNum(s.left, 0)), 999);
        var penalty = Math.max(0, pitNum(s.penalty, 0));
        tenths = Math.ceil(left * 10 - 1e-6);
        // the bar moves with the countdown's tenths (a CSS transition smooths it), not every frame
        frac = total > 0 ? Math.round(Math.min(1, Math.max(0, 1 - tenths / 10 / total)) * 200) : 0;
        pen = Math.min(9999, Math.round(penalty * 10));
        penNow = penalty > 0 && left > total - penalty;
      } else pending = Math.min(9999, Math.round(Math.max(0, pitNum(p.pending, 0)) * 10));
      var c = pitC;
      if (c.shown === shown && c.inLane === inLane && c.limiter === limiter && c.speeding === speeding && c.limit === limit &&
          c.slot === slot && c.box === box && c.tenths === tenths && c.frac === frac && c.pen === pen && c.penNow === penNow &&
          c.pending === pending && c.served === served && c.pad === padOn) return;
      c.shown = shown; c.inLane = inLane; c.limiter = limiter; c.speeding = speeding; c.limit = limit; c.slot = slot;
      c.box = box; c.tenths = tenths; c.frac = frac; c.pen = pen; c.penNow = penNow; c.pending = pending; c.served = served; c.pad = padOn;
      renderPit();
    },

    /** Short message (player joined, connection lost, ...): at the top of the HUD, at the bottom of the menu. */
    toast: function (text, ms) {
      if (!el.toast) return;
      clearTimeout(toastTimer);
      el.toast.textContent = text || '';
      el.toast.classList.toggle('hidden', !text);
      if (text) toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, ms || 4000);
    },

    /**
     * A track is being built (the page stops for a moment): name = its name, shown in a note in the middle of the
     * screen, over the menu and the HUD; null hides the note.
     */
    setLoading: function (name) {
      if (!inited || !el.loading) return;
      var on = typeof name === 'string';
      setText('loadname', el.loadingName, on ? name : '');
      setShown('loading', el.loading, on);
    },

    /** Optional (not in the interface doc): main.js may register a "resume" handler to show a 繼續駕駛 button. */
    setResumeHandler: function (fn) {
      if (!el.resume) return;
      el.resume.onclick = fn || null;
      el.resume.classList.toggle('hidden', !fn);
    },

    showMenu: function (tracks) {
      tracks = tracks || [];
      if (builtFor !== tracks) buildGrid(tracks);
      el.hud.classList.add('hidden');
      el.menu.classList.remove('hidden');
    },

    hideMenu: function () {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      el.menu.classList.add('hidden');
      el.hud.classList.remove('hidden');
    },

    setTrack: function (trackData) {
      trackData = trackData || {};
      setText('track', el.track, trackData.name || '');
      prepareMap(trackData.points);
      if (trackData.points && trackData.points.length) {
        drawMap(trackData.points[0][0], trackData.points[0][1], 0);
      }
      if (tele && tele.reset) tele.reset();   // a new track: the graphic shows the next frame as it is
    },

    /**
     * Every frame. h = { lap, lapTotal, curTime, lastTime, bestTime, x, z, heading, others } for the timing box /
     * minimap, plus the telemetry fields, handed as they are (same object, no copy) to F1.telemetry.draw: speedKmh,
     * gear (-1 R, 0 N, 1..9), rpm, rpmIdle, rpmShift, rpmMax, throttle, brake, battery (null: no ERS), deploy,
     * harvest, limiter, inPit, limitKmh, tyres, nextCompound, team, car, colour, colour2.
     */
    updateHUD: function (h) {
      // lapTotal (number | null): "2 / 5" in a Grand Prix; a lap beyond the target is shown on its own
      setText('lap', el.lap, h.lap ? (h.lapTotal > 0 && h.lap <= h.lapTotal ? h.lap + ' / ' + h.lapTotal : String(h.lap)) : '--');
      setText('cur', el.cur, fmtTime(h.curTime));
      setText('last', el.last, fmtTime(h.lastTime));
      setText('best', el.best, fmtTime(h.bestTime));
      drawMap(h.x, h.z, h.heading, h.others);   // others (optional): [{x, z, colour}] remote players
      if (gpEndsAt) tickGpCountdown();
      if (tele) tele.draw(h);                   // never throws; a no-op while the HUD is hidden
    },

    formatTime: fmtTime
  };

  F1.ui = ui;
})();
