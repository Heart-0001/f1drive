const fs = require('fs');
const p = 'C:/Users/user/Desktop/f1drive/js/ui.js';
let s = fs.readFileSync(p, 'utf8');
const nl = s.includes('\r\n') ? '\r\n' : '\n';
s = s.replace(/\r\n/g, '\n');
function rep(a, b) {
  const c = s.split(a).length - 1;
  if (c !== 1) throw new Error('expected 1 match, got ' + c + ' for: ' + a.slice(0, 60));
  s = s.replace(a, () => b);
}

rep(`/* F1.ui — menu (track picker) + HUD (speed, gear, lap times, minimap). Classic script, no dependencies. */`,
`/* F1.ui — menu (track picker, multiplayer panel) + HUD (speed, gear, lap times, minimap, player list).
   Classic script, no dependencies. */`);

rep(`  var callbacks = { onSelectTrack: null, onExitToMenu: null };`,
`  var callbacks = {
    onSelectTrack: null, onExitToMenu: null,
    onCreateRoom: null, onJoinRoom: null, onLeaveRoom: null, onProfile: null
  };`);

rep(`  // HUD text cache (only touch the DOM when the string changed)`,
`  // multiplayer panel state
  var STORE_KEY = 'f1drive.mp';
  var COLOURS = ['#ff7a14', '#e10600', '#1e6bff', '#19c8e6', '#35d07f', '#ffd21e', '#c04bff', '#f2f4f7'];
  var DEFAULT_PORT = 24500;
  var mp = { name: '', colour: COLOURS[0], addr: '', port: DEFAULT_PORT };
  var netView = {};         // last object given to setNet
  var gridLocked = false;
  var nameTimer = 0, toastTimer = 0, ipReq = 0;

  // HUD text cache (only touch the DOM when the string changed)`);

rep(`  /* ---------- minimap ---------- */
`, `  /* ---------- multiplayer panel ---------- */

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
`);

rep(`  function drawMap(x, z, heading) {
    if (!mapCtx || !mapBase) return;
    var c = mapCtx, r = mapRatio;
    c.clearRect(0, 0, mapPx, mapPx);
    c.drawImage(mapBase, 0, 0);
`, `  function drawMap(x, z, heading, others) {
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
`);

rep(`      callbacks.onExitToMenu = opts.onExitToMenu || null;
      if (inited) return;`, `      callbacks.onExitToMenu = opts.onExitToMenu || null;
      callbacks.onCreateRoom = opts.onCreateRoom || null;
      callbacks.onJoinRoom = opts.onJoinRoom || null;
      callbacks.onLeaveRoom = opts.onLeaveRoom || null;
      callbacks.onProfile = opts.onProfile || null;
      if (inited) return;`);

rep(`        if (!n || n === el.grid || !builtFor) return;`, `        if (!n || n === el.grid || !builtFor || gridLocked) return;`);

rep(`        if (callbacks.onExitToMenu) callbacks.onExitToMenu();
      });
    },`, `        if (callbacks.onExitToMenu) callbacks.onExitToMenu();
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
    },`);

rep(`      drawMap(h.x, h.z, h.heading);
    },`, `      drawMap(h.x, h.z, h.heading, h.others);   // others (optional): [{x, z, colour}] remote players
    },`);

fs.writeFileSync(p, s.replace(/\n/g, nl));
console.log('ok');
