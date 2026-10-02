// F1Drive - Grand Prix session rules (qualifying -> grid / start lights -> race -> results).
// Pure logic: no timers, no I/O, no DOM. The caller passes the current time (ms) into every call.
// Used by net/server.js (authoritative in a room) and by js/gp.js (single player, same rules).
//   node:    const { createSession } = require('./session');
//   browser: F1.createSession
// The clock only has to be monotonic and in ms; the caller calls tick(now) often (every frame / 100 ms) and
// before any other call whose outcome depends on the time (lap, removePlayer), so that a lap or a leaver
// arriving right at lights out / at the race timeout is judged in the right phase.
(function (root) {
  'use strict';

  var MAX_AVG_SPEED = 330 / 3.6;     // m/s: a lap faster than this average is rejected
  var MAX_LAP_S = 3600;
  var LAP_GAP_FACTOR = 0.9;          // two laps from one player must be at least 0.9 * the minimum lap apart
  var LAP_SLACK_S = 2;               // the laps of a phase cannot add up to more than the time it has lasted (+ slack)
  var GRID_DELAY_MS = 4000;          // from "grid" until the first red light comes on (cars get placed)
  var LIGHT_MS = 1000;               // one more red light every second, five lights
  var LIGHTS = 5;
  var HOLD_MIN_MS = 500, HOLD_MAX_MS = 2000;   // random hold with all five on, then lights out
  var RACE_TIMEOUT_MS = 60000;       // after the winner finishes, everybody else has this long
  var TIME_TOLERANCE_S = 1;          // summed lap times may differ this much from the session clock at the crossing;
                                     //   beyond it the session clock is the race time (e.g. the game was paused)
  var CROSS_LAG_MS = 3000;           // a lap report may say the car crossed the line up to this long before it arrived
  // Proof of driving (the server passes it; alone the game has none and none is asked for). The margins cover the
  // racing line (shorter than the centreline), the pit lane (shorter than the stretch it bypasses) and lag.
  var LAP_DIST = 0.85;               // a lap needs the car's reported positions to cover 85 % of the track length
  var LAP_LIVE = 0.75;               //   and its positions to have been arriving for most (3/4) of the lap's time
  var GRID_PROG = 0.001;             // laps: assumed progress step between two grid slots until a car reports its own
  var YEAR_MIN = 2010, YEAR_MAX = 2100;   // a season year (the cars of that year); anything else is "no year"
  var WEAR_MAX = 5;                  // tyre wear multiplier 1..5

  function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function clampInt(v, lo, hi, def) {
    if (typeof v !== 'number' || !isNum(v)) return def;
    v = Math.round(v);
    return v < lo ? lo : (v > hi ? hi : v);
  }
  /** -> v when it is a whole year 2010..2100, else null (not clamped: a clamped year would be another season) */
  function cleanYear(v) { return typeof v === 'number' && v % 1 === 0 && v >= YEAR_MIN && v <= YEAR_MAX ? v : null; }
  function ms3(v) { return Math.round(v * 1000) / 1000; }     // seconds, to the millisecond
  function minLapTime(len) { return len / MAX_AVG_SPEED; }

  /**
   * createSession({ random }) -> session
   *   phase: 'free' | 'quali' | 'grid' | 'race' | 'results'
   * Every mutating call returns true when the state changed (the caller then publishes snapshot()).
   */
  function createSession(opts) {
    opts = opts || {};
    var random = typeof opts.random === 'function' ? opts.random : Math.random;
    var S = { sid: 0, phase: 'free', q: 3, r: 5, len: 0, year: null, wear: 1,
              startedAt: 0, lightsAt: 0, goAt: 0, winnerAt: 0, endsAt: 0, grid: [] };
    var players = [];                // in join order; leavers of a race stay (left = true) until the next session
    var joinSeq = 0, bestSeq = 0, finSeq = 0;

    function find(id) {
      for (var i = 0; i < players.length; i++) if (players[i].id === id && !players[i].left) return players[i];
      return null;
    }
    function racing(p) { return !p.spec; }                       // takes part in the current session
    function active(p) { return !p.spec && !p.left; }
    function present(p) { return !p.left; }

    function resetQuali(p) { p.qLaps = 0; p.qBest = null; p.qSeq = 0; p.qDone = false; }
    function resetRace(p) {
      p.rLaps = 0; p.rTime = 0; p.rBest = null; p.cum = []; p.fin = false; p.finSeq = 0; p.dnf = false; p.prog = -1;
    }
    // Lap validation is anchored here: the player's laps from now on are timed against the clock from t.
    // crossAt: when the car last crossed the line (as it reported), the earliest the next crossing can be.
    function rebase(p, t) { p.lastLapAt = t; p.base = t; p.sum = 0; p.crossAt = t; }

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
        if (a.fin !== b.fin) return a.fin ? -1 : 1;
        if (a.fin) {                                  // same distance, both took the flag: time, then who came first
          if (a.rTime !== b.rTime) return a.rTime - b.rTime;
          if (a.finSeq !== b.finSeq) return a.finSeq - b.finSeq;
        } else {
          // level on distance (they just crossed the line and sent no newer progress yet): more laps
          // first, then whoever crossed the line first
          if (a.rLaps !== b.rLaps) return b.rLaps - a.rLaps;
          if (a.rLaps > 0 && a.cum[a.rLaps - 1] !== b.cum[a.rLaps - 1]) return a.cum[a.rLaps - 1] - b.cum[a.rLaps - 1];
        }
        var ga = gridPos[a.id], gb = gridPos[b.id];
        return (ga === undefined ? 1e9 : ga) - (gb === undefined ? 1e9 : gb) || a.join - b.join;
      });
      return list;
    }

    function toFree() {
      S.phase = 'free'; S.lightsAt = S.goAt = S.winnerAt = S.endsAt = 0; S.grid = [];
      players = players.filter(present);
      players.forEach(function (p) { p.spec = false; });
    }

    function toQuali(now) {
      players = players.filter(present);
      if (!players.length) { toFree(); return; }
      S.sid++; S.phase = 'quali'; S.startedAt = now;
      S.lightsAt = S.goAt = S.winnerAt = S.endsAt = 0; S.grid = [];
      players.forEach(function (p) { p.spec = false; resetQuali(p); resetRace(p); rebase(p, now); });
    }

    function toGrid(now) {
      var order = qualiOrder().filter(active);
      if (!order.length) { toFree(); return; }
      if (!isNum(now)) now = S.startedAt;              // a caller without a clock must not leave the lights on for ever
      S.phase = 'grid';
      S.grid = order.map(function (p) { return p.id; });
      S.lightsAt = now + GRID_DELAY_MS;
      var rnd = random();
      if (!isNum(rnd)) rnd = 0.5;                      // a broken generator must not leave the lights on for ever
      var hold = HOLD_MIN_MS + Math.round(Math.max(0, Math.min(1, rnd)) * (HOLD_MAX_MS - HOLD_MIN_MS));
      S.goAt = S.lightsAt + LIGHTS * LIGHT_MS + hold;
      S.winnerAt = S.endsAt = 0;
      players.forEach(function (p) { resetRace(p); });
      // until a car reports its own progress it is taken to be on its grid slot, just behind the line
      order.forEach(function (p, i) { p.prog = -(i + 1) * GRID_PROG; });
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

    function validLap(p, time, now, proof) {
      if (!isNum(time) || !isNum(now) || time <= 0 || time > MAX_LAP_S) return 'bad';
      var min = minLapTime(S.len);
      if (time < min) return 'too-fast';
      if ((now - p.lastLapAt) / 1000 < min * LAP_GAP_FACTOR) return 'too-soon';
      // All the laps reported since the phase began for this player must fit in the time that has passed.
      // (Cumulative on purpose: measured from the previous report it would reject an honest lap whenever
      // that previous report had been delayed on the network by more than the slack.)
      if (p.sum + time > (now - p.base) / 1000 + LAP_SLACK_S) return 'inconsistent';
      // A lap somebody reports must have been driven where the others could see it (a missing or broken
      // value counts as nothing: the server always passes both).
      if (proof) {
        if (!(isNum(proof.dist) && proof.dist >= LAP_DIST * S.len)) return 'not-driven';
        if (!(isNum(proof.live) && proof.live >= LAP_LIVE * time)) return 'no-data';
      }
      return '';
    }
    // The race time at a crossing: the sum of the player's own lap times, unless that disagrees with the
    // session clock at the moment he crossed the line (e.g. the game was paused: his lap timer stood still).
    // proof.at is his estimate of that moment on the session clock (delivery delay does not move it); it is
    // taken as no earlier than his previous crossing or CROSS_LAG_MS before the report arrived, and no later
    // than its arrival (so a made-up one gains at most that). Without it: the arrival.
    function raceTime(p, now, proof) {
      var at = proof && isNum(proof.at) ? Math.max(p.crossAt, now - CROSS_LAG_MS, Math.min(proof.at, now)) : now;
      var elapsed = (at - S.goAt) / 1000;
      p.crossAt = at;
      if (Math.abs(p.rTime - elapsed) > TIME_TOLERANCE_S) p.rTime = elapsed;
    }

    var api = {
      get phase() { return S.phase; },
      get sid() { return S.sid; },

      /** A player connected. During qualifying they take part; during grid / race / results they are
       *  spectators (free-roaming ghosts, not classified) until the next session.
       *  opts (optional): { bot: true, owner: id } = a computer driver simulated by player `owner`'s game. A bot
       *  is a player like any other (qualifies, takes its grid slot, races, is DNF when removed during the race);
       *  its snapshot row carries `bot: true`. The rooms only add bots in free practice. */
      addPlayer: function (id, name, now, opts) {
        if (!isNum(id) || find(id)) return false;                  // ids are numbers (the wire and gp.js rely on it)
        var p = { id: id, name: String(name == null ? '' : name), join: joinSeq++, left: false,
                  spec: S.phase === 'grid' || S.phase === 'race' || S.phase === 'results',
                  bot: !!(opts && typeof opts === 'object' && opts.bot === true),
                  owner: 0 };
        if (p.bot && isNum(opts.owner)) p.owner = opts.owner;
        resetQuali(p); resetRace(p); rebase(p, now);
        players.push(p);
        return true;
      },

      /** -> true when id is a bot present in the session */
      isBot: function (id) { var p = find(id); return !!p && p.bot; },

      rename: function (id, name) {
        var p = find(id);
        name = String(name == null ? '' : name);
        if (!p || p.name === name) return false;
        p.name = name;
        return true;
      },

      /** A player disconnected. Qualifying / grid: removed. Race: stays in the classification as DNF.
       *  Results: the row stays as it is (the classification is final). */
      removePlayer: function (id, now) {
        var p = find(id);
        if (!p) return false;
        if ((S.phase === 'race' || S.phase === 'results') && !p.spec) {
          p.left = true;
          if (S.phase === 'race') {
            if (!p.fin) p.dnf = true;
            checkRaceDone();
          } else if (!players.some(present)) toFree();
          return true;
        }
        players.splice(players.indexOf(p), 1);
        if (S.phase === 'quali') checkQualiDone(now);
        else if (S.phase === 'grid') {
          S.grid = S.grid.filter(function (g) { return g !== id; });
          if (!players.some(active)) toFree();
        } else if (S.phase !== 'free' && !players.some(present)) toFree();
        return true;
      },

      /** Host: start a Grand Prix (from any phase: a running one is abandoned).
       *  cfg = { q: qualifying laps 1..20, r: race laps 1..99, len: track length in m,
       *          year: the season whose cars race (2010..2100, else null), wear: tyre wear multiplier 1..5 (default 1) }
       *  year and wear are carried in the snapshot for the clients; the rules do not use them. */
      start: function (cfg, now) {
        cfg = cfg || {};
        if (!isNum(cfg.len) || cfg.len < 200 || cfg.len > 100000 || !isNum(now)) return false;
        if (!players.some(present)) return false;
        S.q = clampInt(cfg.q, 1, 20, 3);
        S.r = clampInt(cfg.r, 1, 99, 5);
        S.len = cfg.len;
        S.year = cleanYear(cfg.year);
        S.wear = clampInt(cfg.wear, 1, WEAR_MAX, 1);
        toQuali(now);
        return true;
      },

      /** Host: skip (the rest of) qualifying and go to the grid with the times set so far. */
      skip: function (now) {
        if (S.phase !== 'quali' || !isNum(now)) return false;
        toGrid(now);
        return true;
      },

      /** Host: end. During the race -> results with the classification as it stands; otherwise -> free. */
      end: function () {
        if (S.phase === 'free') return false;
        if (S.phase === 'race') toResults(); else toFree();
        return true;
      },

      /** Host, from the results: another Grand Prix with the same settings (laps, year, tyre wear). */
      again: function (now) {
        if (S.phase !== 'results' || !isNum(now)) return false;
        toQuali(now);
        return true;
      },

      /** A player reports a completed timed lap. -> '' when accepted, else the reason it was rejected:
       *  'not-racing' | 'no-session' | 'done' | 'bad' | 'too-fast' | 'too-soon' | 'inconsistent' | 'not-driven' | 'no-data'
       *  proof (optional; net/server.js passes it, the single-player game does not):
       *    { dist: m the player's reported positions covered since his previous accepted lap of this phase
       *            (or since the phase began): at least LAP_DIST * len, else 'not-driven';
       *      live: s during which his positions were arriving over that stretch: at least LAP_LIVE * time,
       *            else 'no-data';
       *      at:   ms, his estimate of when he crossed the line on the session clock: the race time is checked
       *            against it instead of the arrival (see raceTime) } */
      lap: function (id, time, now, proof) {
        var p = find(id);
        if (!p || p.spec) return 'not-racing';
        if (isNum(time)) time = ms3(time);
        var why;
        if (S.phase === 'quali') {
          if (p.qDone) return 'done';
          why = validLap(p, time, now, proof);
          if (why) return why;
          p.lastLapAt = now; p.sum += time;
          p.qLaps++;
          if (p.qBest === null || time < p.qBest) { p.qBest = time; p.qSeq = ++bestSeq; }
          if (p.qLaps >= S.q) p.qDone = true;
          checkQualiDone(now);
          return '';
        }
        if (S.phase === 'race') {
          if (p.fin || p.dnf) return 'done';
          why = validLap(p, time, now, proof);
          if (why) return why;
          p.lastLapAt = now; p.sum += time;
          p.rLaps++;
          p.rTime += time;
          raceTime(p, now, proof);
          p.cum.push(p.rTime);
          if (p.rBest === null || time < p.rBest) p.rBest = time;
          if (p.prog < p.rLaps) p.prog = p.rLaps;
          // chequered flag: you finish when you complete the distance, or at your first crossing of the
          // line after the winner has finished
          if (p.rLaps >= S.r || S.winnerAt) {
            p.fin = true; p.finSeq = ++finSeq;
            if (!S.winnerAt) { S.winnerAt = now; S.endsAt = now + RACE_TIMEOUT_MS; }
          }
          checkRaceDone();
          return '';
        }
        return 'no-session';
      },

      /** Live race progress from the player's state messages: laps completed + fraction of the lap.
       *  dist (optional, m; the server passes it): what his reported positions covered since his last counted
       *  lap. The fraction beyond the counted laps is held to what that distance allows (dist / (LAP_DIST * len)),
       *  so a parked car cannot claim to lead; a missing or broken dist is not checked. */
      progress: function (id, value, dist) {
        if (S.phase !== 'race' || !isNum(value)) return;
        var p = find(id);
        if (!p || p.spec || p.fin) return;
        var ahead = 0.9999;
        if (isNum(dist) && S.len > 0) ahead = Math.min(ahead, Math.max(0, dist) / (LAP_DIST * S.len));
        p.prog = Math.max(p.rLaps - 1, Math.min(value, p.rLaps + ahead));
      },

      /** May the cars of players a and b touch (collide, exchange impact reports) at time now?
       *  The server-side mirror of the clients' ghost rule: nobody in qualifying or while the grid is
       *  being formed, and spectators never. */
      solid: function (a, b, now) {
        if (S.phase === 'free') return true;
        if (S.phase === 'quali') return false;
        if (S.phase === 'grid' && !(now >= S.lightsAt)) return false;
        var pa = find(a), pb = find(b);
        return !!pa && !!pb && !pa.spec && !pb.spec;
      },

      /** Time-driven transitions: lights out, race timeout. */
      tick: function (now) {
        if (S.phase === 'grid' && now >= S.goAt) {
          S.phase = 'race';
          players.forEach(function (p) { rebase(p, S.goAt); });
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
                    rLaps: p.rLaps, rTime: ms3(p.rTime), rBest: p.rBest, fin: p.fin, dnf: p.dnf,
                    gap: null, down: 0 };
          if (p.bot) o.bot = true;                    // (human rows stay as they were: the field is only on bots)
          if (leader && !p.spec && p !== leader && !p.dnf) {
            var down = Math.floor(eff(leader) - eff(p) + 1e-9);
            if (leader.fin && p.fin) down = leader.rLaps - p.rLaps;
            if (down >= 1) o.down = down;
            else if (p.rLaps >= 1 && leader.cum.length >= p.rLaps) {
              // measured at the line; never negative (the car behind on the road may have crossed it first)
              o.gap = ms3(Math.max(0, p.cum[p.rLaps - 1] - leader.cum[p.rLaps - 1]));
            }
          }
          return o;
        });
        return {
          sid: S.sid, phase: S.phase, q: S.q, r: S.r, len: S.len, year: S.year, wear: S.wear,
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
    createSession: createSession, minLapTime: minLapTime, cleanYear: cleanYear,
    YEAR_MIN: YEAR_MIN, YEAR_MAX: YEAR_MAX, WEAR_MAX: WEAR_MAX,
    LIGHTS: LIGHTS, LIGHT_MS: LIGHT_MS, RACE_TIMEOUT_MS: RACE_TIMEOUT_MS, GRID_DELAY_MS: GRID_DELAY_MS,
    HOLD_MIN_MS: HOLD_MIN_MS, HOLD_MAX_MS: HOLD_MAX_MS, TIME_TOLERANCE_S: TIME_TOLERANCE_S, LAP_SLACK_S: LAP_SLACK_S,
    LAP_DIST: LAP_DIST, LAP_LIVE: LAP_LIVE, CROSS_LAG_MS: CROSS_LAG_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else {
    var F1 = root.F1 = root.F1 || {};
    F1.createSession = createSession;
    F1.Session = exported;
  }
})(typeof window !== 'undefined' ? window : globalThis);
