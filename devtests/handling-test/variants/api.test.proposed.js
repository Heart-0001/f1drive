// js/cockpit.js + js/carmodel.js in node (no WebGL): the API of the contract, what setCar builds / redraws / disposes,
// the camera against the v5 cockpit (cockpit-v5.js), the wheel display's redraw budget, tyre wear and vibration, the
// display's lap delta with the real lap counter (js/laps.js) across tracks and lap.reset(), the live mirrors (glass
// texture coordinates, rear-view cameras, the extra pass recorded by a stub renderer, setMirrors), and the remote car
// against the v5 carmodel (carmodel-v5.js): setColour, and its halo along the cockpit's (F1.COCKPIT_HALO), setHalo.
// A stub canvas (every 2d call is a no-op; fillText records the text) lets the texture code run.
//   node devtests/cockpit-test/api.test.js          exit code 1 on a failure
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
let fails = 0;
function check(name, ok, detail) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); if (!ok) fails++; }

// ---- stub DOM canvas ----
let ctxCalls = 0, texts = [];
function stubCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, { get(t, k) {
    if (k in t) return t[k];
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'fillText') return function (s) { ctxCalls++; texts.push(String(s)); };
    return function () { ctxCalls++; };
  }, set(t, k, v) { t[k] = v; return true; } });
}
global.window = global;
global.document = { createElement: () => { const c = { width: 0, height: 0, _ctx: null, getContext() { return this._ctx || (this._ctx = stubCtx()); } }; return c; } };
global.THREE = require(ROOT + '/lib/three.min.js');
const THREE = global.THREE;

// the v5 files (frozen copies next to this test: js/cockpit.js and js/carmodel.js as they were before v6)
const oldCockpitFile = path.join(__dirname, 'cockpit-v5.js'), oldCarFile = path.join(__dirname, 'carmodel-v5.js');
let OLD = null;
if (fs.existsSync(oldCockpitFile) && fs.existsSync(oldCarFile)) {
  global.F1 = {};
  require(oldCockpitFile); require(oldCarFile);
  OLD = { createCockpit: global.F1.createCockpit, createCarModel: global.F1.createCarModel };
}
global.F1 = {};
require(ROOT + '/js/cockpit.js'); require(ROOT + '/js/carmodel.js'); require(ROOT + '/js/laps.js');
const F1 = global.F1;

// ---- API ----
const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000);
const ck = F1.createCockpit(cam);
check('createCockpit returns group, update, setLook, centreLook, setCar (+ setSources, info, dispose)',
  ck.group && ck.group.isGroup && ['update', 'setLook', 'centreLook', 'setCar', 'setSources', 'info', 'dispose'].every(k => typeof ck[k] === 'function'));
check('F1.COCKPIT_LOOK unchanged (55 / 12 / 10 deg)', Math.abs(F1.COCKPIT_LOOK.maxYaw * 180 / Math.PI - 55) < 1e-9 && Math.abs(F1.COCKPIT_LOOK.maxPitchUp * 180 / Math.PI - 12) < 1e-9);
check('camera is a child of the group, near <= 0.06', cam.parent === ck.group && cam.near <= 0.06);
let inf = ck.info();
check('default before setCar: halo18, 18-inch rims, big-display wheel, default colour', inf.style === 'halo18' && inf.rim === 18 && inf.wheel === 'big' && inf.livery.colour === '#ff7a14', inf);
check('draw calls <= 24, triangles < 40k', inf.drawCalls <= 24 && inf.triangles < 40000, { draws: inf.drawCalls, tris: inf.triangles });

