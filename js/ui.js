/* F1.ui — menu (track picker, multiplayer panel) + HUD (speed, gear, lap times, minimap, player list).
   Classic script, no dependencies. */
(function () {
  'use strict';
  var F1 = (window.F1 = window.F1 || {});

  var el = {};
  var callbacks = {
    onSelectTrack: null, onExitToMenu: null,
    onCreateRoom: null, onJoinRoom: null, onLeaveRoom: null, onProfile: null
  };
  var inited = false;

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

  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '--';
    if (t < 0) t = 0;
    var ms = Math.floor(t * 1000 + 1e-6);
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var r = ms % 1000;
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + (r < 10 ? '00' : r < 100 ? '0' : '') + r;
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
    var lock = connected ? (v.isHost ? '你是房主：點選賽道，房間裡所有人會一起載入並回到起跑格。' : '等待房主選擇賽道…') : '';
    if (connected && v.lockText) lock = v.lockText;
    el.lock.textContent = lock;
    el.lock.classList.toggle('hidden', !lock);

    // HUD player list
    var hudRows = connected ? playerRows(roster, true) : '';
    if (cache.hudrows !== hudRows) { cache.hudrows = hudRows; el.hudPlayers.innerHTML = hudRows; }
    el.hudPlayers.classList.toggle('hidden', !hudRows);
  }

  function initNetPanel() {
    el.mpName = $('mp-name'); el.mpColours = $('mp-colours');
    el.mpOffline = $('mp-offline'); el.mpOnline = $('mp-online');
    el.mpPort = $('mp-port'); el.mpCreate = $('mp-create'); el.mpCreateNote = $('mp-create-note');
    el.mpAddr = $('mp-addr'); el.mpJoin = $('mp-join');
    el.mpStatus = $('mp-status'); el.mpHost = $('mp-host'); el.mpLan = $('mp-lan');
    el.mpPub = $('mp-pubip'); el.mpPubOut = $('mp-pubip-out'); el.mpPortNote = $('mp-port-note');
    el.mpPlayers = $('mp-players'); el.mpPlayersTitle = $('mp-players-title'); el.mpLeave = $('mp-leave');
    el.lock = $('track-lock'); el.hudPlayers = $('hud-players'); el.toast = $('hud-toast');

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
      if (callbacks.onCreateRoom) callbacks.onCreateRoom(el.mpPort.value === '' ? DEFAULT_PORT : pt);
    };
    var join = function () {
      if (el.mpJoin.disabled) return;
      mp.addr = el.mpAddr.value.trim();
      sendProfile();
      if (callbacks.onJoinRoom) callbacks.onJoinRoom(mp.addr);
    };
    el.mpCreate.addEventListener('click', create);
    el.mpJoin.addEventListener('click', join);
    el.mpPort.addEventListener('keydown', function (e) { if (e.key === 'Enter') create(); });
    el.mpAddr.addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
    el.mpLeave.addEventListener('click', function () { if (callbacks.onLeaveRoom) callbacks.onLeaveRoom(); });
    el.mpPub.addEventListener('click', showPublicIp);

    renderNet();
    if (callbacks.onProfile) callbacks.onProfile({ name: mp.name, colour: mp.colour });
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
      if (inited) return;
      inited = true;

      el.menu = $('menu'); el.hud = $('hud');
      el.grid = $('track-grid'); el.search = $('track-search');
      el.count = $('track-count'); el.empty = $('track-empty');
      el.resume = $('menu-resume');
      el.speed = $('hud-speed'); el.gear = $('hud-gear'); el.lap = $('hud-lap');
      el.cur = $('hud-cur'); el.last = $('hud-last'); el.best = $('hud-best');
      el.track = $('hud-track'); el.map = $('minimap');
      el.menuBtn = $('hud-menu-btn');

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
      initNetPanel();
    },

    /**
     * Multiplayer panel / HUD player list. v = { canCreate, connected, busy, isHost, status, statusKind ('ok' | 'err' | ''),
     *   hostInfo: {port, addresses} | null, roster: [{name, colour, best, isHost, isSelf}], lockText }
     */
    setNet: function (v) {
      netView = v || {};
      renderNet();
    },

    /** Name / colour chosen in the panel (persisted in localStorage). */
    getProfile: function () { return { name: mp.name, colour: mp.colour }; },

    /** Short message at the top of the HUD (player joined, connection lost, ...). */
    toast: function (text, ms) {
      if (!el.toast) return;
      clearTimeout(toastTimer);
      el.toast.textContent = text || '';
      el.toast.classList.toggle('hidden', !text);
      if (text) toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, ms || 4000);
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
    },

    updateHUD: function (h) {
      setText('speed', el.speed, String(Math.round(Math.abs(h.speedKmh || 0))));
      setText('gear', el.gear, String(h.gear));
      setText('lap', el.lap, h.lap ? String(h.lap) : '--');
      setText('cur', el.cur, fmtTime(h.curTime));
      setText('last', el.last, fmtTime(h.lastTime));
      setText('best', el.best, fmtTime(h.bestTime));
      drawMap(h.x, h.z, h.heading, h.others);   // others (optional): [{x, z, colour}] remote players
    },

    formatTime: fmtTime
  };

  F1.ui = ui;
})();
