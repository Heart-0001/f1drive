const fs = require('fs');
const ROOT = 'C:/Users/user/Desktop/f1drive/';
function patch(file, pairs) {
  let s = fs.readFileSync(ROOT + file, 'utf8');
  for (const [a, b] of pairs) {
    const c = s.split(a).length - 1;
    if (c !== 1) throw new Error(file + ': expected 1 match, got ' + c + ' for: ' + a.slice(0, 70));
    s = s.replace(a, () => b);
  }
  fs.writeFileSync(ROOT + file, s);
  console.log('patched', file);
}

/* ---------------- collide.js ---------------- */
patch('js/collide.js', [
[`  /**
   * F1.resolveCarCollisions(state, others, dt) -> strongest hit this call (0 when nothing touched)`,
`  /**
   * F1.applyCarImpulse(state, ix, iz) -> hit strength 0..1
   * Applies a velocity change (m/s, world XZ) to a car that only has a scalar speed along its heading:
   * the part along the heading changes the speed, the sideways part costs a little speed and turns the
   * nose. Used for impacts reported by the other player's game (see main.js).
   */
  function applyCarImpulse(state, ix, iz) {
    if (!state || !fin(ix) || !fin(iz) || !fin(state.heading)) return 0;
    var j = Math.sqrt(ix * ix + iz * iz);
    if (!(j > 0)) return 0;
    var h = state.heading, v = fin(state.speed) ? state.speed : 0;
    var fx = Math.sin(h), fz = Math.cos(h);
    var side = ix * fz - iz * fx;                  // component towards the driver's left
    var nSpeed = v + ix * fx + iz * fz;
    var fr = SIDE_FRICTION * Math.abs(side);       // rubbing along the side costs a little speed
    if (Math.abs(nSpeed) <= fr) nSpeed = 0; else nSpeed -= nSpeed > 0 ? fr : -fr;
    nSpeed = clamp(nSpeed, -MAX_SPEED, MAX_SPEED);
    var nudge = clamp(0.5 * side / Math.max(Math.abs(v), 8), -MAX_NUDGE, MAX_NUDGE);
    var nHead = h + (v >= 0 ? nudge : -nudge);
    if (!fin(nSpeed) || !fin(nHead)) return 0;
    state.speed = nSpeed; state.heading = nHead;
    var hit = clamp(j / (0.5 * (1 + RESTITUTION) * HIT_REF), 0, 1);
    if (!(state.hit > hit)) state.hit = hit;
    return hit;
  }

  /**
   * F1.resolveCarCollisions(state, others, dt, contacts) -> strongest hit this call (0 when nothing touched)
   *   contacts: optional array; for every impact {i, ix, iz} is pushed: index into others and the velocity
   *             change applied to the LOCAL car (the other car is owed the opposite one)`],
[`  function resolveCarCollisions(state, others, dt) {`, `  function resolveCarCollisions(state, others, dt, contacts) {`],
[`        nHead = h + (v >= 0 ? nudge : -nudge);
        hit = clamp(closing / HIT_REF, 0, 1);
      }
`,
`        nHead = h + (v >= 0 ? nudge : -nudge);
        hit = clamp(closing / HIT_REF, 0, 1);
        if (contacts && fin(j)) contacts.push({ i: i, ix: nx * j, iz: nz * j });
      }
`],
[`  F1.resolveCarCollisions = resolveCarCollisions;`, `  resolveCarCollisions.applyImpulse = applyCarImpulse;
  F1.resolveCarCollisions = resolveCarCollisions;
  F1.applyCarImpulse = applyCarImpulse;`]
]);

