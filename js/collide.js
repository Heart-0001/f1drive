// F1Drive - car-to-car collision for the LOCAL car against the (interpolated) remote cars.
// Pure math: no DOM, no THREE; also loadable in node (module.exports). See js/README-interfaces.md.
//
// Every client resolves only its own car, so the response is symmetric: each side takes a bit more
// than half of the overlap and its own half of the equal-mass impulse. The car model only has a
// scalar `speed` along `heading`, so the new velocity is projected back onto the heading and the
// sideways part becomes a small heading nudge.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var HALF_LEN = 2.7, HALF_WID = 0.95;   // oriented box 5.4 x 1.9 m, centred on the car origin
  var BROAD = 8.0;                       // centres further apart than this cannot touch
  var MAX_DY = 1.5;                      // height difference that means "different level" (bridges)
  var RESTITUTION = 0.2;
  var SHARE = 0.6;                       // part of the overlap the local car takes when the other one is moving
  var SLOW = 1.0;                        // m/s: the other car counts as stationary below this -> take all of it
  var HIT_REF = 30.0;                    // closing speed (m/s) giving hit = 1
  var SIDE_FRICTION = 0.1;
  var MAX_NUDGE = 0.05;                  // rad of heading change per call
  var MAX_SPEED = 130;                   // sanity clamp, m/s
  var SWEEP_STEP = 0.8;                  // m of relative travel per sweep sample (well under the 1.9 m box width)

  function fin(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var out = { pen: 0, nx: 0, nz: 0 };

  // Separating-axis test for two car boxes in the XZ plane. Returns true and fills `out` with the
  // minimum translation (pen > 0, unit normal pointing from B towards A) when they overlap.
  function sat(ax, az, ah, bx, bz, bh) {
    var sa = Math.sin(ah), ca = Math.cos(ah), sb = Math.sin(bh), cb = Math.cos(bh);
    var dx = ax - bx, dz = az - bz;
    // |cos|, |sin| of the angle between the two headings
    var c = Math.abs(sa * sb + ca * cb), s = Math.abs(sa * cb - ca * sb);
    var best = Infinity, bnx = 0, bnz = 0, o, p;

    // A forward (sa, ca)
    p = dx * sa + dz * ca;
    o = HALF_LEN + HALF_LEN * c + HALF_WID * s - Math.abs(p);
    if (o <= 0) return false;
    best = o; bnx = p < 0 ? -sa : sa; bnz = p < 0 ? -ca : ca;
    // A side (ca, -sa)
    p = dx * ca - dz * sa;
    o = HALF_WID + HALF_LEN * s + HALF_WID * c - Math.abs(p);
    if (o <= 0) return false;
    if (o < best) { best = o; bnx = p < 0 ? -ca : ca; bnz = p < 0 ? sa : -sa; }
    // B forward (sb, cb)
    p = dx * sb + dz * cb;
    o = HALF_LEN + HALF_LEN * c + HALF_WID * s - Math.abs(p);
    if (o <= 0) return false;
    if (o < best) { best = o; bnx = p < 0 ? -sb : sb; bnz = p < 0 ? -cb : cb; }
    // B side (cb, -sb)
    p = dx * cb - dz * sb;
    o = HALF_WID + HALF_LEN * s + HALF_WID * c - Math.abs(p);
    if (o <= 0) return false;
    if (o < best) { best = o; bnx = p < 0 ? -cb : cb; bnz = p < 0 ? sb : -sb; }

    out.pen = best; out.nx = bnx; out.nz = bnz;
    return true;
  }

  /**
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
   *             change applied to the LOCAL car (the other car is owed the opposite one)
   *   state : the local car.state (x, z, heading, speed [, y]); modified in place (x, z, speed, heading, hit)
   *   others: [{x, z, heading, speed [, y]}]  remote cars, read only
   *   dt    : the physics step just taken (used to catch contacts that started and ended inside the step)
   */
  function resolveCarCollisions(state, others, dt, contacts) {
    if (!state || !others || !others.length) return 0;
    if (!fin(state.x) || !fin(state.z) || !fin(state.heading)) return 0;
    if (!fin(state.speed)) state.speed = 0;
    if (!(dt > 0) || !fin(dt)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    var maxHit = 0;

    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      if (!o || !fin(o.x) || !fin(o.z) || !fin(o.heading)) continue;
      if (fin(state.y) && fin(o.y) && Math.abs(state.y - o.y) > MAX_DY) continue;

      var h = state.heading, v = state.speed;
      var fx = Math.sin(h), fz = Math.cos(h);
      var vb = fin(o.speed) ? clamp(o.speed, -MAX_SPEED, MAX_SPEED) : 0;
      var vax = fx * v, vaz = fz * v;
      var vbx = Math.sin(o.heading) * vb, vbz = Math.cos(o.heading) * vb;
      var rvx = vax - vbx, rvz = vaz - vbz;
      var relStep = Math.sqrt(rvx * rvx + rvz * rvz) * dt;

      var dx = state.x - o.x, dz = state.z - o.z, reach = BROAD + relStep;
      if (dx * dx + dz * dz > reach * reach) continue;

      var ax = state.x, az = state.z, bx = o.x, bz = o.z;
      var found = sat(ax, az, h, bx, bz, o.heading);
      if (!found && relStep > SWEEP_STEP) {
        // The two boxes moved a long way relative to each other this step: look back along the step
        // for a contact that was passed through, earliest first, and resolve it where it happened
        // (the local car is put back on its own path, never anywhere it has not just been).
        var n = Math.min(8, Math.ceil(relStep / SWEEP_STEP));
        for (var k = n - 1; k >= 1 && !found; k--) {
          var back = dt * k / n;
          ax = state.x - vax * back; az = state.z - vaz * back;
          bx = o.x - vbx * back; bz = o.z - vbz * back;
          found = sat(ax, az, h, bx, bz, o.heading);
        }
      }
      if (!found) continue;

      var pen = out.pen, nx = out.nx, nz = out.nz;
      var vn = rvx * nx + rvz * nz;                // < 0: closing
      var share = Math.abs(vb) < SLOW ? 1 : SHARE;
      var nxPos = ax + nx * pen * share, nzPos = az + nz * pen * share;
      var nSpeed = v, nHead = h, hit = 0;

      if (vn < 0) {
        var closing = -vn;
        var j = 0.5 * (1 + RESTITUTION) * closing;  // equal masses: each car's share of the velocity change
        var lx = fz, lz = -fx;                      // driver's left
        var nLeft = nx * lx + nz * lz;
        nSpeed = (vax + nx * j) * fx + (vaz + nz * j) * fz;
        // rubbing along the side costs a little speed
        var fr = SIDE_FRICTION * j * Math.abs(nLeft);
        if (Math.abs(nSpeed) <= fr) nSpeed = 0; else nSpeed -= nSpeed > 0 ? fr : -fr;
        nSpeed = clamp(nSpeed, -MAX_SPEED, MAX_SPEED);
        // sideways part of the impulse -> turn the nose away from the other car
        var nudge = clamp(0.5 * j * nLeft / Math.max(Math.abs(v), 8), -MAX_NUDGE, MAX_NUDGE);
        nHead = h + (v >= 0 ? nudge : -nudge);
        hit = clamp(closing / HIT_REF, 0, 1);
        if (contacts && fin(j)) contacts.push({ i: i, ix: nx * j, iz: nz * j });
      }

      if (!fin(nxPos) || !fin(nzPos) || !fin(nSpeed) || !fin(nHead)) continue;
      state.x = nxPos; state.z = nzPos; state.speed = nSpeed; state.heading = nHead;
      if (hit > maxHit) maxHit = hit;
    }

    if (maxHit > 0 && !(state.hit > maxHit)) state.hit = maxHit;
    return maxHit;
  }

  resolveCarCollisions.HALF_LEN = HALF_LEN;
  resolveCarCollisions.HALF_WID = HALF_WID;
  resolveCarCollisions.overlap = function (a, b) {   // test helper: penetration depth, 0 when apart
    return sat(a.x, a.z, a.heading, b.x, b.z, b.heading) ? out.pen : 0;
  };

  resolveCarCollisions.applyImpulse = applyCarImpulse;
  F1.resolveCarCollisions = resolveCarCollisions;
  F1.applyCarImpulse = applyCarImpulse;
  if (typeof module !== 'undefined' && module.exports) module.exports = resolveCarCollisions;
})(typeof window !== 'undefined' ? window : globalThis);
