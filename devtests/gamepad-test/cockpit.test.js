const assert = require('assert');
const P = require('path').resolve(__dirname, '..', '..') + '/';
global.window = global; global.THREE = require(P + 'lib/three.min.js');
require(P + 'js/cockpit.js'); const NEWC = global.F1.createCockpit, L = global.F1.COCKPIT_LOOK;
// cockpit.orig.js = js/cockpit.js from before head-look was added (baseline of the "identical when centred" check).
// It is not in the repo; without it the v5 cockpit frozen in devtests/cockpit-test/cockpit-v5.js is the baseline
// (same camera: the v6 cockpit only changed the model around it), and without that too the comparison is skipped.
const fs = require('fs'), ORIG = [__dirname + '/cockpit.orig.js', P + 'devtests/cockpit-test/cockpit-v5.js'].filter(f => fs.existsSync(f))[0];
const HAVE_OLD = !!ORIG;
let OLDC = null; if (HAVE_OLD) { delete global.F1; require(ORIG); OLDC = global.F1.createCockpit; }
const D = 180 / Math.PI, cam = () => new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 4000);
// (v6.2: on a level road - js/cockpit.js now takes part of the roll / pitch out of the head, so only there is the centred view v5's)
const st = { x: 3, y: 1, z: -7, heading: 0.4, speed: 50, steer: 0.2, pitch: 0, roll: 0, onGrass: false, hit: 0 };

assert(Math.abs(L.maxYaw * D - 55) < 1e-9 && Math.abs(L.maxPitchUp * D - 12) < 1e-9 && Math.abs(L.maxPitchDown * D - 10) < 1e-9);
// no look input: camera exactly as before
if (!HAVE_OLD) console.log('SKIP centred view identical to the old cockpit camera (cockpit.orig.js missing)');
else { const a = cam(), b = cam(), ca = OLDC(a), cb = NEWC(b);
  for (let i = 0; i < 120; i++) { st.heading += 0.003; ca.update(st, 1 / 60); cb.update(st, 1 / 60); if (i % 3 === 0) cb.setLook(0, 0);
    ca.group.updateMatrixWorld(true); cb.group.updateMatrixWorld(true);
    for (let k = 0; k < 16; k++) assert(Object.is(a.matrixWorld.elements[k], b.matrixWorld.elements[k]) || a.matrixWorld.elements[k] === b.matrixWorld.elements[k], 'frame ' + i); }
  console.log('ok  centred view identical to the old cockpit camera (120 frames)'); }
// limits, smoothing, signs
{ const c = cam(), ck = NEWC(c); ck.update(st, 0);
  ck.setLook(5, 5); let prev = 0, t63 = null;
  for (let i = 1; i <= 240; i++) { ck.update(st, 1 / 240); const y = c.rotation.y - Math.PI; assert(y >= prev - 1e-12 && y <= L.maxYaw + 1e-9, 'monotonic, no overshoot'); prev = y;
    if (i === 1) assert(y < 0.02 * L.maxYaw, 'does not snap'); if (t63 === null && y > 0.9 * L.maxYaw) t63 = i / 240; }
  assert(t63 > 0.12 && t63 < 0.35, '90% in ' + t63 + ' s');
  assert(Math.abs((c.rotation.y - Math.PI) * D - 55) < 0.05 && Math.abs(c.rotation.x * D - 12) < 0.05);
  // world direction: looking left = towards the driver's left (+X local), and up
  ck.group.updateMatrixWorld(true); const dir = new THREE.Vector3(); c.getWorldDirection(dir);
  const left = new THREE.Vector3(Math.cos(st.heading), 0, -Math.sin(st.heading)); assert(dir.dot(left) > 0.7 && dir.y > 0.1, 'left + up');
  assert(c.position.x > 0.02 && c.position.x < 0.06, 'eye swings towards the look side: ' + c.position.x);
  ck.setLook(-1, -1); for (let i = 0; i < 240; i++) ck.update(st, 1 / 60);
  assert(Math.abs((c.rotation.y - Math.PI) * D + 55) < 1e-3 && Math.abs(c.rotation.x * D + 10) < 1e-3);
  ck.setLook(0, 0); for (let i = 0; i < 240; i++) ck.update(st, 1 / 60);
  assert.strictEqual(c.rotation.y, Math.PI); assert.strictEqual(c.rotation.x, 0);
  ck.setLook(1, 0); for (let i = 0; i < 30; i++) ck.update(st, 1 / 60); ck.centreLook(); ck.update(st, 1 / 60); assert.strictEqual(c.rotation.y, Math.PI);
  ck.setLook(NaN, undefined); ck.update(st, 1 / 60); assert.strictEqual(c.rotation.y, Math.PI);
  ck.setLook(1, 0); ck.update(st, 0.1); ck.update(st, 0); assert(isFinite(c.rotation.y));
  console.log('ok  look limits 55 / +12 / -10 deg, smooth (90% in ' + t63.toFixed(2) + ' s), no overshoot, returns to centre'); }