/* ---------------- server.js ---------------- */
patch('net/server.js', [
[`const NAME_MAX = 16;`, `const NAME_MAX = 16;
const HIT_MIN_MS = 40;             // a player may report at most one impact per 40 ms
const HIT_MAX = 80;                // m/s, largest velocity change one impact report may ask for`],
[`        state: null, ct: 0, fresh: false, last: null, best: null`, `        state: null, ct: 0, fresh: false, last: null, best: null, hitT: 0`],
[`        case 'track': {
          if (p.id !== hostId) return;`, `        case 'hit': {                              // "my car just hit yours": relayed to that player only
          if (m.k !== trackSeq || !isNum(m.to) || !Array.isArray(m.i) || m.i.length !== 2) return;
          if (!isNum(m.i[0]) || !isNum(m.i[1])) return;
          const target = players.get(m.to);
          if (!target || target === p || now - p.hitT < HIT_MIN_MS) return;
          p.hitT = now;
          let ix = m.i[0], iz = m.i[1];
          const mag = Math.sqrt(ix * ix + iz * iz);
          if (!(mag > 0) || !isNum(mag)) return;
          if (mag > HIT_MAX) { ix *= HIT_MAX / mag; iz *= HIT_MAX / mag; }
          send(target.ws, { t: 'hit', from: p.id, i: [round(ix, 100), round(iz, 100)] });
          break;
        }
        case 'track': {
          if (p.id !== hostId) return;`]
]);

/* ---------------- net.js ---------------- */
patch('js/net.js', [
[`      case 'error': {`, `      case 'hit': {                               // another player's car hit ours
        if (!net.connected || !Array.isArray(m.i) || !isNum(m.from) || !isNum(m.i[0]) || !isNum(m.i[1])) return;
        if (remotes[m.from]) emit('hit', m.from, [m.i[0], m.i[1]]);
        break;
      }
      case 'error': {`],
[`    /** on('connected' | 'disconnected' | 'players' | 'track', fn) */`, `    /** on('connected' | 'disconnected' | 'players' | 'track' | 'hit', fn);  hit: fn(fromId, [ix, iz]) */`],
[`    /** Share lap times (seconds or null) with the room. */`, `    /** Our car hit player id: (ix, iz) is the velocity change (m/s) their car is owed. */
    sendHit: function (id, ix, iz) {
      if (!net.connected || !isNum(id) || !isNum(ix) || !isNum(iz)) return;
      send({ t: 'hit', k: trackSeq, to: id, i: [Math.round(ix * 100) / 100, Math.round(iz * 100) / 100] });
    },

    /** Share lap times (seconds or null) with the room. */`]
]);

/* ---------------- main.js ---------------- */
patch('js/main.js', [
[`  var others = [];                           // states of the active remote cars this frame (for collisions)`,
`  var others = [];                           // states of the active remote cars this frame (for collisions)
  var otherIds = [];                         // player ids, parallel to others
  var contacts = [];                         // impacts of this frame, filled by F1.resolveCarCollisions
  var impacts = {};                          // per player id: {sx, sz: owed to them, not sent yet; lx, lz, t: what we took}
  var lastHitSend = 0, netHit = 0;
  var HIT_SEND_MS = 50;                      // impact reports are batched to 20 Hz
  var HIT_MEMORY_MS = 400;                   // how long an impact we resolved ourselves offsets a reported one
  var HIT_RANGE = 15;                        // m: reports from a car that is nowhere near us are ignored`],
[`    remoteModels = {};
    others.length = 0; mapOthers.length = 0;`, `    remoteModels = {};
    others.length = 0; otherIds.length = 0; mapOthers.length = 0;
    impacts = {}; netHit = 0;`],
[`    others.length = 0;
    var m = 0, id;`, `    others.length = 0; otherIds.length = 0;
    var m = 0, id;`],
[`      others.push(p.state);
      var o =`, `      others.push(p.state);
      otherIds.push(p.id);
      var o =`],
[`  function shareLap() {`, `  // Each game resolves only its own car, and a car that gets hit usually never sees the overlap (the
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

  function shareLap() {`],
[`    net.on('disconnected', function (reason) {`, `    net.on('hit', onRemoteHit);
    net.on('disconnected', function (reason) {`],
[`      var hit = 0, stepped = false;`, `      var hit = netHit, stepped = false;
      netHit = 0;`],
[`        if (collide) F1.resolveCarCollisions(car.state, others, STEP);`, `        if (collide) F1.resolveCarCollisions(car.state, others, STEP, contacts);`],
[`      if (stepped) car.state.hit = hit;   // strongest impact of the frame (car.update clears it every step)`,
`      if (stepped) car.state.hit = hit;   // strongest impact of the frame (car.update clears it every step)
      else netHit = hit;
      if (mp) collectContacts(performance.now());`]
]);
