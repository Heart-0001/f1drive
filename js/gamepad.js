// F1Drive - gamepad (Xbox-style controller) input. No DOM, no THREE; safe to load where the Gamepad API
// does not exist (node tests, old browsers): poll() then just reports "not connected".
//
//   F1.gamepad.poll()  -> F1.gamepad.state   call once per rendered frame (never allocates)
//   state = {
//     connected, id,
//     throttle 0..1   right trigger (RT)
//     brake    0..1   left trigger (LT)
//     steer   -1..1   left stick X,  +1 = LEFT  (same sign as car.state.steer; stick pushed left -> +1)
//     lookX   -1..1   right stick X, +1 = look LEFT
//     lookY   -1..1   right stick Y, +1 = look UP
//     up, down, left, right   D-pad as digital keys (OR them with the keyboard booleans)
//     pressed: { reset, line, menu, recentre }   true only on the frame the button goes down
//   }
//   F1.gamepad.active            true while the pad has given non-zero input in the last ACTIVE_HOLD_MS
//   F1.gamepad.mergeInput(keys, out) -> out   keyboard booleans + pad -> the object for car.update()
//   F1.gamepad.rumble(strength 0..1, ms)      no-op where unsupported
//   F1.gamepad.onChange = function (connected, id) {}   optional, called when a pad appears / goes away
//
// Buttons (standard mapping): A or Y = reset to track (R), X = racing line (L), Start/Menu = menu (Esc),
// right-stick click = recentre view, D-pad = digital steer / throttle / brake.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  // ---- tuning -------------------------------------------------------------
  var STICK_DEADZONE = 0.12;     // radial; output is rescaled to start at 0 at the edge of the deadzone
  var TRIGGER_DEADZONE = 0.04;   // triggers; rescaled the same way
  var STEER_EXPO = 1.6;          // steer = sign(x) * |x|^STEER_EXPO: fine corrections around the centre
  var LOOK_EXPO = 1.3;           // same idea for the head-look stick (1 = linear)
  var BUTTON_THRESHOLD = 0.5;    // analog value at which a button counts as pressed
  var ACTIVE_HOLD_MS = 1500;     // `active` stays true this long after the last non-zero pad input
  var EDGE_RESYNC_MS = 500;      // poll() not called for this long (menu, hidden tab): buttons that are
                                 //   already down on the next poll do not count as fresh presses
  var RUMBLE_MIN_GAP_MS = 60;    // weaker rumbles requested sooner than this after a stronger one are dropped

  // standard-mapping indices (https://w3c.github.io/gamepad/#remapping)
  var B_A = 0, B_X = 2, B_Y = 3, B_LT = 6, B_RT = 7, B_START = 9, B_RS = 11,
      B_DUP = 12, B_DDOWN = 13, B_DLEFT = 14, B_DRIGHT = 15;

  var state = {
    connected: false, id: '',
    throttle: 0, brake: 0, steer: 0, lookX: 0, lookY: 0,
    up: false, down: false, left: false, right: false,
    pressed: { reset: false, line: false, menu: false, recentre: false }
  };
  var held = { reset: false, line: false, menu: false, recentre: false };
  var stick = { x: 0, y: 0 };            // scratch for deadzone()
  var padIndex = -1, lastPoll = -1e9, lastInput = -1e9;
  var trigSeen = [false, false];         // non-standard pads: trigger axis has moved off its bogus initial 0
  var lastRumbleT = -1e9, lastRumbleS = 0, lastRumbleEnd = -1e9;

  var gp = F1.gamepad = {
    state: state,
    active: false,
    onChange: null,
    config: {
      stickDeadzone: STICK_DEADZONE, triggerDeadzone: TRIGGER_DEADZONE,
      steerExpo: STEER_EXPO, lookExpo: LOOK_EXPO, activeHoldMs: ACTIVE_HOLD_MS
    },
    poll: poll,
    mergeInput: mergeInput,
    rumble: rumble
  };

  function now() {
    var p = root.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }
  function finite(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : 0; }

  // radial deadzone: (x, y) -> stick.x / stick.y, magnitude rescaled to 0..1 from the deadzone edge
  function deadzone(x, y) {
    var dz = gp.config.stickDeadzone;
    var m = Math.sqrt(x * x + y * y);
    if (!(m > dz)) { stick.x = 0; stick.y = 0; return; }
    var k = Math.min(1, (m - dz) / (1 - dz)) / m;
    stick.x = x * k; stick.y = y * k;
  }
  function curve(v, expo) {
    if (v === 0) return 0;
    var a = Math.pow(Math.min(1, Math.abs(v)), expo);
    return v < 0 ? -a : a;
  }
  function trigger(v) {
    var dz = gp.config.triggerDeadzone;
    if (!(v > dz)) return 0;
    v = (v - dz) / (1 - dz);
    return v > 1 ? 1 : v;
  }
  function btnValue(pad, i) {
    var b = pad.buttons && pad.buttons[i];
    if (b == null) return 0;
    if (typeof b === 'number') return finite(b);            // very old implementations
    var v = finite(b.value);
    return b.pressed && v <= 0 ? 1 : v;                     // digital-only trigger
  }
  function btnDown(pad, i) {
    var b = pad.buttons && pad.buttons[i];
    if (b == null) return false;
    if (typeof b === 'number') return b > BUTTON_THRESHOLD;
    return !!b.pressed || finite(b.value) > BUTTON_THRESHOLD;
  }
  function axis(pad, i) { return pad.axes && i < pad.axes.length ? finite(pad.axes[i]) : 0; }
  // non-standard pads report the triggers as axes resting at -1 (fully pressed = +1); many drivers
  // report 0 until the trigger is first touched, which would read as half pressed
  function triggerAxis(pad, i, slot) {
    var v = axis(pad, i);
    if (!trigSeen[slot]) {
      if (v === 0) return 0;
      trigSeen[slot] = true;
    }
    return (v + 1) / 2;
  }

  function clearState() {
    state.throttle = state.brake = state.steer = state.lookX = state.lookY = 0;
    state.up = state.down = state.left = state.right = false;
    var p = state.pressed;
    p.reset = p.line = p.menu = p.recentre = false;
  }
  function setConnected(pad) {
    var was = state.connected, wasId = state.id;
    state.connected = !!pad;
    state.id = pad ? String(pad.id || '') : '';
    if (!pad) {
      padIndex = -1;
      held.reset = held.line = held.menu = held.recentre = false;
      clearState();
      gp.active = false;
    }
    if ((was !== state.connected || wasId !== state.id) && typeof gp.onChange === 'function') {
      try { gp.onChange(state.connected, state.id); } catch (e) { /* a UI callback must not break input */ }
    }
  }

  function getPads() {
    var nav = root.navigator;
    if (!nav || typeof nav.getGamepads !== 'function') return null;
    try { return nav.getGamepads(); } catch (e) { return null; }     // blocked by a permissions policy
  }
  // first connected pad with the standard mapping, else the first connected pad of any kind
  function pick(pads) {
    var any = null;
    if (!pads) return null;
    for (var i = 0; i < pads.length; i++) {
      var p = pads[i];
      if (!p || p.connected === false) continue;
      if (p.mapping === 'standard') return p;
      if (!any) any = p;
    }
    return any;
  }

  function poll() {
    var t = now();
    var pad = pick(getPads());
    var fresh = t - lastPoll > EDGE_RESYNC_MS;      // first poll, or polling was suspended
    lastPoll = t;
    if (!pad) {
      if (state.connected) setConnected(null);
      gp.active = false;
      return state;
    }
    if (!state.connected || pad.index !== padIndex || state.id !== String(pad.id || '')) {
      padIndex = pad.index;
      trigSeen[0] = trigSeen[1] = false;
      fresh = true;                                  // buttons already held on a new pad are not presses
      setConnected(pad);
    }

    var cfg = gp.config;
    var lx, ly, rx, ry, thr, brk, dU, dD, dL, dR, bReset, bLine, bMenu, bRe;
    var nAxes = pad.axes ? pad.axes.length : 0;
    if (pad.mapping === 'standard' || nAxes < 6) {
      // standard layout (also assumed for unmapped pads with 4-5 axes: triggers are buttons 6 / 7)
      lx = axis(pad, 0); ly = axis(pad, 1); rx = axis(pad, 2); ry = axis(pad, 3);
      brk = btnValue(pad, B_LT); thr = btnValue(pad, B_RT);
      dU = btnDown(pad, B_DUP); dD = btnDown(pad, B_DDOWN); dL = btnDown(pad, B_DLEFT); dR = btnDown(pad, B_DRIGHT);
      bReset = btnDown(pad, B_A) || btnDown(pad, B_Y);
      bLine = btnDown(pad, B_X);
      bMenu = btnDown(pad, B_START);
      bRe = btnDown(pad, B_RS);
    } else {
      // raw XInput-style layout (Firefox / Linux, no mapping): axes = LX LY LT RX RY RT [hatX hatY],
      // buttons = A B X Y LB RB Back Start Guide LS RS
      lx = axis(pad, 0); ly = axis(pad, 1); rx = axis(pad, 3); ry = axis(pad, 4);
      brk = triggerAxis(pad, 2, 0); thr = triggerAxis(pad, 5, 1);
      var hx = axis(pad, 6), hy = axis(pad, 7);
      dL = hx < -0.5; dR = hx > 0.5; dU = hy < -0.5; dD = hy > 0.5;
      bReset = btnDown(pad, 0) || btnDown(pad, 3);
      bLine = btnDown(pad, 2);
      bMenu = btnDown(pad, 7);
      bRe = btnDown(pad, 10);
    }

    deadzone(lx, ly);
    state.steer = -curve(stick.x, cfg.steerExpo) || 0;       // stick left (axis -1) = +1; "|| 0" avoids -0
    deadzone(rx, ry);
    state.lookX = -curve(stick.x, cfg.lookExpo) || 0;        // stick left = look left = +1
    state.lookY = -curve(stick.y, cfg.lookExpo) || 0;        // stick up (axis -1) = look up = +1
    state.throttle = trigger(thr);
    state.brake = trigger(brk);
    state.up = dU; state.down = dD; state.left = dL; state.right = dR;

    var p = state.pressed;
    p.reset = bReset && !held.reset && !fresh;
    p.line = bLine && !held.line && !fresh;
    p.menu = bMenu && !held.menu && !fresh;
    p.recentre = bRe && !held.recentre && !fresh;
    held.reset = bReset; held.line = bLine; held.menu = bMenu; held.recentre = bRe;

    if (state.throttle > 0 || state.brake > 0 || state.steer !== 0 || state.lookX !== 0 || state.lookY !== 0 ||
        dU || dD || dL || dR || bReset || bLine || bMenu || bRe) lastInput = t;
    gp.active = t - lastInput <= cfg.activeHoldMs;
    return state;
  }

  // Keyboard + pad -> the input object for car.update(). `keys` = {up, down, left, right} booleans (not
  // modified), `out` is filled in and returned. Per axis, whichever device has input wins: the analog
  // fields are null while the pad is at rest, so car.js falls back to the booleans exactly as without a
  // pad; when both are used at once car.js takes the larger magnitude.
  function mergeInput(keys, out) {
    out = out || {};
    keys = keys || {};
    var on = state.connected;
    out.up = !!keys.up || (on && state.up);
    out.down = !!keys.down || (on && state.down);
    out.left = !!keys.left || (on && state.left);
    out.right = !!keys.right || (on && state.right);
    out.throttle = on && state.throttle > 0 ? state.throttle : null;
    out.brake = on && state.brake > 0 ? state.brake : null;
    out.steerAxis = on && state.steer !== 0 ? state.steer : null;
    return out;
  }

  // Body rumble (wall / car impacts). strength 0..1, ms = duration. Silently does nothing without a pad
  // or without haptics support.
  function rumble(strength, ms) {
    if (!state.connected) return false;
    strength = strength > 1 ? 1 : (strength > 0 ? strength : 0);
    ms = ms > 0 ? Math.min(ms, 2000) : 0;
    if (!strength || !ms) return false;
    var t = now();
    // a wall scrape calls this every frame: let the stronger effect that is still playing finish
    if (t - lastRumbleT < RUMBLE_MIN_GAP_MS || (t < lastRumbleEnd && strength < lastRumbleS)) return false;
    var pads = getPads(), pad = pads && padIndex >= 0 ? pads[padIndex] : null;
    if (!pad) return false;
    try {
      var act = pad.vibrationActuator;
      if (act && typeof act.playEffect === 'function') {
        var pr = act.playEffect('dual-rumble', {
          startDelay: 0, duration: ms,
          weakMagnitude: Math.min(1, strength * 0.8 + 0.1), strongMagnitude: strength
        });
        if (pr && typeof pr.then === 'function') pr.then(null, function () {});
      } else if (pad.hapticActuators && pad.hapticActuators[0] && typeof pad.hapticActuators[0].pulse === 'function') {
        pad.hapticActuators[0].pulse(strength, ms);           // Firefox
      } else {
        return false;
      }
    } catch (e) { return false; }
    lastRumbleT = t; lastRumbleS = strength; lastRumbleEnd = t + ms;
    return true;
  }

  // Chrome only lists a pad after a button was pressed on it; the events make `connected` and
  // onChange prompt even while nothing polls (menu). Polling alone is enough everywhere else.
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('gamepadconnected', function () { if (!state.connected) poll(); });
    root.addEventListener('gamepaddisconnected', function (e) {
      // another pad, if any, is picked up by the next poll()
      if (e && e.gamepad && e.gamepad.index === padIndex) setConnected(null);
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
