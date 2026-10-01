const assert = require('assert');
const P = require('path').resolve(__dirname, '..', '..') + '/js/';
let T = 0; const ok = (n, f) => { f(); T++; console.log('ok  ' + n); };
const near = (a, b, e = 1e-9) => assert(Math.abs(a - b) <= e, a + ' !~ ' + b);
function load(file) { delete require.cache[require.resolve(P + file)]; require(P + file); }

// --- 1. no Gamepad API at all
global.window = global; delete global.F1;
let clock = 0; Object.defineProperty(global, 'performance', { value: { now: () => clock }, configurable: true });
Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true });
load('gamepad.js');
let G = global.F1.gamepad;
ok('no API: poll is safe, not connected', () => {
  const s = G.poll(); assert.strictEqual(s.connected, false); assert.strictEqual(G.active, false);
  assert.strictEqual(G.rumble(1, 100), false);
  const o = G.mergeInput({ up: true }, {}); assert.deepStrictEqual(o, { up: true, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false, limiter: false });
  assert.deepStrictEqual(G.mergeInput({ boost: true, limiter: true }, {}), { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: true, limiter: true });
  assert.deepStrictEqual(G.state.pressed, { reset: false, line: false, menu: false, recentre: false, limiter: false, compound: false });
});

// --- 2. stubbed standard pad
function std(id) {
  const b = []; for (let i = 0; i < 17; i++) b.push({ pressed: false, value: 0 });
  return { index: 0, id: id || 'Xbox Wireless Controller (STANDARD GAMEPAD)', connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: b };
}
let pads = [null, null, null, null];
const listeners = {};
global.addEventListener = (n, f) => { listeners[n] = f; };
global.navigator = { getGamepads: () => pads };
delete global.F1; load('gamepad.js'); G = global.F1.gamepad;
const tick = () => { clock += 16; return G.poll(); };
const changes = []; G.onChange = (c, id) => changes.push([c, id]);