// ---- styles ----
function geos() { const s = new Set(); ck.group.traverse(o => { if (o.isMesh) s.add(o.geometry); }); return s; }
let disposed = 0;
const origDispose = THREE.BufferGeometry.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function () { disposed++; return origDispose.call(this); };
const rows = [];
for (const [spec, want] of [
  [{ cockpit: 'modern', year: 2011 }, { style: 'modern', rim: 13, wheel: 'classic', halo: false, tyreWidth: 0.25 }],
  [{ cockpit: 'modern', year: 2012 }, { style: 'modern', rim: 13, wheel: 'classic', halo: false }],
  [{ cockpit: 'modern', year: 2016 }, { style: 'modern', rim: 13, wheel: 'big', halo: false, tyreWidth: 0.25 }],
  [{ cockpit: 'modern', year: 2017 }, { style: 'modern', rim: 13, wheel: 'big', halo: false, tyreWidth: 0.305 }],
  [{ cockpit: 'halo', year: 2019 }, { style: 'halo', rim: 13, wheel: 'big', halo: true }],
  [{ cockpit: 'halo18', year: 2024 }, { style: 'halo18', rim: 18, wheel: 'big', halo: true }],
  [{ year: 2015 }, { style: 'modern' }], [{ year: 2020 }, { style: 'halo' }], [{ year: 2026 }, { style: 'halo18' }],
  [{ cockpit: 'bogus' }, { style: 'halo18' }], [null, { style: 'halo18' }]
]) {
  const before = geos(); disposed = 0;
  ck.setCar(spec, '#00ff88');
  const i = ck.info(), after = geos();
  const ok = Object.keys(want).every(k => i[k] === want[k]);
  let kept = 0; before.forEach(g => { if (after.has(g)) kept++; });
  rows.push({ spec: JSON.stringify(spec), style: i.style, year: i.year, wheel: i.wheel, rim: i.rim, halo: i.halo, tris: i.triangles, draws: i.drawCalls, disposed, kept });
  check('setCar ' + JSON.stringify(spec) + ' -> ' + JSON.stringify(want), ok, ok ? undefined : i);
}
console.table(rows);
// same style again, colours only: no rebuild, livery redrawn
ck.setCar({ cockpit: 'halo', year: 2019, colour: '#123456' }, '#ff0000');
let g0 = geos(); disposed = 0; ctxCalls = 0;
ck.setCar({ cockpit: 'halo', year: 2020, colour: '#654321', colour2: '#eeeeee', number: 44 }, '#00ff00');
let g1 = geos(), same = [...g0].every(g => g1.has(g));
check('colour change in the same style: no geometry rebuilt / disposed, livery redrawn', same && disposed === 0 && ctxCalls > 50, { disposed, ctxCalls });
inf = ck.info();
check('livery values taken (colour, colour2, accent, number)', inf.livery.colour === '#654321' && inf.livery.colour2 === '#eeeeee' && inf.livery.accent === '#00ff00' && inf.livery.number === '44', inf.livery);
ck.setCar({ cockpit: 'halo', year: 2020, colour: 'red', colour2: 12, number: 'x' }, 'nope');
inf = ck.info();
check('bad colours / number fall back to defaults', /^#[0-9a-f]{6}$/.test(inf.livery.colour) && /^#[0-9a-f]{6}$/.test(inf.livery.colour2) && /^\d+$/.test(inf.livery.number), inf.livery);
g0 = geos(); disposed = 0;
ck.setCar({ cockpit: 'modern', year: 2013 }, null);
g1 = geos();
let replaced = 0; g0.forEach(g => { if (!g1.has(g)) replaced++; });
check('style change disposes every geometry it replaces', replaced > 0 && disposed >= replaced, { replaced, disposed });

// ---- update: finite, display redraw budget, tyres, vibration ----
ck.setCar({ cockpit: 'halo18', year: 2025, gearKmh: [80, 120, 160, 200, 240, 280, 310], rpmShift: 12000 }, '#19c8e6');
const st = { x: 3, y: 1, z: -7, heading: 0.4, speed: 0, steer: 0, pitch: 0.02, roll: -0.03, onGrass: false, hit: 0, sampleIndex: 0 };
let d0 = ck.info().displayDraws, t = 0;
for (let i = 0; i < 1200; i++) {                      // 20 s at 60 fps: accelerate through the gears
  st.speed = Math.min(90, i * 0.1); st.steer = Math.sin(i / 40); t += 1 / 60;
  ck.update(st, 1 / 60);
  if (![cam.position.x, cam.position.y, cam.position.z, cam.rotation.x, cam.rotation.y, cam.fov].every(Number.isFinite)) { check('finite camera', false, i); break; }
}
let draws = ck.info().displayDraws - d0;
check('display redrawn at most 15 times a second (derived gear / rpm while accelerating)', draws > 20 && draws <= 15 * t + 1, { draws, seconds: t });
d0 = ck.info().displayDraws;
for (let i = 0; i < 300; i++) ck.update(st, 1 / 60);   // steady state: nothing changes -> no redraws
check('no redraw while nothing on the display changes', ck.info().displayDraws - d0 === 0, ck.info().displayDraws - d0);
// v6 state fields, garbage included
const garbage = [NaN, undefined, null, -5, 1e9, 'x', {}, 0.5];
for (let i = 0; i < 400; i++) {
  const s = Object.assign({}, st, { gear: garbage[i % 8], rpm: garbage[(i + 1) % 8], battery: garbage[(i + 2) % 8], deploy: garbage[(i + 3) % 8], harvest: garbage[(i + 4) % 8],
    limiter: i % 3 === 0, vib: garbage[(i + 5) % 8], tyres: i % 5 ? { compound: ['S', 'M', 'H', 'Q'][i % 4], wear: [garbage[i % 8], 0.5, 1, 0] } : garbage[i % 8], lapTime: garbage[(i + 6) % 8] });
  ck.update(s, i % 7 ? 1 / 60 : garbage[i % 8]);
}
check('garbage v6 fields and dt: camera stays finite', [cam.position.x, cam.position.y, cam.rotation.x, cam.rotation.z, cam.fov].every(Number.isFinite));
// tyre wear darkens the tread of that wheel
ck.update(Object.assign({}, st, { tyres: { state: { compound: 'S', wear: [0.9, 0.0, 0, 0] } } }), 1 / 60);
const tyres = []; ck.group.traverse(o => { if (o.isMesh && o.name === 'tyre') tyres.push(o); });
function treadLum(m) { const uv = m.geometry.attributes.uv, c = m.geometry.attributes.color; let s = 0, n = 0; for (let i = 0; i < uv.count; i++) if (uv.getY(i) > 0.46 && uv.getY(i) < 0.54) { s += c.getX(i); n++; } return s / n; }
check('car.tyres-style source: worn front-left tread darker than the new front-right', tyres.length === 2 && treadLum(tyres[0]) < 0.6 && treadLum(tyres[1]) > 0.99, tyres.map(treadLum));
ck.setSources({ car: { tyres: { state: { compound: 'H', wear: [0.0, 0.5, 0, 0] } }, spec: { rpmShift: 12000, ers: null } }, lap: null });
ck.update(st, 1 / 60);
check('setSources({car}) is read: wear of the front-right now', treadLum(tyres[1]) < 0.8 && treadLum(tyres[0]) > 0.99, tyres.map(treadLum));
ck.setSources(null);
// vibration shakes the eye, deterministic and bounded
function eyeTrace(vib) {
  const c2 = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000), k = F1.createCockpit(c2), out = [];
  const s = Object.assign({}, st, { speed: 30, steer: 0, vib });
  for (let i = 0; i < 120; i++) { k.update(s, 1 / 60); out.push(c2.position.y); }
  k.dispose(); return out;
}
const e0 = eyeTrace(0), e1 = eyeTrace(1);
const dev = Math.max(...e1.map((v, i) => Math.abs(v - e0[i])));
check('state.vib = 1 shakes the eye (a few mm), vib = 0 does not', dev > 0.002 && dev < 0.02, { maxDeviation: +dev.toFixed(4) });

