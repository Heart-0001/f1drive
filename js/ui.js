/* F1.ui — menu (track picker; side panel with the tabs 車輛 (year + that year's cars), 大獎賽, 多人連線, 設定 (volume,
   HUD mirrors)) + HUD (lap times, minimap, player list, Grand Prix session box, start lights, results, pit lane strip;
   speed, gear, pedals, battery and tyres are the telemetry graphic of js/telemetry.js, drawn from updateHUD; the two
   HUD rear-view mirrors are drawn by js/hudmirrors.js into the frames #hud-mirror-l / -r, laid out by index.html).
   v6.2: the track cards show the Chinese name (window.F1_TRACK_NAMES_ZH, js/track-names-zh.js) with the English one
   under it, and the search also matches the Chinese names / aliases and the country in English and Chinese (COUNTRY
   below); 設定 has the 視野 (FOV) slider (onFov, getFov; 'f1drive.fov'); the 大獎賽 tab the starting compound
   (setCompound / onCompound: main.js's next set); the pit strip names the next set and its key (setPit p.next).
   v7: the computer drivers (電腦車手) - in the 大獎賽 tab how many (0..16 - humans) and how strong (新手 / 業餘 / 職業 /
   傳奇 / 混合), remembered ('f1drive.bots', getBots / onBots; read-only for a room's guests and during a session: the
   view's bots.canEdit) with the field listed in free practice; an AI tag on bots in the standings, the session box, the
   results, the room roster; their minimap dots ringed in the second livery colour; the car cards say who drives them;
   setLoading's optional title (電腦車手熟悉賽道中…). The search also takes the Taiwanese names of a round (日本站, 日本大獎賽),
   日本GP and full-width letters; searchTracks(list, query) is that search without the DOM (tests / harnesses).
   v7.2: the left area of the menu shows one of three views (setSetup, a SetupView from main.js): the track cards, the
   start panel (出發面板: a card click opens it, 開始 drives; single player) / the room lobby (房間大廳: players, 準備,
   the room's settings host-editable and read-only for the guests, the host's 開始 / 不等了，直接開始), and the cards as
   the host's track picker. The laps, the tyre wear and the 電腦車手 rows moved from the 大獎賽 tab into it (same ids);
   the solo setup {mode, q, r, wear} is remembered ('f1drive.gp', getSetup). setRoomLoading draws a room's loading
   screen; setupKey(k) lets main.js hand it Esc / the controller's A and B.
   Classic script; uses F1.telemetry when it is loaded, F1.cars.ersNote for the battery line of the car cards,
   F1.COCKPIT_FOV for the range of the FOV slider. */
