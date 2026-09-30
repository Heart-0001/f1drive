// F1Drive - Grand Prix session rules (qualifying -> grid / start lights -> race -> results).
// Pure logic: no timers, no I/O, no DOM. The caller passes the current time (ms) into every call.
// Used by net/server.js (authoritative in a room) and by js/main.js (single player, same rules).
//   node:    const { createSession } = require('./session');
//   browser: F1.createSession
(function (root) {
  'use strict';

  var MAX_AVG_SPEED = 330 / 3.6;     // m/s: a lap faster than this average is rejected
  var MAX_LAP_S = 3600;
  var LAP_GAP_FACTOR = 0.9;          // two laps from one player must be at least 0.9 * the minimum lap apart
  var LAP_SLACK_S = 2;               // a lap cannot be longer than the wall time since the previous one (+ slack)
  var GRID_DELAY_MS = 4000;          // from "grid" until the first red light comes on (cars get placed)
  var LIGHT_MS = 1000;               // one more red light every second, five lights
  var LIGHTS = 5;
  var HOLD_MIN_MS = 500, HOLD_MAX_MS = 2000;   // random hold with all five on, then lights out
  var RACE_TIMEOUT_MS = 90000;       // after the winner finishes, everybody else has this long
  var TIME_TOLERANCE_S = 5;          // summed lap times may differ this much from the server clock

  function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function clampInt(v, lo, hi, def) {
    if (typeof v !== 'number' || !isNum(v)) return def;
    v = Math.round(v);
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function minLapTime(len) { return len / MAX_AVG_SPEED; }

  /**
   * createSession({ random }) -> session
   *   phase: 'free' | 'quali' | 'grid' | 'race' | 'results'
   * Every mutating call returns true when the state changed (the caller then publishes snapshot()).
   */
  function createSession(opts) {
    opts = opts || {};
    var random = typeof opts.random === 'function' ? opts.random : Math.random;
    var S = { sid: 0, phase: 'free', q: 3, r: 5, len: 0, startedAt: 0, lightsAt: 0, goAt: 0, winnerAt: 0, endsAt: 0, grid: [] };
    var players = [];                // in join order; leavers of a race stay (left = true) until the next session
    var joinSeq = 0, bestSeq = 0;

    function find(id) {
      for (var i = 0; i < players.length; i++) if (players[i].id === id && !players[i].left) return players[i];
      return null;
    }
    function racing(p) { return !p.spec; }                       // takes part in the current session
    function active(p) { return !p.spec && !p.left; }

    function resetQuali(p) { p.qLaps = 0; p.qBest = null; p.qSeq = 0; p.qDone = false; }
    function resetRace(p) {
      p.rLaps = 0; p.rTime = 0; p.rBest = null; p.cum = []; p.fin = false; p.dnf = false; p.prog = -1;
    }

    function qualiOrder() {
      var list = players.filter(racing);
      list.sort(function (a, b) {
        if (a.qBest !== b.qBest) {
          if (a.qBest === null) return 1;
          if (b.qBest === null) return -1;
          return a.qBest - b.qBest;
        }
        if (a.qBest !== null && a.qSeq !== b.qSeq) return a.qSeq - b.qSeq;   // same time: whoever set it first
        return a.join - b.join;                                              // no time: join order
      });
      return list;
    }

    // Effective race distance: finished cars keep their lap count, the others their live progress.
    function eff(p) { return p.fin ? p.rLaps : Math.max(p.rLaps - 1, Math.min(p.prog, p.rLaps + 0.9999)); }
    function raceOrder() {
      var gridPos = {};
      S.grid.forEach(function (id, i) { gridPos[id] = i; });
      var list = players.filter(racing);
      list.sort(function (a, b) {
        if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
        var ea = eff(a), eb = eff(b);
        if (ea !== eb) return eb - ea;
        if (a.fin && b.fin && a.rTime !== b.rTime) return a.rTime - b.rTime;
        if (a.fin !== b.fin) return a.fin ? -1 : 1;
        var ga = gridPos[a.id], gb = gridPos[b.id];
        return (ga === undefined ? 1e9 : ga) - (gb === undefined ? 1e9 : gb) || a.join - b.join;
      });
      return list;
    }

    function toFree() {
      S.phase = 'free'; S.lightsAt = S.goAt = S.winnerAt = S.endsAt = 0; S.grid = [];
      players = players.filter(function (p) { return !p.left; });
      players.forEach(function (p) { p.spec = false; });
    }

    function toQuali(now) {
      players = players.filter(function (p) { return !p.left; });
      if (!players.length) { toFree(); return; }
      S.sid++; S.phase = 'quali'; S.startedAt = now;
      S.lightsAt = S.goAt = S.winnerAt = S.endsAt = 0; S.grid = [];
      players.forEach(function (p) { p.spec = false; resetQuali(p); resetRace(p); p.lastLapAt = now; });
    }

    function toGrid(now) {
      var order = qualiOrder().filter(active);
      if (!order.length) { toFree(); return; }
      S.phase = 'grid';
      S.grid = order.map(function (p) { return p.id; });
      S.lightsAt = now + GRID_DELAY_MS;
      var hold = HOLD_MIN_MS + Math.round(Math.max(0, Math.min(1, random())) * (HOLD_MAX_MS - HOLD_MIN_MS));
      S.goAt = S.lightsAt + LIGHTS * LIGHT_MS + hold;
      S.winnerAt = S.endsAt = 0;
      players.forEach(function (p) { resetRace(p); });
    }

    function toResults() { S.phase = 'results'; }

    function checkQualiDone(now) {
      var act = players.filter(active);
      if (!act.length) { toFree(); return true; }
      for (var i = 0; i < act.length; i++) if (!act[i].qDone) return false;
      toGrid(now);
      return true;
    }

    function checkRaceDone() {
      var act = players.filter(active);
      if (!act.length) { toFree(); return true; }
      for (var i = 0; i < act.length; i++) if (!act[i].fin) return false;
      toResults();
      return true;
    }

    function validLap(p, time, now) {
      if (!isNum(time) || time <= 0 || time > MAX_LAP_S) return 'bad';
      var min = minLapTime(S.len);
      if (time < min) return 'too-fast';
      var since = (now - p.lastLapAt) / 1000;
      if (since < min * LAP_GAP_FACTOR) return 'too-soon';
      if (time > since + LAP_SLACK_S) return 'inconsistent';
      return '';
    }

    var api = {
      get phase() { return S.phase; },
      get sid() { return S.sid; },

      /** A player connected. During qualifying they take part; during grid / race / results they are
       *  spectators (free-roaming ghosts, not classified) until the next session. */
      addPlayer: function (id, name, now) {
        if (find(id)) return false;
        var p = { id: id, name: String(name == null ? '' : name), join: joinSeq++, left: false,
                  spec: S.phase === 'grid' || S.phase === 'race' || S.phase === 'results', lastLapAt: now };
        resetQuali(p); resetRace(p);
        players.push(p);
        return true;
      },

      rename: function (id, name) {
        var p = find(id);
        if (!p || p.name === name) return false;
        p.name = String(name == null ? '' : name);
        return true;
      },

      /** A player disconnected. Qualifying / grid: removed. Race: stays in the classification as DNF. */
      removePlayer: function (id, now) {
        var p = find(id);
        if (!p) return false;
        if ((S.phase === 'race' || S.phase === 'results') && !p.spec) {
          p.left = true;
          if (!p.fin) p.dnf = true;
          if (S.phase === 'race') checkRaceDone();
          else if (!players.some(function (q) { return !q.left; })) toFree();
          return true;
        }
        players.splice(players.indexOf(p), 1);
        if (S.phase === 'quali') checkQualiDone(now);
        else if (S.phase === 'grid') {
          S.grid = S.grid.filter(function (g) { return g !== id; });
          if (!players.some(active)) toFree();
        } else if (S.phase !== 'free' && !players.some(function (q) { return !q.left; })) toFree();
        return true;
      },

      /** Host: start a Grand Prix. cfg = { q: qualifying laps 1..20, r: race laps 1..99, len: track length in m } */
      start: function (cfg, now) {
        cfg = cfg || {};
        if (!isNum(cfg.len) || cfg.len < 200 || cfg.len > 100000) return false;
        if (!players.some(function (p) { return !p.left; })) return false;
        S.q = clampInt(cfg.q, 1, 20, 3);
        S.r = clampInt(cfg.r, 1, 99, 5);
        S.len = cfg.len;
        toQuali(now);
        return true;
      },

      /** Host: skip (the rest of) qualifying and go to the grid with the times set so far. */
      skip: function (now) {
        if (S.phase !== 'quali') return false;
        toGrid(now);
        return true;
      },

      /** Host: end. During the race -> results with the classification as it stands; otherwise -> free. */
      end: function () {
        if (S.phase === 'free') return false;
        if (S.phase === 'race') toResults(); else toFree();
        return true;
      },

      /** Host, from the results: another Grand Prix with the same settings. */
      again: function (now) {
        if (S.phase !== 'results') return false;
        toQuali(now);
        return true;
      },

      /** A player reports a completed timed lap. -> '' when accepted, else the reason it was rejected. */
      lap: function (id, time, now) {
        var p = find(id);
        if (!p || p.spec) return 'not-racing';
        var why;
        if (S.phase === 'quali') {
          if (p.qDone) return 'done';
          why = validLap(p, time, now);
          if (why) return why;
          p.lastLapAt = now;
          p.qLaps++;
          if (p.qBest === null || time < p.qBest) { p.qBest = time; p.qSeq = ++bestSeq; }
          if (p.qLaps >= S.q) p.qDone = true;
          checkQualiDone(now);
          return '';
        }
        if (S.phase === 'race') {
          if (p.fin || p.dnf) return 'done';
          why = validLap(p, time, now);
          if (why) return why;
          p.lastLapAt = now;
          p.rLaps++;
          p.rTime += time;
          // total race time = sum of the player's own lap times, unless that disagrees with our clock
          var elapsed = (now - S.goAt) / 1000;
          if (Math.abs(p.rTime - elapsed) > TIME_TOLERANCE_S) p.rTime = elapsed;
          p.cum.push(p.rTime);
          if (p.rBest === null || time < p.rBest) p.rBest = time;
          if (p.prog < p.rLaps) p.prog = p.rLaps;
          // chequered flag: you finish when you complete the distance, or at your first crossing of the
          // line after the winner has finished
          if (p.rLaps >= S.r || S.winnerAt) {
            p.fin = true;
            if (!S.winnerAt) { S.winnerAt = now; S.endsAt = now + RACE_TIMEOUT_MS; }
          }
          checkRaceDone();
          return '';
        }
        return 'no-session';
      },

      /** Live race progress from the player's state messages: laps completed + fraction of the lap. */
      progress: function (id, value) {
        if (S.phase !== 'race' || !isNum(value)) return;
        var p = find(id);
        if (!p || p.spec || p.fin) return;
        p.prog = Math.max(p.rLaps - 1, Math.min(value, p.rLaps + 0.9999));
      },

      /** Time-driven transitions: lights out, race timeout. */
      tick: function (now) {
        if (S.phase === 'grid' && now >= S.goAt) {
          S.phase = 'race';
          players.forEach(function (p) { p.lastLapAt = S.goAt; });
          return true;
        }
        if (S.phase === 'race' && S.endsAt && now >= S.endsAt) { toResults(); return true; }
        return false;
      },

      /** Plain, JSON-serialisable view of everything the clients need. */
      snapshot: function () {
        var inRace = S.phase === 'race' || S.phase === 'results';
        var order = inRace ? raceOrder() : qualiOrder();
        var leader = inRace && order.length ? order[0] : null;
        var list = players.map(function (p) {
          var o = { id: p.id, name: p.name, spec: p.spec, left: p.left,
                    qLaps: p.qLaps, qBest: p.qBest, qDone: p.qDone,
                    rLaps: p.rLaps, rTime: p.rTime, rBest: p.rBest, fin: p.fin, dnf: p.dnf,
                    gap: null, down: 0 };
          if (leader && !p.spec && p !== leader && !p.dnf) {
            var down = Math.floor(eff(leader) - eff(p) + 1e-9);
            if (leader.fin && p.fin) down = leader.rLaps - p.rLaps;
            if (down >= 1) o.down = down;
            else if (p.rLaps >= 1 && leader.cum.length >= p.rLaps) o.gap = p.cum[p.rLaps - 1] - leader.cum[p.rLaps - 1];
          }
          return o;
        });
        return {
          sid: S.sid, phase: S.phase, q: S.q, r: S.r, len: S.len,
          lightsAt: S.lightsAt, goAt: S.goAt, winnerAt: S.winnerAt, endsAt: S.endsAt,
          grid: S.grid.slice(),
          order: order.map(function (p) { return p.id; }),
          players: list
        };
      }
    };
    return api;
  }

  var exported = {
    createSession: createSession, minLapTime: minLapTime,
    LIGHTS: LIGHTS, LIGHT_MS: LIGHT_MS, RACE_TIMEOUT_MS: RACE_TIMEOUT_MS, GRID_DELAY_MS: GRID_DELAY_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else {
    var F1 = root.F1 = root.F1 || {};
    F1.createSession = createSession;
    F1.Session = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