// ---- the wheel display's lap delta with the REAL lap counter (js/laps.js), as main.js uses it: one counter per
// track, setSources({car, lap}) after each new counter (review-1 finding cockpit-delta-never-on-slower-track) ----
{
  const dk = F1.createCockpit(new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000)), DT = 1 / 60;
  // laps of lapTime s round a track of n samples, placed 10 samples behind the line; -> labels seen per completed lap
  const drive = (lap, n, lapTime, laps, from) => {
    const perLap = Math.round(lapTime / DT), speed = n / perLap, out = [];
    let pos = from, seen = new Set();
    const total = Math.round((laps + 0.02) * perLap) + Math.round(((n - from) % n) / n * perLap);
    for (let f = 0; f < total; f++) {
      pos += speed; const idx = Math.floor(pos) % n;
      const r = lap.update(idx, 50, DT);
      texts = [];
      dk.update({ x: 0, y: 0, z: 0, heading: 0, speed: 50, steer: 0, sampleIndex: idx, hit: 0 }, DT);
      texts.forEach(s => { if (s === 'LAP' || s === 'DELTA') seen.add(s); });
      if (r === 2) { out.push([...seen].sort().join('+')); seen = new Set(); }
    }
    out.push([...seen].sort().join('+'));
    return out;
  };
  const track = (n, lapTime, laps) => { const lap = F1.createLapCounter(n, n - 10); dk.setSources({ car: null, lap }); return drive(lap, n, lapTime, laps, n - 10); };
  const A = track(600, 80, 3), B = track(700, 100, 4), C = track(500, 60, 3);
  check('lap delta: shown from the 2nd lap on a track (80 s laps)', A[0] === 'LAP' && A.slice(1).every(s => s.indexOf('DELTA') >= 0), A);
  check('lap delta: ALSO shown on the next track although its laps are slower (100 s) than the last track\'s best', B[0] === 'LAP' && B.slice(1).every(s => s.indexOf('DELTA') >= 0), B);
  check('lap delta: and on a faster track after that (60 s)', C[0] === 'LAP' && C.slice(1).every(s => s.indexOf('DELTA') >= 0), C);
  // lap.reset() (qualifying start) on the same counter: that best lap is gone, the first lap after it shows LAP only
  const lap = F1.createLapCounter(600, 590); dk.setSources({ car: null, lap });
  const D = drive(lap, 600, 80, 2, 590);
  lap.reset(590);
  const E = drive(lap, 600, 90, 2, 590);
  check('lap delta: after lap.reset() the old reference is dropped (LAP on the first lap), then DELTA against the new best',
    D.slice(1).every(s => s.indexOf('DELTA') >= 0) && E[0] === 'LAP' && E.slice(1).every(s => s.indexOf('DELTA') >= 0), { before: D, after: E });
  dk.dispose();
}