ok('empty slots: not connected', () => assert.strictEqual(tick().connected, false));
let pad = std(); pads[0] = pad;
ok('connect', () => { const s = tick(); assert(s.connected); assert(/Xbox/.test(s.id)); assert.deepStrictEqual(changes[0][0], true); assert.strictEqual(G.active, false); });
ok('same state object every poll (no allocation)', () => { const a = tick(), b = tick(); assert.strictEqual(a, b); assert.strictEqual(a.pressed, b.pressed); assert.strictEqual(a, G.state); });
ok('stick deadzone: inside -> exactly 0', () => { pad.axes[0] = 0.11; pad.axes[1] = 0.03; assert.strictEqual(tick().steer, 0); pad.axes[0] = -0.08; pad.axes[1] = -0.08; assert.strictEqual(tick().steer, 0); assert(Object.is(G.state.steer, 0)); });
ok('stick deadzone: rescaled from the edge, curve 1.6', () => {
  pad.axes[1] = 0; pad.axes[0] = -0.13; let s = tick().steer; assert(s > 0 && s < 0.002, 'starts near 0: ' + s);
  pad.axes[0] = -0.56; near(tick().steer, Math.pow(0.5, 1.6));            // (0.56-0.12)/0.88 = 0.5
  pad.axes[0] = -1; near(tick().steer, 1); pad.axes[0] = 1; near(tick().steer, -1);
});
ok('sign: stick LEFT (axis -1) -> steer +1; right -> -1; monotonic', () => {
  let prev = -2; for (let x = 1; x >= -1.0001; x -= 0.05) { pad.axes[0] = x; const s = tick().steer; assert(s >= prev - 1e-12); prev = s; }
  pad.axes[0] = -0.5; assert(tick().steer > 0); pad.axes[0] = 0.5; assert(tick().steer < 0);
});
ok('radial: diagonal overshoot clamps to |1|', () => { pad.axes[0] = -1; pad.axes[1] = -1; const s = tick().steer; assert(s > 0.5 && s <= 1); pad.axes[0] = pad.axes[1] = 0; });
ok('look: right stick left -> lookX +1, up (axis -1) -> lookY +1', () => {
  pad.axes[2] = -1; pad.axes[3] = 0; let s = tick(); near(s.lookX, 1); assert.strictEqual(s.lookY, 0);
  pad.axes[2] = 0; pad.axes[3] = -1; s = tick(); near(s.lookY, 1); assert.strictEqual(s.lookX, 0);
  pad.axes[2] = 1; pad.axes[3] = 1; s = tick(); assert(s.lookX < 0 && s.lookY < 0);
  pad.axes[2] = 0.1; pad.axes[3] = -0.05; s = tick(); assert.strictEqual(s.lookX, 0); assert.strictEqual(s.lookY, 0);
  pad.axes[2] = pad.axes[3] = 0;
});
ok('triggers: RT throttle, LT brake, deadzone 0.04 rescaled', () => {
  pad.buttons[7].value = 0.03; assert.strictEqual(tick().throttle, 0);
  pad.buttons[7].value = 0.52; near(tick().throttle, 0.5); assert.strictEqual(G.state.brake, 0);
  pad.buttons[7].value = 1; near(tick().throttle, 1);
  pad.buttons[7].value = 0; pad.buttons[6].value = 0.52; near(tick().brake, 0.5); assert.strictEqual(G.state.throttle, 0);
  pad.buttons[6].value = 0; pad.buttons[6].pressed = true; near(tick().brake, 1);   // digital-only trigger
  pad.buttons[6].pressed = false; tick();
});
ok('buttons are edge-triggered', () => {
  const press = (i, v) => { pad.buttons[i].pressed = v; pad.buttons[i].value = v ? 1 : 0; };
  for (const [i, k] of [[0, 'reset'], [3, 'reset'], [2, 'line'], [9, 'menu'], [11, 'recentre']]) {
    press(i, true); assert.strictEqual(tick().pressed[k], true, k + ' down'); assert.strictEqual(tick().pressed[k], false, k + ' held');
    assert.strictEqual(tick().pressed[k], false); press(i, false); assert.strictEqual(tick().pressed[k], false, k + ' up');
    for (const o of ['reset', 'line', 'menu', 'recentre', 'limiter', 'compound']) assert.strictEqual(G.state.pressed[o], false);
  }
  press(0, true); tick(); press(3, true); assert.strictEqual(tick().pressed.reset, false, 'Y while A held is not a second press'); press(0, false); press(3, false); tick();
  press(1, true); const s = tick(); assert(!s.pressed.reset && !s.pressed.line && !s.pressed.menu); press(1, false); tick();
});
ok('v6: RB or B held = boost; LB = pressed.limiter, Back/View = pressed.compound (edges); mergeInput merges boost, passes limiter', () => {
  const press = (i, v) => { pad.buttons[i].pressed = v; pad.buttons[i].value = v ? 1 : 0; };
  for (const i of [5, 1]) {
    press(i, true); assert.strictEqual(tick().boost, true, 'button ' + i); assert.strictEqual(tick().boost, true, 'held: still on');
    assert(!G.state.pressed.limiter && !G.state.pressed.compound && !G.state.pressed.reset);
    const o = G.mergeInput({ up: true, limiter: true }, {}); assert.strictEqual(o.boost, true); assert.strictEqual(o.limiter, true);
    press(i, false); assert.strictEqual(tick().boost, false);
    assert.strictEqual(G.mergeInput({ boost: true }, {}).boost, true, 'E key alone'); assert.strictEqual(G.mergeInput({}, {}).boost, false);
  }
  for (const [i, k] of [[4, 'limiter'], [8, 'compound']]) {
    press(i, true); assert.strictEqual(tick().pressed[k], true, k + ' down'); assert.strictEqual(tick().pressed[k], false, k + ' held');
    assert.strictEqual(G.state.boost, false);
    press(i, false); assert.strictEqual(tick().pressed[k], false, k + ' up');
    press(i, true); assert.strictEqual(tick().pressed[k], true, k + ' again'); press(i, false); tick();
  }
  // the pad never toggles the limiter itself: out.limiter is only what main.js keeps in keys.limiter
  press(4, true); tick(); assert.strictEqual(G.mergeInput({}, {}).limiter, false); press(4, false); tick();
  // a held LB / Back while polling was suspended is not a press
  press(4, true); press(8, true); clock += 3000; const s = G.poll(); assert(!s.pressed.limiter && !s.pressed.compound); press(4, false); press(8, false); tick();
  // active
  clock += 5000; G.poll(); assert.strictEqual(G.active, false); press(5, true); tick(); assert.strictEqual(G.active, true); press(5, false); tick();
});
ok('button held while polling was suspended (menu) is not a press', () => {
  pad.buttons[0].pressed = true; pad.buttons[0].value = 1; clock += 3000; assert.strictEqual(G.poll().pressed.reset, false);
  pad.buttons[0].pressed = false; pad.buttons[0].value = 0; tick();
  pad.buttons[0].pressed = true; assert.strictEqual(tick().pressed.reset, true); pad.buttons[0].pressed = false; tick();
});
ok('d-pad as digital keys', () => {
  pad.buttons[14].pressed = true; pad.buttons[12].pressed = true; const s = tick(); assert(s.left && s.up && !s.right && !s.down); assert.strictEqual(s.steer, 0);
  const o = G.mergeInput({ up: false, down: false, left: false, right: true }, {}); assert(o.left && o.right && o.up && !o.down);
  pad.buttons[14].pressed = pad.buttons[12].pressed = false; tick();
});
ok('active: true on input, expires after the hold time', () => {
  clock += 5000; G.poll(); assert.strictEqual(G.active, false);
  pad.buttons[7].value = 0.6; tick(); assert.strictEqual(G.active, true);
  pad.buttons[7].value = 0; tick(); assert.strictEqual(G.active, true);
  for (let i = 0; i < 60; i++) tick(); assert.strictEqual(G.active, true);    // 0.96 s
  for (let i = 0; i < 40; i++) tick(); assert.strictEqual(G.active, false);   // > 1.5 s
});
ok('mergeInput: pad at rest -> nulls (keyboard applies); pad input -> analog fields', () => {
  const keys = { up: true, down: false, left: false, right: false }, out = {};
  assert.strictEqual(G.mergeInput(keys, out), out);
  assert.deepStrictEqual(out, { up: true, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false, limiter: false });
  pad.buttons[7].value = 0.52; pad.buttons[6].value = 1; pad.axes[0] = -1; tick(); G.mergeInput(keys, out);
  near(out.throttle, 0.5); near(out.brake, 1); near(out.steerAxis, 1); assert.strictEqual(keys.throttle, undefined);
  pad.buttons[7].value = pad.buttons[6].value = 0; pad.axes[0] = 0; tick();
});
ok('rumble: uses vibrationActuator, clamps, throttles weaker repeats, survives rejection', () => {
  const calls = []; pad.vibrationActuator = { playEffect: (t, o) => { calls.push([t, o]); return Promise.reject(new Error('x')); } };
  clock += 1000; assert.strictEqual(G.rumble(2, 200), true); assert.strictEqual(calls[0][0], 'dual-rumble'); assert.strictEqual(calls[0][1].strongMagnitude, 1); assert.strictEqual(calls[0][1].duration, 200);
  clock += 100; assert.strictEqual(G.rumble(0.3, 200), false, 'weaker while the strong one plays');
  clock += 200; assert.strictEqual(G.rumble(0.3, 100), true); assert.strictEqual(calls.length, 2);
  assert.strictEqual(G.rumble(0, 100), false); assert.strictEqual(G.rumble(0.5, 0), false);
  pad.vibrationActuator = { playEffect: () => { throw new Error('boom'); } }; clock += 1000; assert.strictEqual(G.rumble(1, 100), false);
  delete pad.vibrationActuator; clock += 1000; assert.strictEqual(G.rumble(1, 100), false);
});
ok('disconnect by polling: state zeroed, onChange fired', () => {
  pad.buttons[7].value = 1; pad.axes[0] = -1; pad.axes[2] = 1; pad.buttons[5].pressed = true; tick(); assert(G.state.throttle > 0 && G.state.boost);
  pad.buttons[5].pressed = false;
  pads[0] = null; const s = tick();
  assert.strictEqual(s.connected, false); assert.strictEqual(s.id, ''); assert.strictEqual(s.throttle, 0); assert.strictEqual(s.steer, 0); assert.strictEqual(s.lookX, 0);
  assert.strictEqual(s.boost, false);
  assert.strictEqual(G.active, false); assert.deepStrictEqual(changes[changes.length - 1], [false, '']);
  const o = G.mergeInput({ left: true }, {}); assert.strictEqual(o.throttle, null); assert.strictEqual(o.left, true);
  assert.strictEqual(G.rumble(1, 100), false);
});
ok('connected:false entries are ignored; reconnect with a held button is not a press', () => {
  pad.connected = false; pads[0] = pad; assert.strictEqual(tick().connected, false);
  pad.connected = true; pad.buttons[7].value = 0; pad.axes[0] = 0; pad.axes[2] = 0; pad.buttons[9].pressed = true;
  const s = tick(); assert(s.connected); assert.strictEqual(s.pressed.menu, false); pad.buttons[9].pressed = false; tick();
});
ok('events: gamepaddisconnected clears at once, gamepadconnected polls', () => {
  assert(listeners.gamepadconnected && listeners.gamepaddisconnected);
  pad.buttons[7].value = 1; tick(); pads[0] = null;
  listeners.gamepaddisconnected({ gamepad: { index: 0 } }); assert.strictEqual(G.state.connected, false); assert.strictEqual(G.state.throttle, 0);
  pads[0] = pad; listeners.gamepadconnected({ gamepad: pad }); assert.strictEqual(G.state.connected, true);
  pad.buttons[7].value = 0; tick();
});
ok('standard pad preferred over an earlier non-standard one', () => {
  const raw = { index: 0, id: 'raw', connected: true, mapping: '', axes: [0, 0, 0, 0, 0, 0], buttons: [] };
  pad.index = 1; pads[0] = raw; pads[1] = pad; assert(/Xbox/.test(tick().id));
  pads[1] = null; assert.strictEqual(tick().id, 'raw'); pads[0] = null; tick(); pad.index = 0;
});
ok('non-standard fallback: triggers on axes 2/5 (rest -1), right stick on 3/4, hat on 6/7', () => {
  const b = []; for (let i = 0; i < 11; i++) b.push({ pressed: false, value: 0 });
  const raw = { index: 0, id: 'Microsoft X-Box pad (raw)', connected: true, mapping: '', axes: [0, 0, 0, 0, 0, 0, 0, 0], buttons: b };
  pads[0] = raw; let s = tick();
  assert.strictEqual(s.throttle, 0, 'untouched trigger axis reading 0 is not half throttle'); assert.strictEqual(s.brake, 0);
  raw.axes[2] = -1; raw.axes[5] = -1; s = tick(); assert.strictEqual(s.throttle, 0); assert.strictEqual(s.brake, 0);
  raw.axes[5] = 1; s = tick(); near(s.throttle, 1); assert.strictEqual(s.brake, 0);
  raw.axes[5] = 0; near(tick().throttle, (0.5 - 0.04) / 0.96);               // now a real half press
  raw.axes[5] = -1; raw.axes[2] = 1; s = tick(); near(s.brake, 1); assert.strictEqual(s.throttle, 0); raw.axes[2] = -1;
  raw.axes[0] = -1; near(tick().steer, 1); raw.axes[0] = 0;
  raw.axes[3] = -1; raw.axes[4] = 0; s = tick(); near(s.lookX, 1); assert.strictEqual(s.lookY, 0);
  raw.axes[3] = 0; raw.axes[4] = -1; s = tick(); near(s.lookY, 1); raw.axes[4] = 0;
  raw.axes[6] = -1; raw.axes[7] = 1; s = tick(); assert(s.left && s.down && !s.right && !s.up); raw.axes[6] = raw.axes[7] = 0;
  b[7].pressed = true; assert.strictEqual(tick().pressed.menu, true); b[7].pressed = false;
  b[2].pressed = true; assert.strictEqual(tick().pressed.line, true); b[2].pressed = false;
  b[10].pressed = true; assert.strictEqual(tick().pressed.recentre, true); b[10].pressed = false;
  // v6 on the raw layout: RB (5) or B (1) boost, LB (4) limiter, Back (6) compound
  b[5].pressed = true; assert.strictEqual(tick().boost, true); b[5].pressed = false; assert.strictEqual(tick().boost, false);
  b[1].pressed = true; assert.strictEqual(tick().boost, true); b[1].pressed = false; tick();
  b[4].pressed = true; assert.strictEqual(tick().pressed.limiter, true); assert.strictEqual(tick().pressed.limiter, false); b[4].pressed = false; tick();
  b[6].pressed = true; assert.strictEqual(tick().pressed.compound, true); assert.strictEqual(tick().pressed.compound, false); b[6].pressed = false; tick();
  pads[0] = null; tick();
});
ok('unmapped 4-axis pad: treated as standard layout; garbage values are safe', () => {
  const p2 = std('generic'); p2.mapping = ''; p2.axes = [NaN, 0, undefined, Infinity]; p2.buttons[7] = { pressed: false, value: NaN }; p2.buttons[6] = 0.52;
  pads[0] = p2; const s = tick();
  assert.strictEqual(s.steer, 0); assert.strictEqual(s.throttle, 0); near(s.brake, 0.5); assert.strictEqual(s.lookX, 0); assert.strictEqual(s.lookY, 0);
  pads[0] = { index: 0, id: 'bare', connected: true, mapping: 'standard' }; assert.strictEqual(tick().connected, true); assert.strictEqual(G.state.throttle, 0);
  pads[0] = null; tick();
});
ok('getGamepads throwing is handled', () => { global.navigator = { getGamepads: () => { throw new Error('SecurityError'); } }; assert.strictEqual(tick().connected, false); });
console.log('gamepad: ' + T + ' tests passed');
