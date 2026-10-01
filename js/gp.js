// F1Drive - Grand Prix controller (F1.gp): the client side of net/session.js. See js/README-interfaces.md.
// Pure logic: no DOM, no THREE, no timers. One object for both modes:
//   online  - mirrors the room's session (net.session, delivered by net's 'gp' event); clock = net.serverNow()
//   offline - owns a local F1.createSession() with the player (id 1) and his computer drivers (setBots: ids 2..16);
//             clock = a GAME clock that only advances in update(dt), so the session stands still while the menu is open
// Computer drivers ("bots") are players of the session like any other; the game that simulates them (offline: this
// one; in a room: the host's) reports their laps / progress through botLap / botProgress and asks entry(id) / solid().
// Loadable in node: require('./js/gp.js') -> F1.gp; globalThis.F1.createGp() -> a fresh controller (tests).
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  // net/session.js: on window.F1 in the browser (it is loaded before this file), require()d in node
  var lib = F1.Session || (F1.createSession ? { createSession: F1.createSession } : null);
  if (!lib && typeof require === 'function') lib = require('../net/session');

  var LIGHTS = (lib && lib.LIGHTS) || 5;
  var LIGHT_MS = (lib && lib.LIGHT_MS) || 1000;   // one more red light every second
  var GO_FLASH_MS = 1500;                         // "lights out" indicator
  var LIVE_MS = 500;                              // offline race: live standings refreshed this often (game clock), as a
                                                  //   room re-sends them (net/server.js GP_LIVE_MS)
  var CLOCK_BASE = 1000000;                       // ms: where the offline game clock starts (any value > 0)
  var SELF_OFFLINE = 1;                           // our id in the local session
  var GREY = '#888888';                           // drivers whose colour we do not know (they left)
  var MAX_PLAYERS = 64, NAME_MAX = 32;
  var PHASES = { free: 1, quali: 1, grid: 1, race: 1, results: 1 };
  var YEAR_MIN = 2010, YEAR_MAX = 2100, WEAR_MAX = 5;
  // computer drivers: a room holds 16 cars (net/server.js); offline the player is id 1 and his bots 2..16
  var ROOM_MAX = 16, BOT_ID0 = 2, BOT_NAME_MAX = 16;
  var LEVEL_SKILL = { rookie: 0, amateur: 0.35, pro: 0.7, legend: 1, mixed: null };   // as F1.AI.LEVELS, + 'mixed'
  var LEVEL_DEFAULT = 'pro';

  function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function whole(v) { return isNum(v) && v > 0 ? Math.floor(v) : 0; }
  function cleanYear(v) { return typeof v === 'number' && v % 1 === 0 && v >= YEAR_MIN && v <= YEAR_MAX ? v : null; }
  function positive(v) { return isNum(v) && v > 0 ? v : 0; }
  function lapTime(v) { return isNum(v) && v > 0 ? v : null; }
  function cleanColour(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : GREY; }
  function cleanCar(v) { return typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v) ? v : ''; }
  function cleanSkill(v) { return isNum(v) ? Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000 : null; }
  function cleanLevel(v) { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_SKILL, v) ? v : null; }
  function cleanBotName(v, fallback) {     // as the server cleans a name: no control / formatting characters, <= 16
    if (typeof v !== 'string') return fallback;
    var s = '';
    for (var i = 0; i < v.length; i++) {
      var c = v.charCodeAt(i);
      // C0 / C1 controls, zero-width and bidi formatting characters, line separators, BOM
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) ||
          (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) continue;
      s += v.charAt(i);
    }
    s = Array.from(s.replace(/\s+/g, ' ').trim()).slice(0, BOT_NAME_MAX).join('').trim();
    return s || fallback;
  }

  // the ids of `list` that are keys of `ok`, each once
  function cleanIds(list, ok) {
    var out = [], seen = {};
    for (var i = 0; i < list.length && out.length < MAX_PLAYERS; i++) {
      var id = list[i];
      if (isNum(id) && ok[id] === true && !seen[id]) { seen[id] = true; out.push(id); }
    }
    return out;
  }

  /**
   * A snapshot from the network is never trusted: -> a plain copy with every field of the expected type,
   * or null when it is not a session snapshot at all (the caller then keeps the one it has).
   */
  function cleanSnapshot(s) {
    if (!s || typeof s !== 'object' || typeof s.phase !== 'string' || PHASES[s.phase] !== 1 || !isNum(s.sid)) return null;
    if (!Array.isArray(s.players) || !Array.isArray(s.order) || !Array.isArray(s.grid)) return null;
    if (s.phase === 'grid' || s.phase === 'race') {            // the start lights need both clocks
      if (!isNum(s.lightsAt) || !isNum(s.goAt) || !(s.goAt > 0) || s.lightsAt > s.goAt) return null;
    }
    var players = [], racing = {}, n = Math.min(s.players.length, MAX_PLAYERS);
    for (var i = 0; i < n; i++) {
      var p = s.players[i];
      if (!p || typeof p !== 'object' || !isNum(p.id)) continue;
      var o = {
        id: p.id, name: typeof p.name === 'string' ? p.name.slice(0, NAME_MAX) : '',
        spec: p.spec === true, left: p.left === true,
        qLaps: whole(p.qLaps), qBest: lapTime(p.qBest), qDone: p.qDone === true,
        rLaps: whole(p.rLaps), rTime: positive(p.rTime), rBest: lapTime(p.rBest),
        fin: p.fin === true, dnf: p.dnf === true,
        gap: isNum(p.gap) ? p.gap : null, down: whole(p.down)
      };
      if (p.bot === true) o.bot = true;               // a computer driver (only its rows carry the field, as on the wire)
      players.push(o);
      if (!o.spec) racing[o.id] = true;
    }
    var q = whole(s.q), r = whole(s.r), wear = whole(s.wear);
    return {
      sid: s.sid, phase: s.phase,
      q: q ? Math.min(q, 20) : 3, r: r ? Math.min(r, 99) : 5, len: positive(s.len),
      year: cleanYear(s.year), wear: wear ? Math.min(wear, WEAR_MAX) : 1,
      lightsAt: positive(s.lightsAt), goAt: positive(s.goAt), winnerAt: positive(s.winnerAt), endsAt: positive(s.endsAt),
      grid: cleanIds(s.grid, racing), order: cleanIds(s.order, racing), players: players
    };
  }

  function createGp() {
    var net = null, getProfile = null;
    var handlers = {};
    var hooked = [];              // the net objects our listeners are on (init() may be called again)
    var local = null;             // the offline session
    var clock = CLOCK_BASE;       // offline game clock, ms
    var byId = {};                // snapshot players by id (somebody still in the room wins over a leaver)
    var racers = {};              // the classified ones (not spectators) by id
    var me = null;                // our own snapshot entry
    var lightsOut = false;        // grid / race and the clock is past goAt
    var goSid = -1;               // the session 'go' was fired for
    var botGoSid = -1;            // the session 'botsGo' was fired for
    var liveAt = CLOCK_BASE;      // offline: game clock of the last publish (live standings)
    var progOn = false;           // net holds a race progress of ours
    // offline computer drivers (in the local session, ids 2..16): [{id, name, colour, car, skill, slot, bi}], and the
    // strength level they were made at ('rookie' | 'amateur' | 'pro' | 'legend' | 'mixed')
    var localBots = [], localLevel = LEVEL_DEFAULT;

    function emit(name, a, b) {
      var list = handlers[name];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        try { list[i](a, b); } catch (err) { if (root.console) console.error(err); }
      }
    }

    function profile() {
      var p = null;
      try { p = getProfile ? getProfile() : null; } catch (err) { if (root.console) console.error(err); }
      return {
        name: p && typeof p.name === 'string' && p.name ? p.name : 'Player',
        colour: cleanColour(p && p.colour),
        car: cleanCar(p && p.car)
      };
    }

    // OUR computer drivers (the ones this game simulates): offline the local ones, in a room the ones we host
    function ownBots() {
      if (!gp.online) return localBots;
      return net && Array.isArray(net.bots) ? net.bots : [];
    }
    function isOwnBot(id) {
      var list = ownBots();
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return true;
      return false;
    }
    function copyBots() {
      var list = ownBots(), out = [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b || !isNum(b.id)) continue;
        out.push({ id: b.id, name: typeof b.name === 'string' ? b.name : '', colour: cleanColour(b.colour), car: cleanCar(b.car),
                   skill: cleanSkill(b.skill), slot: isNum(b.slot) ? b.slot : i + 1, bi: isNum(b.bi) ? b.bi : i });
      }
      return out;
    }
    /** a classified car of the snapshot that is still in it (not a spectator, not gone) */
    function onTrack(id) { var p = racers[id]; return p && !p.left ? p : null; }

    /** Everything that follows from the snapshot and our role (no clock). */
    function derive() {
      var s = gp.snapshot, i, p;
      gp.selfId = gp.online ? net.id : SELF_OFFLINE;
      gp.canControl = gp.online ? net.isHost === true : true;
      gp.phase = s ? s.phase : 'free';
      gp.sid = s ? s.sid : 0;
      byId = {}; racers = {};
      if (s) {
        for (i = 0; i < s.players.length; i++) {
          p = s.players[i];
          if (!byId[p.id] || (byId[p.id].left && !p.left)) byId[p.id] = p;
          if (!p.spec && !racers[p.id]) racers[p.id] = p;
        }
      }
      me = byId[gp.selfId] || null;
      gp.taking = !!me && gp.phase !== 'free' && !me.spec && !me.left;
      gp.gridSlot = gp.taking ? s.grid.indexOf(gp.selfId) : -1;
      if (!gp.taking) { gp.lap = 0; gp.lapTotal = 0; }
      else if (gp.phase === 'quali') { gp.lap = me.qLaps; gp.lapTotal = s.q; }
      else { gp.lap = me.rLaps; gp.lapTotal = s.r; }
    }

    /** The start lights, from the session clock. */
    function refreshClock() {
      var s = gp.snapshot;
      if (!s || (gp.phase !== 'grid' && gp.phase !== 'race')) {
        lightsOut = false;
        gp.inputLocked = false; gp.lights = 0; gp.goFlash = false; gp.sinceGo = 0;
        return;
      }
      var t = gp.now();
      if (gp.phase === 'race' && t < s.goAt) t = s.goAt;   // the session says the race is on: our clock estimate lags
      lightsOut = t >= s.goAt;
      gp.inputLocked = !lightsOut && gp.taking;
      gp.lights = lightsOut || t < s.lightsAt ? 0 : Math.min(LIGHTS, 1 + Math.floor((t - s.lightsAt) / LIGHT_MS));
      gp.goFlash = lightsOut && t - s.goAt < GO_FLASH_MS;
      gp.sinceGo = lightsOut ? (t - s.goAt) / 1000 : 0;
    }

    /** We are on track in the race and have not taken the flag: our progress counts. */
    function racing() { return gp.taking && gp.phase === 'race' && !me.fin && !me.dnf; }

    /** Some of our bots are classified in the running session. */
    function ownBotsTaking() {
      if (gp.phase === 'free') return false;
      var list = ownBots();
      for (var i = 0; i < list.length; i++) if (list[i] && onTrack(list[i].id)) return true;
      return false;
    }

    /** A new snapshot (or none): refresh the state, then tell the listeners. */
    function apply(snap) {
      var prevPhase = gp.phase, prevSid = gp.sid;
      gp.snapshot = snap;
      derive();
      refreshClock();
      if (gp.online && progOn && !racing()) { progOn = false; net.setProgress(null); }
      // a new session id with the same phase is a new Grand Prix too (the host restarted it)
      if (gp.phase !== prevPhase || (gp.sid !== prevSid && gp.phase !== 'free')) emit('phase', gp.phase, prevPhase);
      emit('change');
    }

    function publish() { liveAt = clock; apply(local.snapshot()); }
    // Offline race: progress reports (ours, our bots') move the live order without a lap; re-publish when it moved.
    function liveRefresh() {
      if (clock - liveAt < LIVE_MS) return;
      liveAt = clock;
      var s = local.snapshot();
      if (JSON.stringify(s) !== JSON.stringify(gp.snapshot)) apply(s);
    }
    function endLocal() { while (local && local.phase !== 'free') local.end(); }

    function onConnected() {
      if (gp.online) return;
      endLocal();                                   // an offline Grand Prix is abandoned (its bots wait in free practice)
      gp.online = true; goSid = -1; botGoSid = -1; progOn = false;
      apply(null);
      var s = cleanSnapshot(net.session);           // normally still null: the room's session arrives as 'gp'
      if (s) apply(s);
      emit('bots', copyBots());                     // ours are now the room's (none until we host and ask)
    }

    function onDisconnected() {
      if (!gp.online) return;
      gp.online = false; goSid = -1; botGoSid = -1; progOn = false;
      if (typeof net.setProgress === 'function') net.setProgress(null);
      apply(null);                                  // the local session is idle: it was ended when we connected
      emit('bots', copyBots());                     // the offline ones again
    }

    function hook(n) {
      n.on('connected', function () { if (n === net) onConnected(); });
      n.on('disconnected', function () { if (n === net) onDisconnected(); });
      n.on('gp', function (s) {
        if (n !== net || !gp.online) return;
        s = cleanSnapshot(s);
        if (s) apply(s);                            // a malformed one is ignored: we keep what we have
      });
      n.on('players', function () {                 // roster: host / names / colours may have changed
        if (n !== net || !gp.online) return;
        derive();
        emit('change');
      });
      n.on('lapRejected', function (why) {
        if (n === net && gp.online) emit('lapRejected', typeof why === 'string' ? why : '');
      });
      n.on('bots', function () {                    // the bots we host changed (ids / names / cars / slots)
        if (n === net && gp.online) emit('bots', copyBots());
      });
      n.on('botLapRejected', function (id, why) {
        if (n === net && gp.online && isNum(id)) emit('botLapRejected', id, typeof why === 'string' ? why : '');
      });
    }

    var gp = {
      online: false,        // the session is the room's
      phase: 'free',        // 'free' | 'quali' | 'grid' | 'race' | 'results'
      sid: 0,               // session id; a new Grand Prix (or "again") gets a new one
      snapshot: null,       // last session snapshot (online: a sanitised copy of net.session) or null
      selfId: SELF_OFFLINE, // our id in the snapshot: net.id online, 1 offline
      taking: false,        // we are classified in this session
      canControl: true,     // we may start / skip / end / again: always offline, only the host online
      inputLocked: false,   // on the grid, waiting for the lights
      lights: 0,            // red lights lit, 0..5
      goFlash: false,       // the 1.5 s after lights out
      sinceGo: 0,           // seconds since lights out
      gridSlot: -1,         // our index in snapshot.grid
      lap: 0, lapTotal: 0,  // our laps completed in this phase and the target; 0 / 0 when we do not take part

      /**
       * init({ net, getProfile, random }): net = F1.net or null; getProfile() -> {name, colour} of the offline
       * driver; random (optional, tests) is handed to the local session. Call once at boot. Calling it again
       * resets the controller to an idle offline session (listeners added with on() are kept, no events fire).
       */
      init: function (opts) {
        opts = opts || {};
        net = opts.net || null;
        getProfile = typeof opts.getProfile === 'function' ? opts.getProfile : null;
        local = lib ? lib.createSession({ random: opts.random }) : null;
        clock = CLOCK_BASE; goSid = -1; botGoSid = -1; progOn = false; liveAt = clock;
        localBots = []; localLevel = LEVEL_DEFAULT;            // (a new local session has none)
        if (net && hooked.indexOf(net) < 0) { hooked.push(net); hook(net); }
        gp.online = !!net && net.connected === true;
        gp.snapshot = gp.online ? cleanSnapshot(net.session) : null;
        derive();
        refreshClock();
      },

      /** on('phase', fn(phase, prevPhase)) | on('go', fn()) | on('change', fn()) | on('lapRejected', fn(why)) */
      on: function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); },

      /** The session clock in ms: the server's clock in a room, the game clock alone. */
      now: function () {
        if (!gp.online) return clock;
        var t = net.serverNow();
        return isNum(t) ? t : Date.now();
      },

      /**
       * Start a Grand Prix: q qualifying laps, r race laps, on a track trackLength metres long; wear = tyre wear
       * multiplier 1..5 (default 1); year = the season (2010..2100) whose cars race. Online the year is the room's
       * (net.year, put in by the server) and cfg.year is not used. -> bool
       */
      start: function (cfg, trackLength) {
        cfg = cfg || {};
        var c = { q: cfg.q, r: cfg.r, len: trackLength };
        if (cfg.wear !== undefined) c.wear = cfg.wear;
        if (gp.online) return !!net.gp('start', c);
        if (!local) return false;
        c.year = cfg.year;
        var name = profile().name;
        if (!local.addPlayer(SELF_OFFLINE, name, clock)) local.rename(SELF_OFFLINE, name);
        if (!local.start(c, clock)) return false;
        publish();
        return true;
      },

      /** 'skip' (qualifying) | 'end' | 'again' (from the results). -> bool */
      action: function (a) {
        if (a !== 'skip' && a !== 'end' && a !== 'again') return false;
        if (gp.online) return !!net.gp(a);
        if (!local) return false;
        var ok = a === 'skip' ? local.skip(clock) : (a === 'end' ? local.end() : local.again(clock));
        if (ok) publish();
        return ok;
      },

      /**
       * Every rendered frame while the game loop runs, first thing in the frame; dt = the frame's clamped dt (s).
       * 'go' fires before the local session is ticked, so offline it arrives while the phase is still 'grid'
       * and 'phase' ('race') follows - the order a room normally gives (its 'race' snapshot comes a moment
       * after our clock passes goAt). Listeners must not rely on either order.
       */
      update: function (dt) {
        if (!gp.online && isNum(dt) && dt > 0) clock += dt * 1000;
        refreshClock();
        if (lightsOut && gp.taking && goSid !== gp.sid) { goSid = gp.sid; emit('go'); }
        if (lightsOut && botGoSid !== gp.sid && ownBotsTaking()) { botGoSid = gp.sid; emit('botsGo'); }
        if (!gp.online && local && local.tick(clock)) publish();
        else if (!gp.online && local && local.phase === 'race') liveRefresh();
      },

      /** The lap counter completed a timed lap (s). Ignored unless we still have laps to do in quali / race.
       *  Call it in the frame the car crossed the line: online the session clock now is sent with it as the
       *  moment of the crossing (the race time does not depend on how long the report takes to arrive). */
      lapDone: function (time) {
        if (!gp.taking) return;
        if (gp.phase === 'quali') { if (me.qDone) return; }       // done: drive on, nothing counts any more
        else if (gp.phase === 'race') { if (me.fin || me.dnf) return; }
        else return;
        if (gp.online) { net.sendGpLap(gp.sid, time, gp.now()); return; }
        var why = local.lap(SELF_OFFLINE, time, clock);
        if (why) emit('lapRejected', why); else publish();
      },

      /** Race distance (lapCounter.progress(idx)): forwarded only while we are racing, else cleared. */
      setProgress: function (v) {
        if (gp.online) {
          progOn = racing() && isNum(v);
          net.setProgress(progOn ? v : null);
        } else if (local) local.progress(SELF_OFFLINE, v);      // (the session ignores it outside the race)
      },

      /* ---------- computer drivers ---------- */

      /**
       * Our computer drivers, free practice only. list = [{name, car, colour, skill}], entry i = bot i (name <= 16
       * characters, car a CarSpec id, colour '#rrggbb', skill 0..1; missing / not valid -> 'AI n', '', grey, the
       * level's); skill = the level they were made at: 'rookie' | 'amateur' | 'pro' | 'legend' | 'mixed' (shown in
       * view().bots; anything else keeps the previous one). Offline: at most 15 (ids 2..16, room slots 1..15: the
       * player is id 1, slot 0), applied at once ('bots' fires). In a room: net.setBots (host only; the server gives
       * ids / slots, at most 16 - humans; 'bots' fires when the roster brings them). -> true when applied / sent.
       */
      setBots: function (list, skill) {
        if (gp.online) return !!(net && typeof net.setBots === 'function' && net.setBots(list, skill));
        if (!local || local.phase !== 'free') return false;
        var n;
        if (isNum(list)) { n = list; list = []; }
        else if (Array.isArray(list)) n = list.length;
        else return false;
        if (!(n >= 0)) return false;
        n = Math.min(Math.floor(n), ROOM_MAX - 1);
        var level = cleanLevel(skill) || localLevel, out = [], i, name = profile().name;
        // the player first: the bots join after him (no-time ties in qualifying go by join order)
        if (!local.addPlayer(SELF_OFFLINE, name, clock)) local.rename(SELF_OFFLINE, name);
        for (i = 0; i < n; i++) {
          var e = list[i] && typeof list[i] === 'object' ? list[i] : {}, id = BOT_ID0 + i, sk = cleanSkill(e.skill);
          var b = { id: id, name: cleanBotName(e.name, 'AI ' + (i + 1)), colour: cleanColour(e.colour), car: cleanCar(e.car),
                    skill: sk !== null ? sk : LEVEL_SKILL[level], slot: i + 1, bi: i };
          if (!local.addPlayer(id, b.name, clock, { bot: true, owner: SELF_OFFLINE })) local.rename(id, b.name);
          out.push(b);
        }
        for (i = n; i < localBots.length; i++) local.removePlayer(localBots[i].id, clock);
        localBots = out; localLevel = level;
        emit('bots', copyBots());
        emit('change');
        return true;
      },

      /** -> our bots, a fresh copy: [{id, name, colour, car, skill, slot, bi}] in list order (slot = room slot =
       *  pit box / grid column outside a session). Online: the room's bots we host (net.bots); offline: ours. */
      bots: function () { return copyBots(); },

      /**
       * One of our bots completed a timed lap (s): its lap counter returned 2. -> '' when accepted (offline) / sent
       * (online; a rejection comes back as 'botLapRejected'), else why not: 'not-ours' | 'not-racing' | 'done' |
       * 'no-session' | 'not-sent' | a session reason ('too-fast', ...: offline, also fired as 'botLapRejected').
       */
      botLap: function (id, time) {
        if (!isOwnBot(id)) return 'not-ours';
        var p = onTrack(id);
        if (!p || gp.phase === 'free') return 'not-racing';
        if (gp.phase === 'quali') { if (p.qDone) return 'done'; }
        else if (gp.phase === 'race') { if (p.fin || p.dnf) return 'done'; }
        else return 'no-session';
        if (gp.online) return net.sendGpLap(gp.sid, time, gp.now(), id) ? '' : 'not-sent';
        var why = local.lap(id, time, clock);
        if (why) emit('botLapRejected', id, why); else publish();
        return why;
      },

      /** One of our bots' race distance (its lapCounter.progress(idx)), every frame like setProgress. Online it rides
       *  along with its next state (net.sendBotStates). */
      botProgress: function (id, v) {
        if (!isOwnBot(id)) return;
        if (gp.online) { if (typeof net.setBotProgress === 'function') net.setBotProgress(id, isNum(v) ? v : null); }
        else if (local) local.progress(id, v);
      },

      /**
       * Where car `id` (ours, a bot, anybody in the snapshot) stands in the session, for its driver / its lap
       * counter: { id, bot, taking (classified in this session and still in it), lap, lapTotal (qLaps / q in
       * qualifying, rLaps / r from the grid on, 0 / 0 otherwise), done (quali: its laps are done; race: flag or DNF;
       * results: true), fin, dnf, gridSlot (index in snapshot.grid, -1), locked (on the grid before lights out: hold
       * the car) }. out (optional) is filled and returned instead of a new object (no allocation per step).
       */
      entry: function (id, out) {
        var o = out || {}, p = onTrack(id), s = gp.snapshot, row = byId[id];
        o.id = id; o.bot = !!row && row.bot === true;
        o.taking = !!p && gp.phase !== 'free';
        o.lap = 0; o.lapTotal = 0; o.done = false; o.fin = false; o.dnf = false; o.gridSlot = -1; o.locked = false;
        if (row) { o.fin = row.fin; o.dnf = row.dnf; }
        if (!o.taking) return o;
        if (gp.phase === 'quali') { o.lap = p.qLaps; o.lapTotal = s.q; o.done = p.qDone; }
        else { o.lap = p.rLaps; o.lapTotal = s.r; o.done = gp.phase === 'results' || p.fin || p.dnf; }
        o.gridSlot = s.grid.indexOf(id);
        o.locked = (gp.phase === 'grid' || gp.phase === 'race') && !lightsOut;
        return o;
      },

      /** May cars a and b touch (collide) now? The session's rule (net/session.js solid()) for any two cars, e.g.
       *  two bots: always in free practice; never in qualifying, nor on the grid before the lights; otherwise when
       *  both are classified and still in the session. (Pit-lane ghosts are main.js's.) */
      solid: function (a, b) {
        var s = gp.snapshot;
        if (!s || gp.phase === 'free') return true;
        if (gp.phase === 'quali') return false;
        if (gp.phase === 'grid' && !(gp.now() >= s.lightsAt)) return false;
        return !!onTrack(a) && !!onTrack(b);
      },

      /** Draw that remote car translucent and do not collide with it. */
      isGhost: function (id) {
        var s = gp.snapshot;
        if (!s || gp.phase === 'free') return false;
        if (gp.phase === 'quali') return true;
        if (gp.phase === 'grid' && gp.now() < s.lightsAt) return true;   // cars are still being placed
        if (!gp.taking) return true;
        var p = byId[id];
        return !p || p.spec;
      },

      /** main.js is loading another track: an offline Grand Prix ends (in a room the server does it). */
      trackChanged: function () {
        if (gp.online || !local || local.phase === 'free') return;
        endLocal();
        publish();
      },

      /** -> GpView for F1.ui.setGp: a fresh plain object (see js/README-interfaces.md). */
      view: function () {
        var s = gp.snapshot, on = !!s && gp.phase !== 'free';
        var inRace = gp.phase === 'race' || gp.phase === 'results';
        var rows = [], spectators = [], colours = {}, cars = {}, skills = {}, pos = 0, i, p, q, bots;
        if (gp.online) {
          var roster = Array.isArray(net.roster) ? net.roster : [], humans = 0, nb = 0;
          for (i = 0; i < roster.length; i++) {
            q = roster[i];
            if (!q || !isNum(q.id)) continue;
            colours[q.id] = cleanColour(q.colour); cars[q.id] = cleanCar(q.car);
            if (q.bot === true) { nb++; skills[q.id] = cleanSkill(q.skill); } else humans++;
          }
          var set = net.botSettings && typeof net.botSettings === 'object' ? net.botSettings : {};
          bots = { count: nb, skill: cleanLevel(set.skill) || LEVEL_DEFAULT, max: Math.max(0, ROOM_MAX - humans),
                   canEdit: net.isHost === true && gp.phase === 'free' };
        } else {
          q = profile();
          colours[SELF_OFFLINE] = q.colour; cars[SELF_OFFLINE] = q.car;
          for (i = 0; i < localBots.length; i++) {
            q = localBots[i];
            colours[q.id] = q.colour; cars[q.id] = q.car; skills[q.id] = q.skill;
          }
          bots = { count: localBots.length, skill: localLevel, max: ROOM_MAX - 1, canEdit: gp.phase === 'free' };
        }
        if (on) {
          for (i = 0; i < s.order.length; i++) {
            p = racers[s.order[i]];
            if (!p) continue;
            rows.push({
              pos: rows.length + 1, id: p.id, name: p.name || (p.bot ? 'AI ' : 'Player ') + p.id, colour: colours[p.id] || GREY,
              isSelf: p === me,
              bot: p.bot === true,                 // a computer driver (offline rows come straight from the session)
              skill: p.bot === true && skills[p.id] !== undefined ? skills[p.id] : null,   // its strength 0..1 (null: unknown)
              car: cars[p.id] || '',               // its CarSpec id ('' unknown)
              laps: inRace ? p.rLaps : p.qLaps,
              best: inRace ? p.rBest : p.qBest,
              time: inRace && p.fin ? p.rTime : null,
              gap: inRace ? p.gap : null,
              down: inRace ? p.down : 0,
              done: inRace ? p.fin : p.qDone,
              dnf: p.dnf, left: p.left
            });
            if (p === me) pos = rows.length;
          }
          for (i = 0; i < s.players.length; i++) {
            p = s.players[i];
            if (p.spec && !p.left) spectators.push({ id: p.id, name: p.name || 'Player ' + p.id, colour: colours[p.id] || GREY });
          }
        }
        return {
          phase: gp.phase, online: gp.online, canControl: gp.canControl, taking: gp.taking,
          spectating: on && !gp.taking,
          q: s ? s.q : 3, r: s ? s.r : 5,
          year: s ? s.year : null, wear: s ? s.wear : 1,       // of the running / last session, like q and r
          lap: gp.lap, lapTotal: gp.lapTotal,
          pos: pos, count: rows.length,
          done: gp.taking && (gp.phase === 'quali' ? me.qDone : me.fin),
          endsInMs: gp.phase === 'race' && s.endsAt > 0 ? Math.max(0, Math.round(s.endsAt - gp.now())) : null,
          rows: rows, spectators: spectators,
          // computer drivers: how many there are (offline ours, in a room all of them), the strength level they were
          // set to, how many there may be (16 - humans), and whether we may change them now (offline / the host, in
          // free practice: parc fermé during a session)
          bots: bots
        };
      }
    };

    gp.init({});            // usable (offline, idle) even before main.js calls init()
    return gp;
  }

  F1.createGp = createGp;
  F1.gp = createGp();
  if (typeof module !== 'undefined' && module.exports) module.exports = F1.gp;
})(typeof window !== 'undefined' ? window : globalThis);