// ---- live mirrors: glass texture coordinates, rear-view cameras, the extra pass (a stub renderer records it) ----
{
  const mc = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000), mk = F1.createCockpit(mc);
  let glass = null, cams = [];
  mk.group.traverse(o => { if (o.isMesh && o.name === 'mirror') glass = o; if (o.isCamera && o.name === 'mirror-camera') cams.push(o); });
  const mi = mk.info().mirrors;
  check('mirrors: live by default, setMirrors in the API, 2 rear-view cameras', typeof mk.setMirrors === 'function' && mi.live === true && cams.length === 2 && glass && glass.material.isMeshBasicMaterial && glass.material.map && glass.material.map.name === 'mirror-view', mi);
  for (const style of ['modern', 'halo', 'halo18']) {
    mk.setCar({ cockpit: style }, null);
    const p = glass.geometry.attributes.position, u = glass.geometry.attributes.uv;
    // per glass (x > 0: the left one): u range, and u rising with x (the driver's left = the rear camera's right)
    const side = s => { let lo = 1, hi = 0, sxu = 0, sx = 0, su = 0, n = 0; for (let i = 0; i < p.count; i++) { if (Math.sign(p.getX(i)) !== s) continue; const x = p.getX(i), uu = u.getX(i); lo = Math.min(lo, uu); hi = Math.max(hi, uu); sx += x; su += uu; sxu += x * uu; n++; } return { lo, hi, cov: sxu / n - (sx / n) * (su / n) }; };
    const L = side(1), R = side(-1);
    const dirs = cams.map(c => { const d = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion); return d; });
    check('mirrors ' + style + ': left glass samples u 0..0.5, right glass 0.5..1, both flipped (u rises towards the car\'s left)',
      L.lo >= 0 && L.hi <= 0.5 && R.lo >= 0.5 && R.hi <= 1 && L.hi - L.lo > 0.45 && R.hi - R.lo > 0.45 && L.cov > 0 && R.cov > 0, { L, R });
    check('mirrors ' + style + ': cameras at the glasses (left +x, right -x), looking back', cams[0].position.x > 0.5 && cams[1].position.x < -0.5 &&
      dirs.every(d => d.z < -0.98) && cams.every(c => Math.abs(c.fov * c.aspect) > 30), dirs.map(d => d.toArray().map(v => +v.toFixed(3))));
  }
  // a scene like the game's: our cockpit, a remote car (name tag), the scenery with its trees
  const scene = new THREE.Scene(), rc = F1.createCarModel('#3366ff', 'B');
  const scen = new THREE.Group(); scen.name = 'scenery';
  const solid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); solid.name = 'scenery-solid';
  const trees = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); trees.name = 'scenery-trees-broadleaf';
  scen.add(solid, trees); scene.add(mk.group, rc.group, scen);
  let tag = null; rc.group.traverse(o => { if (o.isSprite) tag = o; });
  mk.update({ x: 5, y: 0, z: 5, heading: 0.3, speed: 0, steer: 0 }, 1 / 60);
  scene.updateMatrixWorld(true);
  const log = [];
  const stub = { rt: null, info: { autoReset: true },
    getRenderTarget() { return this.rt; }, setRenderTarget(t) { this.rt = t; },
    render(s, c) {
      log.push({ cam: c, rt: this.rt, vp: this.rt && this.rt.viewport.toArray(), autoReset: this.info.autoReset, glass: glass.visible, tag: tag.visible,
                 trees: trees.visible, solid: solid.visible, scen: scen.visible, remote: rc.group.visible });
      glass.onBeforeRender(this, s, mc);            // a nested call must not start another pass
    } };
  const fire = () => glass.onBeforeRender(stub, scene, mc, glass.geometry, glass.material, null);
  fire();
  check('mirror pass: the first frame draws both glasses (left half, then the right one), into the target, with the camera of each',
    log.length === 2 && log[0].rt && log[0].vp[0] === 0 && log[1].vp[0] === 256 && log[0].vp[2] === 256 && log[0].cam === cams[0] && log[1].cam === cams[1] && stub.rt === null, log.map(l => l.vp));
  check('mirror pass: without the glass, the name tags and the trees; with the other cars and the rest of the scenery; statistics kept',
    log.every(l => !l.glass && !l.tag && !l.trees && l.solid && l.scen && l.remote && l.autoReset === false), log.map(l => ({ glass: l.glass, tag: l.tag, trees: l.trees, solid: l.solid })));
  check('mirror pass: everything visible again afterwards, autoReset restored', glass.visible && tag.visible && trees.visible && solid.visible && stub.info.autoReset === true);
  log.length = 0; for (let i = 0; i < 6; i++) fire();
  check('mirror pass: then one glass per frame, alternating', log.length === 6 && log.every((l, i) => !i || l.vp[0] !== log[i - 1].vp[0]), log.map(l => l.vp[0]));
  // head turned: the camera sees only the left glass -> only that one is redrawn
  mk.setLook(1, 0); for (let i = 0; i < 60; i++) mk.update({ x: 5, y: 0, z: 5, heading: 0.3, speed: 0, steer: 0 }, 1 / 60);
  scene.updateMatrixWorld(true);
  log.length = 0; for (let i = 0; i < 4; i++) fire();
  check('mirror pass: looking left (55 deg) only the left glass is on screen and redrawn', log.length === 4 && log.every(l => l.vp[0] === 0), log.map(l => l.vp[0]));
  mk.centreLook();
  const other = { viewport: new THREE.Vector4() }; stub.rt = other; log.length = 0; fire();
  check('mirror pass: during an off-screen render too, that render target bound again afterwards', log.length === 1 && log[0].rt !== other && stub.rt === other);
  stub.rt = null; log.length = 0;
  check('setMirrors(false): environment-mapped glass, no pass; setMirrors(true): live again', mk.setMirrors(false) === false && glass.material.isMeshStandardMaterial && glass.material.envMap &&
    (fire(), log.length === 0) && mk.info().mirrors.live === false && mk.setMirrors(true) === true && glass.material.map && glass.material.map.name === 'mirror-view' && (fire(), log.length === 2));
  const passes = mk.info().mirrors.passes;
  check('info().mirrors counts the passes', passes === 2 + 6 + 4 + 1 + 2, passes);
  mk.dispose(); rc.dispose();
}