(function () {
  'use strict';
  var F1 = (window.F1 = window.F1 || {});

  var el = {};
  var callbacks = {
    onSelectTrack: null, onExitToMenu: null,
    onCreateRoom: null, onJoinRoom: null, onLeaveRoom: null, onProfile: null,
    onGpAction: null,
    onYear: null, onCar: null, onAudio: null, onMirrors: null,
    onFov: null, onCompound: null, onBots: null,
    // v7.2: the start panel / the room lobby
    onSetupStart: null, onSetupBack: null, onSetup: null, onReady: null,
    onRoomTrackPicker: null, onRoomBack: null, onRoomGo: null, onGpOpen: null
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

  // 設定: the cockpit's field of view (deg, vertical, at a standstill; js/cockpit.js setFov). Range and default from
  // F1.COCKPIT_FOV when js/cockpit.js is loaded; remembered in 'f1drive.fov' only once the slider was moved.
  var FOV_STORE_KEY = 'f1drive.fov';
  var FOV_FALLBACK = { def: 60, min: 50, max: 75 };
  var fovSet = null;        // the stored setting (whole degrees), null = the default

  // 大獎賽: the compound of the next set (main.js owns it: setCompound / onCompound). It is the set fitted at the start of
  // qualifying, on the grid and at a pit stop; T / X cycle it while driving. Not stored (a new session of the game
  // starts on mediums, the reference).
  var COMPOUNDS = { S: '軟胎', M: '中性胎', H: '硬胎' };
  var nextCmp = 'M';

  // 大獎賽: the computer drivers (電腦車手). The setting {count, skill} is the player's (remembered): it is the field alone
  // and, as the host, the room's (main.js caps it at the room's free seats). The level ids are js/ai.js's (F1.AI.LEVELS)
  // plus 'mixed'; their skill values give the nearest level of a bot's own skill (its row's tooltip).
  var BOTS_STORE_KEY = 'f1drive.bots';
  var BOTS_MAX = 15;                         // alone: the player + 15 (a room holds 16 cars)
  var BOT_LEVELS = [{ id: 'rookie', name: '新手', skill: 0, pct: 8 }, { id: 'amateur', name: '業餘', skill: 0.35, pct: 5 },
    { id: 'pro', name: '職業', skill: 0.7, pct: 2.5 }, { id: 'legend', name: '傳奇', skill: 1, pct: 1 }];
  var BOT_LEVEL_NAME = { rookie: '新手', amateur: '業餘', pro: '職業', legend: '傳奇', mixed: '混合' };
  var botCfg = { count: 0, skill: 'pro' };   // default: no computer drivers (the v6 game)

  // pit strip: the last input, in the units shown (setPit is called every frame)
  var pitC = { shown: false, inLane: false, limiter: false, speeding: false, limit: 0, slot: -1, box: 0,
    tenths: -1, frac: -1, pen: -1, penNow: false, pending: -1, served: false, pad: false, next: '' };
  var PIT_NONE = {};
  var PIT_BOX_HIDDEN = -99999;

  // menu state
  var builtFor = null;      // tracks array the grid was built for
  var cards = [];           // [{node, key}]
  var trackById = {};
  var zhByName = {};        // English track name -> Chinese name (the loading note gets the English one from main.js)

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
  // the solo setup of the start panel (remembered; also the host's preferences for a fresh room): mode 'free' (自由練習)
  // or 'gp' (大獎賽), the laps and the tyre wear multiplier
  var gpCfg = { q: 3, r: 5, wear: 1, mode: 'free' };
  var gpView = {};              // last object given to setGp
  var gpOn = false;             // a session is on: the session box replaces the room roster box in the HUD
  var gpPhase = 'free';         // phase of the last setGp (a session starting opens the 大獎賽 tab, locks the cars)
  var inGpRender = false;
  var gpKey = '';               // phase (+ session) the 關閉 of the results overlay belongs to
  var gpClosed = false;
  var gpEndsAt = 0;             // performance.now() time at which the race closes, 0 = no countdown
  var lightsN = -1, lightsGo = false, lightsWatch = false;
  var padOn = false, padId = '';
  var gpConfirm = false;        // the 大獎賽 tab asks before 結束大獎賽 sends a room back to its lobby

  // v7.2: the start panel / the room lobby (setSetup), the room's loading screen (setRoomLoading)
  var MODE_NOTE = { free: '自由練習：不計成績，隨時可以按 Esc 回選單。', gp: '大獎賽：先跑排位賽決定起跑順序，再跑正賽。' };
  var setupV = null;            // the last SetupView
  var setupSig = '';            // what renderSetup last drew (only a change touches the DOM)
  var shownView = 'tracks';     // the view on screen: 'tracks' | 'setup' | 'picker'
  var focusKey = '';            // the view the focus was last moved for (moved only when the view changes)
  var focusWait = null;         // the button that view wanted focused but could not be yet (disabled)
  var roomRows = null;          // where the track / season rows sit: true = in the room settings, false = solo layout
  var confirmKind = '';         // the action block's confirm row: '' | 'force' (仍要開始) | 'back' (回到大廳)
  var gridScroll = 0;           // the card grid's scroll position while the panel shows
  var rlView = null;            // the last RoomLoadingView, null = hidden
  var rlSig = '';
  var resumeFn = null;          // main.js's resume handler (繼續駕駛)
  var copyTimer = 0;

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

  // Search only (never shown): the country of each circuit in English (+ the usual short forms, the adjective of its
  // Grand Prix) and in Chinese (Taiwan usage first, then mainland / Hong Kong forms), by the country code that starts
  // every track id ('jp-1962' -> jp). js/track-names-zh.js has the Chinese circuit / place names; this adds the country
  // so 'japan', '日本', 'usa', 'uk', '英國' ... find their circuits. EXTRA: Grand Prix names a circuit carried that are
  // not its country's, and a few regions.
  var COUNTRY = {
    ae: 'United Arab Emirates|UAE|Emirates|Emirati|Abu Dhabi|阿聯|阿聯酋|阿拉伯聯合大公國|阿拉伯联合酋长国|阿联酋',
    ar: 'Argentina|Argentine|Argentinian|ARG|阿根廷',
    at: 'Austria|Austrian|Österreich|AUT|奧地利|奥地利',
    au: 'Australia|Australian|AUS|澳洲|澳大利亞|澳大利亚',
    az: 'Azerbaijan|Azerbaijani|AZE|亞塞拜然|阿塞拜疆',
    be: 'Belgium|Belgian|BEL|比利時|比利时',
    bh: 'Bahrain|Bahraini|BRN|BHR|巴林',
    br: 'Brazil|Brasil|Brazilian|BRA|巴西',
    ca: 'Canada|Canadian|CAN|加拿大',
    cn: 'China|Chinese|CHN|PRC|中國|中国|中國大陸',
    de: 'Germany|German|Deutschland|GER|DEU|德國|德国',
    es: 'Spain|Spanish|España|ESP|西班牙',
    fr: 'France|French|FRA|法國|法国',
    gb: 'United Kingdom|UK|Great Britain|Britain|British|England|English|GB|GBR|英國|英国|英格蘭|英格兰|大不列顛',
    hu: 'Hungary|Hungarian|HUN|匈牙利',
    it: 'Italy|Italian|Italia|ITA|義大利|意大利',
    jp: 'Japan|Japanese|Nippon|JPN|日本',
    mc: 'Monaco|Monegasque|Monte Carlo|MON|MCO|摩納哥|摩纳哥',
    mx: 'Mexico|Mexican|México|MEX|墨西哥',
    my: 'Malaysia|Malaysian|MAS|MYS|馬來西亞|马来西亚|大馬',
    nl: 'Netherlands|The Netherlands|Holland|Dutch|NED|NLD|荷蘭|荷兰|尼德蘭',
    pt: 'Portugal|Portuguese|POR|PRT|葡萄牙',
    qa: 'Qatar|Qatari|QAT|卡達|卡塔爾|卡塔尔',
    ru: 'Russia|Russian|RUS|俄羅斯|俄罗斯|俄國',
    sa: 'Saudi Arabia|Saudi|KSA|沙烏地阿拉伯|沙烏地|沙特阿拉伯|沙特',
    sg: 'Singapore|Singaporean|SGP|SIN|新加坡|星國',
    tr: 'Turkey|Turkish|Türkiye|TUR|土耳其',
    us: 'United States|United States of America|USA|US|America|American|美國|美国',
    za: 'South Africa|South African|RSA|南非'
  };
  var EXTRA = {
    'it-1953': 'San Marino|Emilia-Romagna|Emilia Romagna|聖馬利諾|艾米利亞-羅馬涅',
    'it-1914': 'Tuscan|Tuscany|Toscana|托斯卡尼',
    'at-1969': 'Styrian|Styria|施泰爾馬克',
    'de-1927': 'Eifel|European|Luxembourg|艾菲爾|歐洲|盧森堡',
    'gb-1948': '70th Anniversary|七十週年',
    'bh-2002': 'Sakhir|薩基爾',
    'es-1991': 'Catalunya|Catalonia|Montmelo|加泰隆尼亞',
    'us-1909': 'Indy|印地',
    'us-2012': 'Austin|Texas|COTA|德州',
    'us-2022': 'Florida|佛羅里達',
    'us-2023': 'Nevada|內華達',
    'us-1956': 'New York|紐約'
  };

  // The search key / query in one form: lower case, accents off (Nürburgring = nurburgring, São Paulo = sao paulo),
  // full-width letters and digits as ASCII (ＪＡＰＡＮ = japan: NFKD), every middle dot as '·' and every dash as '-'
  // (js/track-names-zh.js: the dots Taiwanese IMEs and media use; the dots first: NFKD makes '．' a '.'), runs of
  // spaces and separators as one space.
  function searchForm(s) {
    s = String(s == null ? '' : s).replace(/[\u2027\uff0e\u30fb\uff65\u2022]/g, '\u00b7');
    if (s.normalize) s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return s.toLowerCase().replace(/[\u2013\u2014\uff0d]/g, '-')
      .replace(/[\s,;:()\uff08\uff09\u3001\uff0c|\/]+/g, ' ').trim();
  }

  // The terms of a query: searchForm, split at the spaces and between Chinese and Latin runs ('日本GP' = 日本 gp), and a
  // Chinese term without the way a round is named after it: 日本站 / 日本分站 / 日本大獎賽 (大奖赛) / 日本賽 = 日本 (the
  // Taiwanese media's '沙烏地阿拉伯站'; the keys hold the country and 大獎賽 as words of their own). A term that is
  // nothing but that (大獎賽, 站) asks for nothing.
  var CJK_LATIN = /([\u3400-\u9fff\uf900-\ufaff])(?=[a-z0-9])|([a-z0-9])(?=[\u3400-\u9fff\uf900-\ufaff])/g;
  var HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
  var ROUND_SUFFIX = /(?:分站|站|大獎賽|大奖赛|獎賽|奖赛|賽|赛)$/;
  function queryTerms(q) {
    var s = searchForm(q).replace(CJK_LATIN, '$1$2 '), parts = s ? s.split(' ') : [], out = [];
    for (var i = 0; i < parts.length; i++) {
      var t = HAS_CJK.test(parts[i]) ? parts[i].replace(ROUND_SUFFIX, '') : parts[i];
      if (t) out.push(t);
    }
    return out;
  }

  // Everything a card is found by: the English name, location and id, the Chinese name / short / location / aliases,
  // the country (English + short forms, Chinese), the Grand Prix names ('japanese gp' finds Suzuka). Kept as
  // ' ' + words + ' ', once more with '-' as a word break (for the whole-word test of short terms: 'us' in 'us-2012').
  function searchKey(t, zh) {
    var parts = [t.name, t.location, t.id, 'F1 GP Grand Prix 大獎賽'], cc = String(t.id || '').split('-')[0];
    if (zh) {
      parts.push(zh.name, zh.short, zh.location);
      if (Array.isArray(zh.aliases)) parts = parts.concat(zh.aliases);
    }
    if (Object.prototype.hasOwnProperty.call(COUNTRY, cc)) parts.push(COUNTRY[cc]);
    if (Object.prototype.hasOwnProperty.call(EXTRA, t.id)) parts.push(EXTRA[t.id]);
    var k = searchForm(parts.join(' '));
    return ' ' + k + ' ' + k.replace(/-/g, ' ') + ' ';
  }

  // The Chinese names of a track (js/track-names-zh.js), or null.
  function zhOf(t) {
    var Z = window.F1_TRACK_NAMES_ZH;
    var z = Z && t && typeof t.id === 'string' && Object.prototype.hasOwnProperty.call(Z, t.id) ? Z[t.id] : null;
    return z && typeof z.name === 'string' && z.name ? z : null;
  }
  // What the HUD, the results and the loading note call a track: its Chinese name, else the English one.
  function trackLabel(t) { var z = zhOf(t); return z ? z.name : (t && typeof t.name === 'string' ? t.name : ''); }

  // The cards keep the order of window.F1_TRACKS (by English name): the card at index i is tracks[i] (data-i).
  function buildGrid(tracks) {
    builtFor = tracks;
    cards = [];
    trackById = {};
    zhByName = {};
    var html = '';
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i], z = zhOf(t);
      if (z && typeof t.name === 'string') zhByName[t.name] = z.name;
      // (trackData.layout: a note on the layout the game builds, e.g. Estoril's post-2000 one: the card's tooltip, in
      //  Chinese where js/track-names-zh.js has it)
      var lay = t.layout && z && typeof z.layout === 'string' && z.layout ? z.layout : t.layout;
      html += '<button type="button" class="card" data-i="' + i + '"' + (typeof lay === 'string' && lay ? ' title="' + esc(lay) + '"' : '') + '>' + thumbSvg(t.points) +
        '<div class="card-info"><div class="card-name">' + esc(z ? z.name : t.name) + '</div>' +
        (z ? '<div class="card-en" lang="en">' + esc(t.name) + '</div>' : '') +
        '<div class="card-meta"><span>' + esc(z && z.location ? z.location : t.location) + '</span><b>' + fmtKm(t.lengthKm) + '</b></div></div></button>';
    }
    el.grid.innerHTML = html;
    var nodes = el.grid.children;
    for (var j = 0; j < nodes.length; j++) {
      var tr = tracks[j];
      cards.push({ node: nodes[j], key: searchKey(tr, zhOf(tr)) });
    }
    markCurrentCard();
    applyFilter();
  }

  // v7.2: the card of the loaded track says 目前賽道 (Esc while driving opens the cards: 繼續駕駛 or another track)
  var loadedId = '';
  function markCurrentCard() {
    for (var i = 0; i < cards.length; i++) {
      var on = !!loadedId && !!builtFor && !!builtFor[i] && builtFor[i].id === loadedId;
      if (cards[i].node.classList.contains('current') !== on) cards[i].node.classList.toggle('current', on);
    }
  }

  // A term of the query. 1..3 Latin letters / digits must start a word ('us', 'uk', 'gb', 'it', 'spa': else 'us' would
  // find Austria, Russia, Australia ...); anything longer, and Chinese, matches anywhere in the key.
  function termMatch(key, term) {
    if (/^[a-z0-9]{1,3}$/.test(term)) return key.indexOf(' ' + term) >= 0;
    return key.indexOf(term) >= 0;
  }

  function applyFilter() {
    var terms = queryTerms(el.search.value || '');
    var shown = 0;
    for (var i = 0; i < cards.length; i++) {
      var ok = true;
      for (var k = 0; k < terms.length; k++) {
        if (!termMatch(cards[i].key, terms[k])) { ok = false; break; }
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

  // the level name of a computer driver's skill (0..1): the nearest of js/ai.js's levels; '' when unknown
  function levelName(s) {
    if (typeof s !== 'number' || !(s === s)) return '';
    var best = BOT_LEVELS[0];
    for (var i = 1; i < BOT_LEVELS.length; i++) if (Math.abs(BOT_LEVELS[i].skill - s) < Math.abs(best.skill - s)) best = BOT_LEVELS[i];
    return best.name;
  }
  // the AI tag of a computer driver's row (its level in the tooltip)
  function aiTag(r) {
    if (!r || r.bot !== true) return '';
    var lv = levelName(r.skill);
    return '<span class="gp-ai" title="電腦車手' + (lv ? '（' + lv + '）' : '') + '">AI</span>';
  }

  // a computer driver's dot: both colours of its car's livery (a black or white team colour alone vanishes on the panel)
  function botDot(r, colour) {
    var C = F1.cars, s = null;
    try { s = C && typeof C.get === 'function' && cleanCarId(r.car) ? C.get(r.car) : null; } catch (err) { s = null; }
    return s ? livery(s) : colour;
  }

  function playerRows(roster, withTimes) {
    var html = '';
    for (var i = 0; i < roster.length; i++) {
      var r = roster[i];
      var colour = /^#[0-9a-fA-F]{6}$/.test(r.colour) ? r.colour : '#888888';
      if (r.bot === true) colour = botDot(r, colour);
      if (withTimes) {
        html += '<div class="prow"><span class="mp-dot" style="background:' + colour + '"></span>' +
          '<span class="mp-pname">' + esc(r.name) + '</span>' + aiTag(r) + '<span class="pt">' + fmtTime(r.best) + '</span></div>';
      } else {
        html += '<li><span class="mp-dot" style="background:' + colour + '"></span>' +
          '<span class="mp-pname">' + esc(r.name) + '</span>' + aiTag(r) +
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
      var nBots = 0;
      for (var b = 0; b < roster.length; b++) if (roster[b] && roster[b].bot === true) nBots++;
      setText('ptitle', el.mpPlayersTitle, nBots ? '玩家（' + (roster.length - nBots) + ' 人 + 電腦 ' + nBots + '，' + roster.length + ' / 16）'
        : '玩家（' + roster.length + ' / 16）');
      var rows = playerRows(roster, false);
      if (cache.prows !== rows) { cache.prows = rows; el.mpPlayers.innerHTML = rows; }
    }

    // track grid: in a room only the host picks (v7.2: the cards show there only as his picker; its banner, #track-lock,
    // is the setup view's: renderSetup)
    gridLocked = connected && !v.isHost;
    el.grid.classList.toggle('locked', gridLocked);

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
        if (o.mode === 'gp' || o.mode === 'free') gpCfg.mode = o.mode;
      }
    } catch (err) { /* storage unavailable or corrupt: defaults */ }
  }

  function saveGpStore() {
    try { window.localStorage.setItem(GP_STORE_KEY, JSON.stringify({ q: gpCfg.q, r: gpCfg.r, wear: gpCfg.wear, mode: gpCfg.mode })); } catch (err) { /* ignore */ }
  }

  // Fields -> gpCfg (clamped), and the cleaned values back into the fields. Only while the fields may be edited (alone;
  // the host in the lobby): a guest's fields show the room's values. -> the partial that changed ({q}, {r}), or null.
  function commitLaps() {
    if (!setupEditable()) return null;
    var q = cleanLaps(el.gpQ.value, GP_Q_MAX, gpCfg.q), r = cleanLaps(el.gpR.value, GP_R_MAX, gpCfg.r), ch = null;
    if (q !== gpCfg.q || (setupV && setupV.room && q !== setupV.q)) (ch = ch || {}).q = q;
    if (r !== gpCfg.r || (setupV && setupV.room && r !== setupV.r)) (ch = ch || {}).r = r;
    gpCfg.q = q; gpCfg.r = r;
    el.gpQ.value = String(q);
    el.gpR.value = String(r);
    saveGpStore();
    return ch;
  }
  function setupEditable() { return !setupV || setupV.canEdit !== false; }

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
  // the dot of a row: the driver's colour; a computer driver's is its team's, with the second livery colour beside it
  function rowDot(r) { return r.bot === true && isColour(r.colour2) ? livery({ colour: r.colour, colour2: r.colour2 }) : cleanColour(r.colour); }
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
        '<span class="mp-dot" style="background:' + rowDot(r) + '"></span>' + carChip(r) +
        '<span class="mp-pname">' + esc(r.name) + '</span>' + aiTag(r) + (withTeam ? carTeam(r) : '') +
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
        '<td class="c-name"><div class="res-name"><span class="mp-dot" style="background:' + rowDot(r) + '"></span>' + carChip(r) +
        '<span class="mp-pname">' + esc(r.name) + '</span>' + aiTag(r) + (r.isSelf ? '<span class="mp-tag">你</span>' : '') + carTeam(r) + '</div></td>' +
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
    renderTyre();
    renderBots();

    /* menu panel (v7.2: a Grand Prix is started from the start panel / the room lobby, not from here) */
    var room = !!v.room || online;
    var hint = '';
    if (!on) hint = room ? '大獎賽的圈數、輪胎損耗和電腦車手在房間大廳設定。' : '點一條賽道，在出發面板選「大獎賽」再按開始。';
    else if (!ctl) {
      hint = phase === 'results' ? (room ? '等待房主選擇再來一場或回到大廳。' : '等待房主開始下一場或結束大獎賽。')
        : '只有房主可以跳過排位或結束大獎賽。';
    }
    setText('gphint', el.gpHint, hint);
    setShown('gphinton', el.gpHint, hint);
    // alone, with a track loaded: the start panel of that track, 大獎賽 selected
    setShown('gpopen', el.gpOpen, !on && !room && !!v.canStart);
    // in a room 結束大獎賽 in qualifying / on the grid sends everybody back to the lobby: asked first
    if (gpConfirm && !(room && ctl && (phase === 'quali' || phase === 'grid'))) gpConfirm = false;
    setShown('gpconfirm', el.gpConfirm, gpConfirm);

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
    setShown('gpactions', el.gpActions, ctl && !gpConfirm);
    setShown('gpskip', el.gpSkip, ctl && phase === 'quali');
    setShown('gpagain', el.gpAgain, ctl && phase === 'results');
    // a room's results: 回到大廳 (the room's 結束 there), alone 結束大獎賽 as before
    setShown('gplobby', el.gpLobby, ctl && room && phase === 'results');
    setShown('gpend', el.gpEnd, ctl && !(room && phase === 'results'));
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
    setText('gpresnote', el.gpResNote, ctl ? '' : (room ? '等待房主選擇再來一場或回到大廳' : '等待房主開始下一場或結束大獎賽'));
    setShown('gpresagain', el.gpResAgain, ctl);
    setShown('gpresend', el.gpResEnd, ctl && !room);      // alone: 結束 = back to free practice on this track
    setShown('gpreslobby', el.gpResLobby, ctl && room);   // a room's host: everybody back to the lobby
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

  // a segmented control: the button whose attribute `attr` is `val` marked; disabled when `off`
  function markSeg(box, attr, val, off) {
    var b = box ? box.children : [];
    for (var i = 0; i < b.length; i++) {
      var on = b[i].getAttribute(attr) === String(val);
      if (b[i].classList.contains('on') !== on) b[i].classList.toggle('on', on);
      if (b[i].getAttribute('aria-checked') !== String(on)) b[i].setAttribute('aria-checked', String(on));
      if (off !== undefined && b[i].disabled !== !!off) b[i].disabled = !!off;
    }
  }
  function markWear(w) { markSeg(el.gpWear, 'data-w', w === undefined ? gpCfg.wear : w); }

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
    // the start panel / lobby: 你的車 (換車 opens the 車輛 tab)
    var sc = c ? '<span class="mp-dot" style="background:' + livery(c) + '"></span>' + esc(teamName(c)) + (c.car ? ' ' + esc(c.car) : '') : '尚未選車';
    setHtml('setupcar', el.setupCar, sc);
    setShown('setupcarchange', el.setupCarChange, gpPhase === 'free' && canPick.car);
  }

  // The 大獎賽 tab's tyre row: before a Grand Prix the starting compound (fitted at the start of qualifying and on the
  // grid), during one the next set (the grid, a pit stop). Both are main.js's next set (setCompound / onCompound), the
  // one T / X cycle while driving.
  function renderTyre() {
    if (!inited || !el.gpTyre) return;
    var on = gpPhase !== 'free';
    markSeg(el.gpTyre, 'data-c', nextCmp);
    markSeg(el.setupTyre, 'data-c', nextCmp);    // (the start panel's / lobby's 起跑輪胎: the same next set)
    setText('gptyrelabel', el.gpTyreLabel, on ? '下一組輪胎' : '起跑輪胎');
    setHtml('gptyrenote', el.gpTyreNote, on
      ? (gpPhase === 'quali' ? '正賽起跑和下次進站換胎時裝上。' : '下次進站停在維修格時裝上。') + '開車時按 <kbd>T</kbd>（手把 <kbd>X</kbd>）也能換。'
      : '排位賽和正賽起跑時裝上這組新胎。開車時按 <kbd>T</kbd>（手把 <kbd>X</kbd>）換下一組，進站停在維修格時裝上。');
  }

  /* the computer drivers (電腦車手): count and strength */

  function cleanBotCount(v, def) {
    var n = typeof v === 'number' ? Math.floor(v) : NaN;
    return isFinite(n) ? (n < 0 ? 0 : n > BOTS_MAX ? BOTS_MAX : n) : def;
  }
  function cleanBotSkill(v, def) { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BOT_LEVEL_NAME, v) ? v : def; }

  function loadBotsStore() {
    try {
      var o = JSON.parse(window.localStorage.getItem(BOTS_STORE_KEY) || 'null');
      if (o && typeof o === 'object') {
        botCfg.count = cleanBotCount(o.count, botCfg.count);
        botCfg.skill = cleanBotSkill(o.skill, botCfg.skill);
      }
    } catch (err) { /* storage unavailable or corrupt: none */ }
  }

  function saveBotsStore() {
    try { window.localStorage.setItem(BOTS_STORE_KEY, JSON.stringify({ count: botCfg.count, skill: botCfg.skill })); } catch (err) { /* ignore */ }
  }

  // The 電腦車手 rows of the 大獎賽 tab, from the view's bots = {count (in the field now), skill (level), max (seats for
  // computer drivers: 16 - humans; 15 alone), canEdit (alone / the host, free practice), available (js/ai.js loaded)}
  // and botList ([{name, colour, colour2, team, skill}]: the field, shown in free practice).
  function renderBots() {
    if (!inited || !el.gpBotsBox) return;
    var b = gpView.bots && typeof gpView.bots === 'object' ? gpView.bots : null;
    var avail = !!b && b.available !== false;
    setShown('gpbotsbox', el.gpBotsBox, avail);
    if (!avail) return;
    var edit = b.canEdit === true, on = gpPhase !== 'free', online = !!gpView.online;
    var max = Math.min(16, count(b.max)), want = botWant();
    var n = edit ? Math.min(want.count, max) : Math.min(16, count(b.count));
    var lvl = edit ? want.skill : cleanBotSkill(b.skill, 'pro');
    var top = Math.max(max, n), opts = '';
    for (var i = 0; i <= top; i++) opts += '<option value="' + i + '">' + (i ? i + ' 位' : '無') + '</option>';
    setHtml('gpbotsopts', el.gpBots, opts);
    if (el.gpBots.value !== String(n)) el.gpBots.value = String(n);
    if (el.gpBots.disabled !== !edit) el.gpBots.disabled = !edit;
    var sb = el.gpSkill.children;
    for (i = 0; i < sb.length; i++) {
      var sel = sb[i].getAttribute('data-s') === lvl;
      sb[i].classList.toggle('on', sel);
      if (sb[i].getAttribute('aria-checked') !== String(sel)) sb[i].setAttribute('aria-checked', String(sel));
      if (sb[i].disabled !== !edit) sb[i].disabled = !edit;
    }
    var note;
    if (on) note = '賽事進行中不能更改電腦車手。';
    else if (!edit) note = online ? (gpView.canControl ? '電腦車手只能在房間大廳更改。' : '電腦車手由房主設定。') : '';
    else if (want.count > max) note = '房間最多 16 輛車：現在最多 ' + max + ' 位電腦車手。';
    else note = '電腦車手用這個賽季真實車手的名字，開' + (online ? '房間裡沒人選' : '你沒選') + '的車隊的車（每隊兩個席位，你選的車隊另一位車手也會上場）。';
    setText('gpbotsnote', el.gpBotsNote, note);
    setShown('gpbotsnoteon', el.gpBotsNote, note);
    // the field (free practice; in a session the standings list it)
    var list = !on && Array.isArray(gpView.botList) ? gpView.botList : [], html = '';
    for (i = 0; i < list.length && i < 16; i++) {
      var e = list[i] || {}, lv = levelName(e.skill);
      html += '<span class="gp-bot" title="' + esc((e.team ? e.team + ' ‧ ' : '') + (lv ? lv : '')) + '">' +
        '<i style="background:' + livery({ colour: e.colour, colour2: e.colour2 }) + '"></i>' + esc(e.name) + '</span>';
    }
    setHtml('gpbotslist', el.gpBotsList, html);
    setShown('gpbotsliston', el.gpBotsList, html);
    markScrolls();                            // (the rows sit in the start panel / lobby: its height changed)
  }

  // What the 電腦車手 rows show while they may be changed: the player's own setting, or (v7.2, a room's host) the room's
  // wish main.js hands as bots.want / wantSkill (a new host takes over the room's field, not his stored one).
  function botWant() {
    var b = gpView.bots && typeof gpView.bots === 'object' ? gpView.bots : {};
    return { count: typeof b.want === 'number' && b.want >= 0 ? Math.min(BOTS_MAX, Math.floor(b.want)) : botCfg.count,
             skill: cleanBotSkill(b.wantSkill, botCfg.skill) };
  }

  function initBots() {
    loadBotsStore();
    if (!el.gpBots || !el.gpSkill) return;
    var changed = function (w) {
      botCfg.count = w.count; botCfg.skill = w.skill;   // (the host's lobby edits are his preferences too)
      saveBotsStore();
      renderBots();
      if (callbacks.onBots) callbacks.onBots({ count: w.count, skill: w.skill });
    };
    el.gpBots.addEventListener('change', function () {
      var b = gpView.bots, w = botWant();
      if (!b || b.canEdit !== true) { renderBots(); return; }
      var n = cleanBotCount(Number(el.gpBots.value), w.count);
      if (n === w.count && n === botCfg.count) return;
      changed({ count: n, skill: w.skill });
    });
    el.gpSkill.addEventListener('click', function (e) {
      var s = e.target && e.target.getAttribute ? e.target.getAttribute('data-s') : null, b = gpView.bots, w = botWant();
      if (!s || !Object.prototype.hasOwnProperty.call(BOT_LEVEL_NAME, s) || !b || b.canEdit !== true) return;
      if (s === w.skill && s === botCfg.skill) return;
      changed({ count: w.count, skill: s });
    });
  }

  function initGpPanel() {
    loadGpStore();
    initBots();
    el.gpQ.value = String(gpCfg.q);
    el.gpR.value = String(gpCfg.r);

    // (v7.2: the laps and the tyre wear sit in the start panel / the room lobby; alone they are the remembered solo
    // setup, the host's edits in the lobby go to the room through onSetup, a guest's fields are read-only)
    // while typing: remember a valid value without rewriting the field (alone: the 開始 button's line follows);
    // leaving the field / Enter cleans it up (a room's host: only then is it sent)
    var typed = function () {
      if (!setupEditable()) return;
      var q = Number(el.gpQ.value), r = Number(el.gpR.value), ch = null;
      if (el.gpQ.value !== '' && q === Math.floor(q) && q >= 1 && q <= GP_Q_MAX && q !== gpCfg.q) { gpCfg.q = q; (ch = ch || {}).q = q; }
      if (el.gpR.value !== '' && r === Math.floor(r) && r >= 1 && r <= GP_R_MAX && r !== gpCfg.r) { gpCfg.r = r; (ch = ch || {}).r = r; }
      saveGpStore();
      if (ch && !(setupV && setupV.room) && callbacks.onSetup) callbacks.onSetup(ch);
    };
    var committed = function () {
      var ch = commitLaps();
      if (ch && callbacks.onSetup) callbacks.onSetup(ch);
    };
    // 輪胎損耗 ×1..×5
    markWear();
    el.gpWear.addEventListener('click', function (e) {
      var w = e.target && e.target.getAttribute && Number(e.target.getAttribute('data-w'));
      if (!(w >= 1 && w <= WEAR_MAX) || !setupEditable()) return;
      gpCfg.wear = w;
      markWear(w);
      saveGpStore();
      if (callbacks.onSetup) callbacks.onSetup({ wear: w });
    });
    el.gpCarChange.addEventListener('click', function () { el.gpCarChange.blur(); setTab('car', true); });
    // 起跑輪胎 / 下一組輪胎 (the 大獎賽 tab and the start panel / lobby): main.js decides (setCompound comes back), the
    // button is marked at once
    var tyreClick = function (e) {
      var c = e.target && e.target.getAttribute ? e.target.getAttribute('data-c') : null;
      if (!c || !Object.prototype.hasOwnProperty.call(COMPOUNDS, c)) return;
      nextCmp = c;
      renderTyre();
      if (callbacks.onCompound) callbacks.onCompound(c);
    };
    if (el.gpTyre) el.gpTyre.addEventListener('click', tyreClick);
    if (el.setupTyre) el.setupTyre.addEventListener('click', tyreClick);
    var action = function (btn, a) {
      btn.addEventListener('click', function () {
        btn.blur();                          // a focused button would take Space / Enter while driving
        if (callbacks.onGpAction) callbacks.onGpAction(a);
      });
    };
    el.gpQ.addEventListener('input', typed);
    el.gpR.addEventListener('input', typed);
    el.gpQ.addEventListener('change', committed);
    el.gpR.addEventListener('change', committed);
    // Enter in a lap field: alone it starts (as 開始); in a room it only takes the value
    var enter = function (e) {
      if (e.key !== 'Enter') return;
      committed();
      if (setupV && !setupV.room && setupV.show === 'setup') goClick();
    };
    el.gpQ.addEventListener('keydown', enter);
    el.gpR.addEventListener('keydown', enter);
    action(el.gpSkip, 'skip'); action(el.gpAgain, 'again'); action(el.gpResAgain, 'again'); action(el.gpResEnd, 'end');
    // 結束大獎賽: alone (and in a room's race) at once; a room in qualifying / on the grid goes back to its lobby: asked
    el.gpEnd.addEventListener('click', function () {
      el.gpEnd.blur();
      var room = !!gpView.room || !!gpView.online;
      if (room && (gpPhase === 'quali' || gpPhase === 'grid')) { gpConfirm = true; renderGp(); if (el.gpConfirmYes) el.gpConfirmYes.focus(); return; }
      if (callbacks.onGpAction) callbacks.onGpAction('end');
    });
    if (el.gpConfirmYes) el.gpConfirmYes.addEventListener('click', function () {
      gpConfirm = false; renderGp();
      if (callbacks.onGpAction) callbacks.onGpAction('end');
    });
    if (el.gpConfirmNo) el.gpConfirmNo.addEventListener('click', function () { gpConfirm = false; renderGp(); });
    // a room's results: 回到大廳 (the tab, the overlay)
    var back = function (btn) {
      if (btn) btn.addEventListener('click', function () { btn.blur(); if (callbacks.onRoomBack) callbacks.onRoomBack(); });
    };
    back(el.gpLobby); back(el.gpResLobby);
    // 在目前賽道開大獎賽…: the start panel of the loaded track with 大獎賽 selected
    if (el.gpOpen) el.gpOpen.addEventListener('click', function () {
      el.gpOpen.blur();
      if (gpCfg.mode !== 'gp') { gpCfg.mode = 'gp'; saveGpStore(); }
      if (callbacks.onGpOpen) callbacks.onGpOpen();
    });
    el.gpClose.addEventListener('click', function () {
      el.gpClose.blur();
      gpClosed = true;
      showResults(false);
    });

    renderGp();
    renderPad();
  }

  /* ---------- v7.2: the start panel / the room lobby (#setup), the host's track picker, a room's loading screen ---------- */

  // A field that takes the keys (as main.js's isTyping): the focus is never moved away from one.
  function typingIn(t) {
    if (!t || !t.tagName) return false;
    if (t.tagName === 'INPUT') return !/^(range|checkbox|radio|button|submit)$/i.test(String(t.type));
    return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true;
  }
  function shownEl(n) { return !!n && !n.classList.contains('hidden') && !n.disabled; }
  function focusEl(n) {
    if (!n) return;
    try { n.focus({ preventScroll: true }); } catch (err) { n.focus(); }
  }
  // the scroll position of the left area (≤ 720 px the whole menu scrolls: .menu-main)
  function scrollPos() { return { b: el.body ? el.body.scrollTop : 0, m: el.main ? el.main.scrollTop : 0 }; }
  function setScroll(p) {
    if (el.body) el.body.scrollTop = p ? p.b : 0;
    if (el.main) el.main.scrollTop = p ? p.m : 0;
  }

  // The track / season rows: in the room they belong to the room's settings (right), alone to the panel (left).
  function placeRows(room) {
    if (roomRows === room || !el.setupRoomRows) return;
    roomRows = room;
    if (room) {
      el.setupRoomRows.appendChild(el.setupTrack);
      el.setupRoomRows.appendChild(el.setupYearRow);
    } else {
      el.setupColA.insertBefore(el.setupTrack, el.setupColA.firstChild);
      el.setupOwn.insertBefore(el.setupYearRow, el.setupTyreRow);
    }
  }

  var LOBBY_ST = { host: '房主', ready: '準備好了 ✓', wait: '還沒準備', 'load-wait': '載入中…', 'load-done': '已載入', 'load-fail': '載入失敗' };

  // The room's players (humans, slot order): name, 你, the car, and per room state 房主 / 準備好了 / 還沒準備 (lobby),
  // 載入中… / 已載入 / 載入失敗 (loading); in a session no state column (a player whose load failed: 載入失敗).
  function lobbyRowsHtml(v) {
    var list = Array.isArray(v.players) ? v.players : [], st = str(v.st), html = '';
    for (var i = 0; i < list.length && i < 32; i++) {
      var p = list[i] && typeof list[i] === 'object' ? list[i] : {}, s = '';
      if (st === 'loading') s = p.load === 'done' ? 'load-done' : p.load === 'fail' ? 'load-fail' : 'load-wait';
      else if (st === 'lobby') s = p.isHost ? 'host' : (p.ready ? 'ready' : 'wait');
      else if (p.load === 'fail') s = 'load-fail';
      var id = typeof p.id === 'number' && isFinite(p.id) ? String(p.id) : '';
      var car = str(p.carName);
      html += '<li class="lobby-row' + (p.isSelf ? ' self' : '') + '" data-id="' + esc(id) + '">' +
        '<span class="mp-dot" style="background:' + cleanColour(p.colour) + '"></span>' +
        '<span class="mp-pname">' + esc(p.name) + '</span>' +
        (p.isSelf ? '<span class="mp-tag">你</span>' : '') + (p.isHost && st !== 'lobby' ? '<span class="mp-tag">房主</span>' : '') +
        '<span class="lobby-car">' + (car ? '<i style="background:' + cleanColour(p.colour2) + '"></i><span>' + esc(car) + '</span>' : '') + '</span>' +
        (s ? '<span class="lobby-st" data-state="' + s + '">' + LOBBY_ST[s] + '</span>' : '') + '</li>';
    }
    return html;
  }

  // The room's computer drivers: one line (電腦車手 ×m（level）) and their names as chips, not a row each.
  function botsLineHtml(v) {
    var list = Array.isArray(v.botList) ? v.botList : [], chips = '';
    if (!list.length) return '';
    for (var i = 0; i < list.length && i < 16; i++) {
      var e = list[i] && typeof list[i] === 'object' ? list[i] : {}, lv = levelName(e.skill);
      chips += '<span class="gp-bot" title="' + esc((e.team ? e.team + ' ‧ ' : '') + lv) + '"><i style="background:' +
        livery({ colour: e.colour, colour2: e.colour2 }) + '"></i>' + esc(e.name) + '</span>';
    }
    var lvl = typeof v.botSkill === 'string' && Object.prototype.hasOwnProperty.call(BOT_LEVEL_NAME, v.botSkill) ? BOT_LEVEL_NAME[v.botSkill] : '';
    return '電腦車手 ×' + list.length + (lvl ? '（' + lvl + '）' : '') + '<div class="gp-bots-names">' + chips + '</div>';
  }

  // The confirm row's question for 不等了，直接開始 (four names at most).
  function unreadyText(v) {
    var n = Array.isArray(v.unready) ? v.unready.map(str) : [];
    var who = n.length > 4 ? n.slice(0, 4).join('、') + ' 等 ' + n.length + ' 人' : n.join('、');
    return (who || '有玩家') + ' 還沒按準備。仍要開始嗎？他們也會一起載入賽道。';
  }

  function renderSetup() {
    if (!inited || !el.setup) return;
    var v = setupV || { show: 'tracks' };
    var show = v.show === 'setup' || v.show === 'picker' ? v.show : 'tracks', room = !!v.room;
    var menuOn = !el.menu.classList.contains('hidden');
    if (show === 'setup' && shownView !== 'setup') gridScroll = scrollPos();   // (the cards' place, for coming back)
    if (cache.setupshow !== show) {
      cache.setupshow = show;
      el.menu.classList.toggle('setup-open', show === 'setup');
      el.menu.classList.toggle('picker', show === 'picker');
    }
    if (cache.setupisroom !== room) {
      cache.setupisroom = room;
      el.menu.classList.toggle('room-view', room);
      el.setup.classList.toggle('room', room);
      confirmKind = '';
    }
    setShown('setup', el.setup, show === 'setup');
    placeRows(room);

    /* the tools row: ← back (the panel, the picker), the lobby's title and address */
    setShown('setupback', el.setupBack, (show === 'setup' && !room) || show === 'picker');
    setText('setupbacktxt', el.setupBack, show === 'picker' ? '← 返回大廳' : '← 選擇其他賽道');
    var head = room && show === 'setup', addr = str(v.address);
    setShown('setuptitle', el.setupTitle, head);
    setShown('setuproom', el.setupRoom, head);
    setHtml('setupaddr', el.setupAddr, addr ? esc(v.isHost && !v.ded ? '位址 ' : '已連線到 ') + '<b>' + esc(addr) + '</b>' : '');
    setShown('setupcopy', el.setupCopy, addr);
    setShown('setuppw', el.setupPw, !!v.hasPassword);
    // the picker's banner (over the cards)
    var banner = show === 'picker' ? str(v.banner) : '';
    setText('lock', el.lock, banner);
    setShown('lockon', el.lock, banner);

    if (show !== 'setup') {
      if (shownView === 'setup') {            // back to the cards: where they were, the panel's card focused
        setScroll(gridScroll);
        var tid0 = setupV && typeof setupV.trackId === 'string' ? setupV.trackId : '';
        for (var c = 0; c < cards.length && tid0 && menuOn; c++) {
          if (builtFor[c] && builtFor[c].id === tid0) { if (!typingIn(document.activeElement)) focusEl(cards[c].node); break; }
        }
      }
      if (menuOn) { shownView = show; focusKey = show; }
      return;
    }
    if (shownView !== 'setup' && menuOn) setScroll(null);   // the panel from its top

    /* the track */
    var td = v.track && typeof v.track === 'object' ? v.track : null, tid = td ? str(td.id) : str(v.trackId), z = td ? zhOf(td) : null;
    setText('stname', el.setupTrackName, td ? (z ? z.name : str(td.name)) : (tid || '還沒選賽道'));
    setText('sten', el.setupTrackEn, td && z ? str(td.name) : '');
    if (cache.stmap !== tid) { cache.stmap = tid; el.setupTrackMap.innerHTML = td ? thumbSvg(td.points) : ''; }
    setText('stmeta', el.setupTrackMeta, td ? [z && z.location ? z.location : str(td.location), fmtKm(td.lengthKm)].filter(Boolean).join(' ‧ ') : '');
    setShown('stcur', el.setupCurrent, !room && !!v.current);
    setShown('stbtn', el.setupTrackBtn, room && !!v.canPick);
    setText('stbtntxt', el.setupTrackBtn, tid ? '換賽道' : '選賽道');
    var miss = room && v.trackMissing ? '你的版本沒有這條賽道（' + tid + '），請更新遊戲。' : '';
    setText('stmiss', el.setupTrackMissing, miss);
    setShown('stmisson', el.setupTrackMissing, miss);

    /* the room's players, the titles of its cards */
    setShown('setuppeople', el.setupPeople, room);
    setShown('setupowntitle', el.setupOwnTitle, room);
    setShown('setupoptstitle', el.setupOptsTitle, room);
    setShown('setupoptsnote', el.setupOptsNote, room && !v.isHost);
    if (room) {
      var cn = v.counts && typeof v.counts === 'object' ? v.counts : {}, nh = count(cn.humans);
      var nb = Array.isArray(v.botList) ? Math.min(16, v.botList.length) : 0;
      setText('lobbytitle', el.setupPlayersTitle, nb ? '玩家（' + nh + ' 人 + 電腦 ' + nb + '，' + (nh + nb) + ' / 16）' : '玩家（' + nh + ' / 16）');
      setHtml('lobbyrows', el.setupPlayers, lobbyRowsHtml(v));
      var bl = botsLineHtml(v);
      setHtml('botsline', el.setupBotsLine, bl);
      setShown('botslineon', el.setupBotsLine, bl);
    }

    /* mode, laps, tyre wear (the 電腦車手 rows: renderBots, from setGp) */
    var mode = v.mode === 'gp' ? 'gp' : 'free', edit = v.canEdit !== false;
    markSeg(el.setupMode, 'data-m', mode, !edit);
    setText('modenote', el.setupModeNote, MODE_NOTE[mode]);
    setShown('setupgp', el.setupGp, mode === 'gp');
    var q = cleanLaps(v.q, GP_Q_MAX, gpCfg.q), r = cleanLaps(v.r, GP_R_MAX, gpCfg.r), w = cleanWear(v.wear, gpCfg.wear);
    if (document.activeElement !== el.gpQ && el.gpQ.value !== String(q)) el.gpQ.value = String(q);
    if (document.activeElement !== el.gpR && el.gpR.value !== String(r)) el.gpR.value = String(r);
    if (el.gpQ.disabled !== !edit) el.gpQ.disabled = !edit;
    if (el.gpR.disabled !== !edit) el.gpR.disabled = !edit;
    markSeg(el.gpWear, 'data-w', w, !edit);
    var note = str(v.note);
    setText('setupnote', el.setupNote, note);
    setShown('setupnoteon', el.setupNote, note);
    var state = str(v.banner);
    setText('setupstate', el.setupState, state);
    setShown('setupstateon', el.setupState, state);

    /* the action block */
    var go = v.go && typeof v.go === 'object' ? v.go : {}, rd = v.ready && typeof v.ready === 'object' ? v.ready : {};
    if (confirmKind === 'force' && !(v.force && go.show)) confirmKind = '';   // (its reason went away)
    if (confirmKind === 'back' && !v.lobbyBtn) confirmKind = '';
    setShown('setupacts', el.setupActs, !confirmKind);
    setShown('setupconfirm', el.setupConfirm, confirmKind);
    if (confirmKind) {
      setText('confirmtxt', el.setupConfirmText, confirmKind === 'force' ? unreadyText(v) : '要結束這場大獎賽並回到房間大廳嗎？');
      setText('confirmyes', el.setupForceYes, confirmKind === 'force' ? '仍要開始' : '回到大廳');
      setText('confirmno', el.setupForceNo, confirmKind === 'force' ? '再等等' : '取消');
    }
    setShown('setupgo', el.setupGo, !!go.show);
    setText('golabel', el.setupGoLabel, str(go.label) || '開始');
    setText('gosub', el.setupGoSub, str(go.sub));
    setShown('gosubon', el.setupGoSub, str(go.sub));
    if (el.setupGo.disabled !== !go.enabled) el.setupGo.disabled = !go.enabled;
    var on = !!rd.on;
    setShown('setupready', el.setupReady, !!rd.show);
    setText('readytxt', el.setupReady, on ? '已準備 ✓（再按一下取消）' : '準備');
    if (el.setupReady.getAttribute('aria-pressed') !== String(on)) el.setupReady.setAttribute('aria-pressed', String(on));
    if (el.setupReady.disabled !== !rd.enabled) el.setupReady.disabled = !rd.enabled;
    var status = rd.show ? str(rd.status)
      : (room && v.isHost && go.show && Array.isArray(v.unready) && v.unready.length ? v.unready.map(str).join('、') + ' 還沒按準備' : '');
    setText('setupstatus', el.setupStatus, status);
    setShown('setupstatuson', el.setupStatus, status);
    setShown('setupforce', el.setupForce, !!v.force);
    setShown('setupresume', el.setupResume, !!v.resume);
    setShown('setuplobby', el.setupLobby, !!v.lobbyBtn);
    var hint = str(v.hint);
    setText('setuphint', el.setupHint, hint);
    setShown('setuphinton', el.setupHint, hint);
    markScrolls();

    // the focus moves only when the view changes (never out of a field being typed in): Enter / Space then press 開始
    // (alone, the host), 準備 (a guest), 繼續駕駛 (a room's session)
    if (menuOn) {
      var fk = 'setup|' + (room ? 'r|' + (v.isHost ? 'h' : 'g') + '|' + str(v.st) : 's|' + tid);
      var t = room ? (v.st === 'session' ? el.setupResume : (v.isHost ? el.setupGo : el.setupReady)) : el.setupGo;
      if (fk !== focusKey) {
        focusKey = fk;
        focusWait = null;
        if (shownEl(t) && !typingIn(document.activeElement)) focusEl(t);
        else focusWait = t;                   // (e.g. the host's 開始 while a guest is not ready: once it can be used)
      } else if (focusWait === t && shownEl(t) && (!document.activeElement || document.activeElement === document.body)) {
        focusWait = null;                     // usable now, and nothing else has the focus: Enter presses it
        focusEl(t);
      }
      shownView = 'setup';
    }
  }

  // #setup.scrolls: the panel / lobby is taller than the left area (≤ 720 px: the whole menu scrolls), so the action
  // block, sticky at the bottom, gets an opaque backing (without it the text would show through)
  function markScrolls() {
    if (!el.setup || el.setup.classList.contains('hidden')) return;
    var s = window.innerWidth <= 720 ? el.main : el.body, on = !!s && s.scrollHeight > s.clientHeight + 1;
    if (cache.setupscrolls !== on) { cache.setupscrolls = on; el.setup.classList.toggle('scrolls', on); }
  }

  // 開始 (the button, Enter in a lap field alone, the controller's A through setupKey)
  function goClick() {
    var v = setupV;
    if (!v || !v.go || !v.go.show || !v.go.enabled || el.setupGo.disabled) return;
    var ch = commitLaps();
    if (ch && v.room && callbacks.onSetup) callbacks.onSetup(ch);   // (the host's typed laps go before the start)
    var c = v.room ? { mode: v.mode, q: v.q, r: v.r, wear: v.wear } : { mode: gpCfg.mode, q: gpCfg.q, r: gpCfg.r, wear: gpCfg.wear };
    if (ch && v.room) { if (ch.q) c.q = ch.q; if (ch.r) c.r = ch.r; }
    c.force = false;
    if (callbacks.onSetupStart) callbacks.onSetupStart(c);
  }
  function readyClick() {
    var v = setupV;
    if (!v || !v.ready || !v.ready.show || !v.ready.enabled) return;
    if (callbacks.onReady) callbacks.onReady(!v.ready.on);
  }
  function openConfirm(kind) {
    confirmKind = kind;
    renderSetup();
    if (confirmKind) focusEl(el.setupForceYes);
  }
  function closeConfirm() {
    var k = confirmKind;
    confirmKind = '';
    renderSetup();
    focusEl(k === 'back' ? el.setupLobby : el.setupForce);
  }
  function confirmYes() {
    var k = confirmKind, v = setupV;
    confirmKind = '';
    renderSetup();
    if (k === 'force' && v) {
      var ch = commitLaps();
      if (ch && callbacks.onSetup) callbacks.onSetup(ch);
      var c = { mode: v.mode, q: ch && ch.q ? ch.q : v.q, r: ch && ch.r ? ch.r : v.r, wear: v.wear, force: true };
      if (callbacks.onSetupStart) callbacks.onSetupStart(c);
    } else if (k === 'back' && callbacks.onRoomBack) callbacks.onRoomBack();
  }

  // 複製: the room's address to the clipboard (a fallback where the Clipboard API is not allowed)
  function copyAddress() {
    var a = setupV ? str(setupV.address) : '';
    if (!a) return;
    var done = function () { ui.toast('已複製位址', 2000); };
    var fallback = function () {
      try {
        var t = document.createElement('textarea');
        t.value = a; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(t); t.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(t);
        if (ok) done();
      } catch (err) { /* nothing to copy with */ }
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') navigator.clipboard.writeText(a).then(done, fallback);
      else fallback();
    } catch (err) { fallback(); }
  }

  var RL_ST = { wait: '載入中…', done: '已載入', fail: '載入失敗' };

  // A room's loading screen: the track and mode, every player's state, the time left, 不等了，開始 / 取消，回到大廳 (host).
  function renderRoomLoading() {
    if (!inited || !el.rl) return;
    var v = rlView, on = !!v;
    if (on && el.rl.classList.contains('hidden')) {   // appearing: nothing under it keeps the keyboard
      var a = document.activeElement;
      if (a && a !== document.body && a.blur) a.blur();
    }
    setShown('rl', el.rl, on);
    if (!on) return;
    setText('rltitle', el.rlTitle, str(v.title) || '載入賽道中…');
    setText('rlsub', el.rlSub, str(v.sub));
    var rows = Array.isArray(v.rows) ? v.rows : [], html = '';
    for (var i = 0; i < rows.length && i < 32; i++) {
      var r = rows[i] && typeof rows[i] === 'object' ? rows[i] : {}, s = RL_ST[r.state] ? r.state : 'wait';
      var id = typeof r.id === 'number' && isFinite(r.id) ? String(r.id) : '';
      html += '<li class="rl-row' + (r.isSelf ? ' self' : '') + '" data-id="' + esc(id) + '" data-state="' + s + '">' +
        '<span class="mp-dot" style="background:' + cleanColour(r.colour) + '"></span><span class="mp-pname">' + esc(r.name) + '</span>' +
        (r.isHost ? '<span class="mp-tag">房主</span>' : '') + (r.isSelf ? '<span class="mp-tag">你</span>' : '') +
        '<span class="rl-st">' + RL_ST[s] + '</span></li>';
    }
    setHtml('rllist', el.rlList, html);
    var left = typeof v.leftS === 'number' && v.leftS >= 0 && isFinite(v.leftS) ? '最多再等 ' + Math.ceil(v.leftS) + ' 秒' : '';
    setText('rlleft', el.rlLeft, left);
    setShown('rllefton', el.rlLeft, left);
    setShown('rlgo', el.rlGo, !!v.canGo);
    setShown('rlcancel', el.rlCancel, !!v.canCancel);
  }

  function initSetup() {
    if (!el.setup) return;
    el.setupBack.addEventListener('click', function () { if (callbacks.onSetupBack) callbacks.onSetupBack(); });
    el.setupGo.addEventListener('click', goClick);
    el.setupReady.addEventListener('click', readyClick);
    el.setupForce.addEventListener('click', function () { openConfirm('force'); });
    el.setupForceYes.addEventListener('click', confirmYes);
    el.setupForceNo.addEventListener('click', closeConfirm);
    el.setupResume.addEventListener('click', function () { if (resumeFn) resumeFn(); });
    // 回到大廳 (the room's session menu, host): asked while a Grand Prix is on and not in its results
    el.setupLobby.addEventListener('click', function () {
      var p = setupV ? setupV.phase : '';
      if (p === 'quali' || p === 'grid' || p === 'race') openConfirm('back');
      else if (callbacks.onRoomBack) callbacks.onRoomBack();
    });
    el.setupTrackBtn.addEventListener('click', function () { if (callbacks.onRoomTrackPicker) callbacks.onRoomTrackPicker(); });
    el.setupCarChange.addEventListener('click', function () {
      setTab('car', true);
      // (a narrow window: the side panel is under the panel)
      if (el.main && el.main.scrollHeight > el.main.clientHeight + 4 && el.mpPanel.scrollIntoView) el.mpPanel.scrollIntoView({ block: 'start' });
    });
    el.setupMode.addEventListener('click', function (e) {
      var m = e.target && e.target.getAttribute ? e.target.getAttribute('data-m') : null;
      if ((m !== 'free' && m !== 'gp') || !setupEditable()) return;
      var cur = setupV && setupV.room ? setupV.mode : gpCfg.mode;
      if (m !== gpCfg.mode) { gpCfg.mode = m; saveGpStore(); }   // (alone the setup; the host's preference too)
      if (m === cur) return;
      markSeg(el.setupMode, 'data-m', m);
      setShown('setupgp', el.setupGp, m === 'gp');
      if (callbacks.onSetup) callbacks.onSetup({ mode: m });
    });
    el.setupLeave.addEventListener('click', function () { if (callbacks.onLeaveRoom) callbacks.onLeaveRoom(); });
    el.setupCopy.addEventListener('click', copyAddress);
    el.rlGo.addEventListener('click', function () { if (callbacks.onRoomGo) callbacks.onRoomGo(); });
    el.rlCancel.addEventListener('click', function () { if (callbacks.onRoomBack) callbacks.onRoomBack(); });
    el.rlLeave.addEventListener('click', function () { if (callbacks.onLeaveRoom) callbacks.onLeaveRoom(); });
    window.addEventListener('resize', markScrolls);
    renderSetup();
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
    var en = ersNote(c), drv = carDrivers(c.id);
    return '<button type="button" class="car-card" data-id="' + c.id + '" aria-pressed="false">' +
      '<span class="car-head"><i class="car-chip" style="background:' + cleanColour(c.colour) + '"></i>' +
      (isColour(c.colour2) ? '<i class="car-chip" style="background:' + c.colour2 + '"></i>' : '') +
      '<span class="car-team">' + teamHtml(c) + '</span><span class="car-model">' + esc(c.car) + '</span></span>' +
      (c.engine ? '<span class="car-engine">' + esc(c.engine) + '</span>' : '') +
      '<span class="car-bars">' + bars + '</span>' +
      (en ? '<span class="car-ers"><b>電池</b>' + esc(en) + '</span>' : '') +
      (drv ? '<span class="car-drv"><b>車手</b>' + drv + '</span>' : '') +
      (c.note ? '<span class="car-note">' + esc(c.note) + '</span>' : '') + '</button>';
  }

  // Who drives this car in the field now (setCars v.drivers = {carId: [{name, bot, self}]}, optional): '你', the room's
  // players and the computer drivers (AI tag). A human takes one of the team's two seats, the computer drivers the others.
  function carDrivers(id) {
    var d = carsView && carsView.drivers && typeof carsView.drivers === 'object' && Object.prototype.hasOwnProperty.call(carsView.drivers, id)
      ? carsView.drivers[id] : null, out = [];
    if (!Array.isArray(d)) return '';
    for (var i = 0; i < d.length && out.length < 6; i++) {
      var e = d[i];
      if (!e || typeof e !== 'object') continue;
      if (e.self === true) out.push('<em>你</em>');
      else if (typeof e.name === 'string' && e.name) out.push(esc(e.name.slice(0, 24)) + (e.bot === true ? '<i>AI</i>' : ''));
    }
    return out.join('、');
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
    // the start panel's / lobby's 賽季 (the same seasons; a room's season for its guests, read-only)
    if (el.setupYear) {
      setHtml('setupyears', el.setupYear, opts);
      if (year && el.setupYear.value !== String(year)) el.setupYear.value = String(year);
      if (el.setupYear.disabled !== !(canYear && years.length > 1)) el.setupYear.disabled = !(canYear && years.length > 1);
    }
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
    var yearPicked = function (sel) {
      var y = cleanYear(sel.value);
      if (!y || !canPick.year) {
        if (carsYear) sel.value = String(carsYear);
        return;
      }
      pick.year = y;
      saveCarStore();
      // until setCars brings that year's cars, the list on screen is last year's: dim it
      el.carList.classList.toggle('pending', y !== carsYear);
      if (callbacks.onYear) callbacks.onYear(y);
    };
    el.carYear.addEventListener('change', function () { yearPicked(el.carYear); });
    if (el.setupYear) el.setupYear.addEventListener('change', function () { yearPicked(el.setupYear); });
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
    initFovSetting();
    initMirrorSetting();
  }

  /* ---------- 設定: the cockpit's field of view ---------- */

  function fovLimits() {
    var c = F1.COCKPIT_FOV;
    if (c && typeof c === 'object' && isFinite(c.min) && isFinite(c.max) && isFinite(c.def) && c.min < c.max && c.def >= c.min && c.def <= c.max) {
      return { def: Math.round(c.def), min: Math.ceil(c.min), max: Math.floor(c.max) };
    }
    return FOV_FALLBACK;
  }

  // a FOV in whole degrees inside the range, else null (only numbers: a string from storage is not taken)
  function cleanFov(v) {
    var L = fovLimits(), n = typeof v === 'number' ? Math.round(v) : NaN;
    return isFinite(n) ? (n < L.min ? L.min : n > L.max ? L.max : n) : null;
  }

  function fovNow() { return fovSet !== null ? fovSet : fovLimits().def; }

  function loadFovStore() {
    try {
      var o = JSON.parse(window.localStorage.getItem(FOV_STORE_KEY) || 'null');
      if (o && typeof o === 'object') fovSet = cleanFov(o.fov);
    } catch (err) { /* storage unavailable or corrupt: the default */ }
  }

  function saveFovStore() {
    try { window.localStorage.setItem(FOV_STORE_KEY, JSON.stringify({ fov: fovSet })); } catch (err) { /* ignore */ }
  }

  function renderFov() {
    if (!inited || !el.setFov) return;
    var L = fovLimits(), v = fovNow();
    if (el.setFov.min !== String(L.min)) el.setFov.min = String(L.min);
    if (el.setFov.max !== String(L.max)) el.setFov.max = String(L.max);
    if (el.setFov.value !== String(v)) el.setFov.value = String(v);
    setText('fov', el.setFovVal, v + '°');
  }

  function initFovSetting() {
    loadFovStore();
    if (el.setFov) el.setFov.addEventListener('input', function () {
      var v = cleanFov(Number(el.setFov.value));
      if (v === null || v === fovNow()) return;
      fovSet = v;
      saveFovStore();
      renderFov();
      if (callbacks.onFov) callbacks.onFov(v);
    });
    renderFov();
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
    // (they cannot be drawn: the HUD hint leaves out V too - main.js says so when V is pressed anyway)
    if (cache.mirrorsna !== !view.available) { cache.mirrorsna = !view.available; el.hud.classList.toggle('mirrors-na', !view.available); }
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
    // the next set and how to change it (v6.2): 下一組：中性胎（X / T 切換） (the controller's button first with a pad)
    var nxt = c.next ? '下一組：<b class="c-' + c.next + '">' + COMPOUNDS[c.next] + '</b>（' +
      (c.pad ? '<kbd>X</kbd> / <kbd>T</kbd>' : '<kbd>T</kbd> / <kbd>X</kbd>') + ' 切換）' : '';
    setHtml('pitnext', el.pitNext, nxt);
    setShown('pitnexton', el.pitNext, nxt);
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
        c.fill();
        if (o.ring) {                           // a computer driver: its team's second colour as the ring
          c.lineWidth = 1.8 * r; c.strokeStyle = o.ring; c.stroke();
          c.lineWidth = 1.2 * r; c.strokeStyle = 'rgba(0,0,0,0.85)';
        } else c.stroke();
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
    el.loading = $('loading'); el.loadingName = $('loading-name'); el.loadingTitle = $('loading-title');   // (likewise)
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
    el.setFov = $('set-fov'); el.setFovVal = $('set-fov-val');                        // v6.2: the cockpit's FOV
    el.credits = $('credits'); el.setCredits = $('set-credits');   // credits line -> 資料來源與授權
    // HUD pit strip
    el.pit = $('hud-pit'); el.pitLimit = $('hud-pit-limit'); el.pitLim = $('hud-pit-lim'); el.pitWarn = $('hud-pit-warn');
    el.pitBox = $('hud-pit-box'); el.pitPending = $('hud-pit-pending'); el.pitSvc = $('hud-pit-svc');
    el.pitSvcLabel = $('hud-pit-svc-label'); el.pitSvcTime = $('hud-pit-svc-time'); el.pitBar = $('hud-pit-bar');
    el.pitPen = $('hud-pit-pen'); el.pitNext = $('hud-pit-next');
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
    // Grand Prix panel, HUD session box, start lights, results overlay, controller hints (v7.2: #gp-q / #gp-r / #gp-wear
    // and the 電腦車手 rows live in the start panel / lobby now)
    el.gpQ = $('gp-q'); el.gpR = $('gp-r');
    el.gpHint = $('gp-hint'); el.gpSession = $('gp-session'); el.gpState = $('gp-state'); el.gpSelf = $('gp-self');
    el.gpActions = $('gp-actions'); el.gpSkip = $('gp-skip'); el.gpEnd = $('gp-end'); el.gpAgain = $('gp-again');
    el.gpLobby = $('gp-lobby'); el.gpOpen = $('gp-open');
    el.gpConfirm = $('gp-confirm'); el.gpConfirmYes = $('gp-confirm-yes'); el.gpConfirmNo = $('gp-confirm-no');
    el.gpStandings = $('gp-standings'); el.gpSpec = $('gp-spec');
    el.gpWear = $('gp-wear'); el.gpCar = $('gp-car'); el.gpYear = $('gp-year'); el.gpCarName = $('gp-car-name');
    el.gpCarChange = $('gp-car-change');
    el.gpTyre = $('gp-tyre'); el.gpTyreLabel = $('gp-tyre-label'); el.gpTyreNote = $('gp-tyre-note');   // v6.2
    el.gpBotsBox = $('gp-bots-box'); el.gpBots = $('gp-bots'); el.gpSkill = $('gp-skill');               // v7: 電腦車手
    el.gpBotsNote = $('gp-bots-note'); el.gpBotsList = $('gp-bots-list');
    el.hudGp = $('hud-gp'); el.hudGpTitle = $('hud-gp-title'); el.hudGpPos = $('hud-gp-pos'); el.hudGpYear = $('hud-gp-year');
    el.hudGpLapRow = $('hud-gp-laprow'); el.hudGpLap = $('hud-gp-lap'); el.hudGpNote = $('hud-gp-note');
    el.hudGpEnds = $('hud-gp-ends'); el.hudGpRows = $('hud-gp-rows'); el.hudGpSpec = $('hud-gp-spec');
    el.lights = $('hud-lights'); el.lightsText = $('hud-lights-text');
    el.lamps = el.lights.getElementsByTagName('i');
    el.gpRes = $('gp-results'); el.gpResSub = $('gp-results-sub'); el.gpResBody = $('gp-results-body');
    el.gpResSpec = $('gp-results-spec'); el.gpResNote = $('gp-results-note');
    el.gpResAgain = $('gp-res-again'); el.gpResEnd = $('gp-res-end'); el.gpClose = $('gp-close');
    el.gpResLobby = $('gp-res-lobby');
    el.hintKeys = $('hud-hint-keys'); el.hintPad = $('hud-hint-pad'); el.padStatus = $('pad-status');
    // v7.2: the start panel / the room lobby, the tools row's parts of it, a room's loading screen
    el.main = document.querySelector('#menu .menu-main'); el.body = document.querySelector('#menu .menu-body');
    el.setup = $('setup'); el.setupState = $('setup-state'); el.setupColA = $('setup-col-a');
    el.setupBack = $('setup-back'); el.setupTitle = $('setup-title'); el.setupRoom = $('setup-room');
    el.setupAddr = $('setup-addr'); el.setupCopy = $('setup-copy'); el.setupPw = $('setup-pw'); el.setupLeave = $('setup-leave');
    el.setupTrack = $('setup-track'); el.setupTrackMap = $('setup-track-map'); el.setupTrackName = $('setup-track-name');
    el.setupTrackEn = $('setup-track-en'); el.setupTrackMeta = $('setup-track-meta'); el.setupCurrent = $('setup-current');
    el.setupTrackBtn = $('setup-track-btn'); el.setupTrackMissing = $('setup-track-missing');
    el.setupPeople = $('setup-people'); el.setupPlayersTitle = $('setup-players-title'); el.setupPlayers = $('setup-players');
    el.setupBotsLine = $('setup-bots-line');
    el.setupOwn = $('setup-own'); el.setupOwnTitle = $('setup-own-title'); el.setupCar = $('setup-car');
    el.setupCarChange = $('setup-car-change'); el.setupYearRow = $('setup-year-row'); el.setupYear = $('setup-year');
    el.setupTyreRow = $('setup-tyre-row'); el.setupTyre = $('setup-tyre');
    el.setupOpts = $('setup-opts'); el.setupOptsTitle = $('setup-opts-title'); el.setupOptsNote = $('setup-opts-note');
    el.setupRoomRows = $('setup-room-rows'); el.setupMode = $('setup-mode'); el.setupModeNote = $('setup-mode-note');
    el.setupGp = $('setup-gp'); el.setupNote = $('setup-note');
    el.setupActs = $('setup-acts'); el.setupGo = $('setup-go'); el.setupGoLabel = $('setup-go-label'); el.setupGoSub = $('setup-go-sub');
    el.setupReady = $('setup-ready'); el.setupStatus = $('setup-status'); el.setupForce = $('setup-force');
    el.setupConfirm = $('setup-confirm'); el.setupConfirmText = $('setup-confirm-text');
    el.setupForceYes = $('setup-force-yes'); el.setupForceNo = $('setup-force-no');
    el.setupResume = $('setup-resume'); el.setupLobby = $('setup-lobby'); el.setupHint = $('setup-hint');
    el.rl = $('room-loading'); el.rlTitle = $('room-loading-title'); el.rlSub = $('room-loading-sub');
    el.rlList = $('room-loading-list'); el.rlLeft = $('room-loading-left');
    el.rlGo = $('room-loading-go'); el.rlCancel = $('room-loading-cancel'); el.rlLeave = $('room-loading-leave');
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
      callbacks.onGpAction = opts.onGpAction || null;    // ('skip' | 'end' | 'again')
      // v7.2 (onSelectTrack now means "a card was clicked": the panel opens, or the host's pick for the room)
      callbacks.onSetupStart = opts.onSetupStart || null;            // ({mode, q, r, wear, force}): 開始
      callbacks.onSetupBack = opts.onSetupBack || null;              // (): ← 選擇其他賽道 / ← 返回大廳
      callbacks.onSetup = opts.onSetup || null;                      // ({mode} | {q} | {r} | {wear}): changed in the panel
      callbacks.onReady = opts.onReady || null;                      // (on): a guest's 準備
      callbacks.onRoomTrackPicker = opts.onRoomTrackPicker || null;  // (): the host's 選賽道 / 換賽道
      callbacks.onRoomBack = opts.onRoomBack || null;                // (): the host's 回到大廳 / 取消，回到大廳
      callbacks.onRoomGo = opts.onRoomGo || null;                    // (): the host's 不等了，開始
      callbacks.onGpOpen = opts.onGpOpen || null;                    // (): 在目前賽道開大獎賽…
      callbacks.onYear = opts.onYear || null;            // (year): the player picked a season
      callbacks.onCar = opts.onCar || null;              // (id): the player picked a car of the list
      callbacks.onAudio = opts.onAudio || null;          // ({volume, muted}): slider / mute switch moved
      callbacks.onMirrors = opts.onMirrors || null;      // (on): the 後照鏡 switch of 設定 flipped
      callbacks.onFov = opts.onFov || null;              // (deg): the 視野 slider of 設定 moved (whole degrees)
      callbacks.onCompound = opts.onCompound || null;    // ('S' | 'M' | 'H'): the 起跑輪胎 / 下一組輪胎 row of 大獎賽
      callbacks.onBots = opts.onBots || null;            // ({count, skill}): the 電腦車手 rows of 大獎賽 changed
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
      initSetup();
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
     *   hostInfo: {port, addresses} | null, roster: [{name, colour, best, isHost, isSelf}] } (v7.2: the room's track and
     *   its banner are the setup view's, setSetup; roomTrack / lockText are no longer read) 
     */
    setNet: function (v) {
      netView = v || {};
      renderNet();
    },

    /**
     * Grand Prix: menu panel (Q / R, 開始 / 跳過排位 / 結束 / 再來一場, state, standings), HUD session box (replaces
     * the roster box while a session is on) and the results overlay. v = GpView (js/README-interfaces.md) plus
     * canStart (v7.2: alone, a track is loaded: 在目前賽道開大獎賽… is offered) and room (v7.2: in a room - the results and
     * the tab offer the host 回到大廳 instead of 結束; in qualifying / on the grid 結束大獎賽 asks first); an optional v.sid
     * re-opens a closed results overlay when the session changes.
     * v7: v.bots = {count, skill, max, canEdit, available} (the 電腦車手 rows; available false hides them), v.botList =
     * [{name, colour, colour2, team, skill}] (the field, listed in free practice), rows[i].bot / skill (the AI tag).
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
     * when only the year is), drivers (optional, v7: {carId: [{name, bot, self}]} who drives each car in the field now:
     * 你, the room's players, the computer drivers) }. The selection follows `selected`: a card clicked is highlighted at once and
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

    /** The 視野 setting of 設定: the cockpit's vertical FOV in degrees (F1.COCKPIT_FOV.def until the slider is moved;
     *  remembered in localStorage 'f1drive.fov'). */
    getFov: function () { return fovNow(); },

    /**
     * The next set of tyres changed (main.js: T / X, a start): 'S' | 'M' | 'H'. The 大獎賽 tab's 起跑輪胎 /
     * 下一組輪胎 row shows it. Anything else is ignored. Does not call onCompound.
     */
    setCompound: function (c) {
      if (typeof c !== 'string' || !Object.prototype.hasOwnProperty.call(COMPOUNDS, c) || c === nextCmp) return;
      nextCmp = c;
      renderTyre();
    },

    /**
     * The 電腦車手 setting of the 大獎賽 tab: { count: 0..15 computer drivers, skill: 'rookie' | 'amateur' | 'pro' |
     * 'legend' | 'mixed' } (remembered in localStorage 'f1drive.bots'; none by default). Alone it is the field; as the
     * host of a room main.js caps it at the free seats (16 - players). A fresh object.
     */
    getBots: function () { return { count: botCfg.count, skill: botCfg.skill }; },

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
     * the pending hold is served at the exit line), next (optional, v6.2: 'S' | 'M' | 'H', the set fitted at the stop:
     * the line 下一組：中性胎（T / X 切換）) }. Shown while in the lane, while the limiter is on
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
      var next = typeof p.next === 'string' && Object.prototype.hasOwnProperty.call(COMPOUNDS, p.next) ? p.next : '';
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
          c.pending === pending && c.served === served && c.pad === padOn && c.next === next) return;
      c.shown = shown; c.inLane = inLane; c.limiter = limiter; c.speeding = speeding; c.limit = limit; c.slot = slot;
      c.box = box; c.tenths = tenths; c.frac = frac; c.pen = pen; c.penNow = penNow; c.pending = pending; c.served = served; c.pad = padOn;
      c.next = next;
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
     * screen, over the menu and the HUD; null hides the note. title (optional, v7): the note's heading instead of
     * 載入賽道中… (main.js: 電腦車手熟悉賽道中… while the computer drivers' warm-up runs).
     */
    setLoading: function (name, title) {
      if (!inited || !el.loading) return;
      var on = typeof name === 'string';
      // (main.js hands the English name: the note shows the card's Chinese one)
      setText('loadname', el.loadingName, on ? (Object.prototype.hasOwnProperty.call(zhByName, name) ? zhByName[name] : name) : '');
      if (on && el.loadingTitle) setText('loadtitle', el.loadingTitle, typeof title === 'string' && title ? title : '載入賽道中…');
      setShown('loading', el.loading, on);
    },

    /** Optional (not in the interface doc): main.js may register a "resume" handler to show a 繼續駕駛 button. */
    setResumeHandler: function (fn) {
      resumeFn = typeof fn === 'function' ? fn : null;   // (also the room menu's 繼續駕駛, #setup-resume)
      if (!el.resume) return;
      el.resume.onclick = fn || null;
      el.resume.classList.toggle('hidden', !fn);
    },

    /**
     * v7.2: the left area of the menu, from a SetupView (js/README-interfaces.md "v7.2 room lobby"): show 'tracks' (the
     * cards), 'setup' (the start panel alone / the room lobby), 'picker' (the cards as the host's track picker, banner
     * v.banner). Cheap to call often: the DOM is only touched where something changed; the focus moves only when the
     * view changes (開始 alone and for the host, 準備 for a guest, 繼續駕駛 in a room's session).
     */
    setSetup: function (v) {
      setupV = v && typeof v === 'object' ? v : null;
      renderSetup();
    },

    /** v7.2: a room's loading screen from a RoomLoadingView {title, sub, rows: [{id, name, colour, isSelf, isHost, state:
     *  'wait' | 'done' | 'fail'}], leftS, canGo, canCancel}; null hides it. */
    setRoomLoading: function (v) {
      rlView = v && typeof v === 'object' ? v : null;
      renderRoomLoading();
    },

    /** v7.2: the remembered solo setup of the start panel {mode: 'free' | 'gp', q, r, wear} ('f1drive.gp'). */
    getSetup: function () { return { mode: gpCfg.mode, q: gpCfg.q, r: gpCfg.r, wear: gpCfg.wear }; },

    /**
     * v7.2: a key main.js does not handle itself, in the menu: 'a' (the controller's A: 開始 alone and for the host - the
     * first A asks while somebody is not ready, the second confirms -, a guest's 準備), 'b' / 'esc' (the controller's B,
     * Esc: close the confirm row). -> true when it was used here.
     */
    setupKey: function (k) {
      if (!inited || rlView || el.menu.classList.contains('hidden')) return false;
      if (gpConfirm && (k === 'b' || k === 'esc')) { gpConfirm = false; renderGp(); return true; }
      if (confirmKind) {
        if (k === 'a') { confirmYes(); return true; }
        if (k === 'b' || k === 'esc') { closeConfirm(); return true; }
      }
      var v = setupV;
      if (k !== 'a' || !v || v.show !== 'setup') return false;
      if (v.go && v.go.show && v.go.enabled) { goClick(); return true; }
      if (v.force) { openConfirm('force'); return true; }
      if (v.ready && v.ready.show && v.ready.enabled) { readyClick(); return true; }
      return false;
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
      loadedId = typeof trackData.id === 'string' ? trackData.id : '';
      markCurrentCard();                      // (v7.2: the cards mark the loaded track 目前賽道)
      setText('track', el.track, trackLabel(trackData));   // (v6.2: the Chinese name; the results subtitle uses it too)
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
      drawMap(h.x, h.z, h.heading, h.others);   // others (optional): [{x, z, colour, ring?}] the other cars (ring: a bot's 2nd colour)
      if (gpEndsAt) tickGpCountdown();
      if (tele) tele.draw(h);                   // never throws; a no-op while the HUD is hidden
    },

    formatTime: fmtTime,

    /** The track search of the menu, without the DOM (tests / harnesses): -> the ids of the tracks of `list` (trackData
     *  objects) the query finds, in list order. */
    searchTracks: function (list, query) {
      var terms = queryTerms(query), out = [];
      for (var i = 0; list && i < list.length; i++) {
        var key = searchKey(list[i], zhOf(list[i])), ok = true;
        for (var k = 0; k < terms.length && ok; k++) ok = termMatch(key, terms[k]);
        if (ok) out.push(list[i].id);
      }
      return out;
    }
  };

  F1.ui = ui;
})();