// ---- the camera exactly as the v5 cockpit's (no vib) ----
if (!OLD) console.log('SKIP camera / carmodel against v5 (cockpit-v5.js / carmodel-v5.js missing)');
else {
  const ca = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000), cb = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000);
  const oa = OLD.createCockpit(ca), nb = F1.createCockpit(cb);
  let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, realRandom = Math.random;
  let maxd = 0;
  const s = { x: 3, y: 1, z: -7, heading: 0.4, speed: 0, steer: 0, pitch: 0.02, roll: 0, onGrass: false, hit: 0 };   // (level: v6.2 cues off)
  for (let i = 0; i < 600; i++) {
    s.speed = 60 * Math.sin(i / 100) ** 2; s.heading += 0.004 * Math.sin(i / 30); s.steer = Math.sin(i / 25); s.hit = i % 97 === 0 ? 0.8 : 0; s.onGrass = i > 300 && i < 360;
    const look = i > 400 ? [Math.sin(i / 20), Math.cos(i / 33)] : [0, 0];
    oa.setLook(look[0], look[1]); nb.setLook(look[0], look[1]);
    seed = i + 1; Math.random = rnd; oa.update(s, 1 / 60);
    seed = i + 1; nb.update(s, 1 / 60); Math.random = realRandom;
    oa.group.updateMatrixWorld(true); nb.group.updateMatrixWorld(true);
    for (let k = 0; k < 16; k++) maxd = Math.max(maxd, Math.abs(ca.matrixWorld.elements[k] - cb.matrixWorld.elements[k]));
    maxd = Math.max(maxd, Math.abs(ca.fov - cb.fov));
  }
  Math.random = realRandom;
  check('camera (pose, FOV, shake, look) identical to the v5 cockpit over 600 frames', maxd === 0, { maxDiff: maxd });

  // v6.2 road-shape cues: on a 19 deg bank the view tilts by 55 % of the roll (the head keeps 45 % out, about the car's
  // forward axis also while looking aside), and the eye sinks 1.2 cm per g of compression
  {
    const cc = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000), nc = F1.createCockpit(cc);
    const st = { x: 0, y: 0, z: 0, heading: 0, speed: 50, steer: 0, pitch: 0, roll: -0.33, compress: 1.5, onGrass: false, hit: 0 };
    for (let i = 0; i < 240; i++) nc.update(st, 1 / 60);
    nc.group.updateMatrixWorld(true);
    const e = cc.matrixWorld.elements, tilt = Math.atan2(Math.hypot(e[4], e[6]), e[5]);
    check('road-shape cues: the view tilts 55 % of a 19 deg bank, the eye sinks 1.8 cm at 1.5 g of compression',
      Math.abs(tilt - 0.55 * 0.33) < 0.005 && Math.abs(cc.position.y - (0.80 - 0.018)) < 0.002, { tilt: tilt, eyeY: cc.position.y });
    nc.setLook(1, 0);
    for (let i = 0; i < 240; i++) nc.update(st, 1 / 60);
    nc.group.updateMatrixWorld(true);
    const f = cc.matrixWorld.elements, tilt2 = Math.atan2(Math.hypot(f[4], f[6]), f[5]);
    check('road-shape cues: looking aside, the counter-roll stays about the car\'s forward axis (the view tilts no more)',
      Math.abs(tilt2 - 0.55 * 0.33) < 0.01, { tilt: tilt2 });
    nc.dispose();
  }

  // ---- remote car: setColour exactly as before, setLivery slots ----
  const a = OLD.createCarModel('#3366ff', 'A'), b = F1.createCarModel('#3366ff', 'A');
  const ga = a.group.children[0].geometry, gb = b.group.children[0].geometry;
  const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  // the halo follows the cockpit's hoop now (review-1 finding cockpit-vs-carmodel-halo-height): same vertices and colours
  // as v5 except the halo's 9 tubes (30 vertices each), which lie along the cockpit's halo line
  const pa = ga.attributes.position.array, pb = gb.attributes.position.array, moved = [];
  for (let i = 0; i < pa.length; i += 3) if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) moved.push(i / 3);
  check('remote car: same vertex count and colours as v5, only the halo (270 vertices in one run) moved', pa.length === pb.length && eq(ga.attributes.color.array, gb.attributes.color.array) &&
    moved.length === 270 && moved[269] - moved[0] === 269, { vertices: pb.length / 3, moved: moved.length });
  const H = F1.COCKPIT_HALO, hc = [];
  H.hoop.forEach(p => hc.push(new THREE.Vector3(p[0], p[1], p[2]))); hc.push(new THREE.Vector3(H.apex[0], H.apex[1], H.apex[2]));
  H.hoop.slice().reverse().forEach(p => hc.push(new THREE.Vector3(-p[0], p[1], p[2])));
  const line = new THREE.CatmullRomCurve3(hc, false, 'catmullrom', 0.5).getSpacedPoints(600);
  const pil = new THREE.Line3(new THREE.Vector3(H.pillar[0], H.pillar[1], H.pillar[2]), new THREE.Vector3(0, 0.58, 0.95)), tmp = new THREE.Vector3();
  let far = 0, top = 0;
  moved.forEach(v => {
    const q = new THREE.Vector3(pb[v * 3], pb[v * 3 + 1], pb[v * 3 + 2]);
    let d = pil.closestPointToPoint(q, true, tmp).distanceTo(q);
    line.forEach(c => { d = Math.min(d, c.distanceTo(q)); });
    far = Math.max(far, d); top = Math.max(top, q.y);
  });
  check('remote car: halo along the cockpit\'s halo line (tube radius 3 cm + 4.2 cm straight-tube error) and as high (1.33 m)', far < 0.075 && Math.abs(top - 1.345) < 0.03,
    { maxDistance: +far.toFixed(3), top: +top.toFixed(3), cockpitTop: H.apex[1] });
  // js/carmodel.js alone (no js/cockpit.js): its own copy of the line gives the same halo
  const saved = global.F1, file = require.resolve(ROOT + '/js/carmodel.js');
  global.F1 = {}; delete require.cache[file]; require(file);
  const alone = global.F1.createCarModel('#3366ff', 'A'); global.F1 = saved;
  check('remote car: js/carmodel.js without js/cockpit.js builds the same halo (its copy of the line = F1.COCKPIT_HALO)', eq(alone.group.children[0].geometry.attributes.position.array, pb));
  alone.dispose();
  // setHalo(false): the halo's triangles collapse (a car of before 2018), true: back exactly
  const before = Array.from(pb), ver0 = gb.attributes.position.version;
  b.setHalo(false);
  const ver1 = gb.attributes.position.version;
  const collapsed = moved.every(v => pb[v * 3] === pb[moved[0] * 3] && pb[v * 3 + 1] === pb[moved[0] * 3 + 1] && pb[v * 3 + 2] === pb[moved[0] * 3 + 2]);
  const rest = before.every((x, i) => moved.indexOf(Math.floor(i / 3)) >= 0 || pb[i] === x);
  b.setHalo(true);
  check('remote car: setHalo(false) collapses only the halo, setHalo(true) restores it (uploaded again both times)', collapsed && rest && eq(pb, before) &&
    ver1 > ver0 && gb.attributes.position.version > ver1);
  a.setColour('#ff0000'); b.setColour('#ff0000');
  check('remote car: setColour identical to v5', eq(ga.attributes.color.array, gb.attributes.color.array));
  let meshesA = 0, meshesB = 0; a.group.traverse(o => { if (o.isMesh || o.isSprite) meshesA++; }); b.group.traverse(o => { if (o.isMesh || o.isSprite) meshesB++; });
  check('remote car: same number of draw calls', meshesA === meshesB, [meshesA, meshesB]);
  b.setLivery('#ff0000', '#00ff00', '#0000ff');
  const col = gb.attributes.color.array, cnt = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < col.length; i += 3) { if (col[i] === 1 && col[i + 1] === 0 && col[i + 2] === 0) cnt.r++; if (col[i] === 0 && col[i + 1] === 1 && col[i + 2] === 0) cnt.g++; if (col[i] === 0 && col[i + 1] === 0 && col[i + 2] === 1) cnt.b++; }
  check('remote car: setLivery paints body / secondary / accent vertices', cnt.r > 200 && cnt.g > 100 && cnt.b > 20, cnt);
  b.setColour('#ff0000');
  check('remote car: setColour after setLivery = the one-colour car again', eq(ga.attributes.color.array, gb.attributes.color.array));
  a.dispose(); b.dispose();
}
ck.dispose();
THREE.BufferGeometry.prototype.dispose = origDispose;
console.log(fails ? 'FAILURES: ' + fails : 'ALL PASS');
process.exit(fails ? 1 : 0);
