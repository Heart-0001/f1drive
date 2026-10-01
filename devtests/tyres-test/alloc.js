// node devtests/tyres-test/alloc.js
// tyres.update() must allocate nothing (it runs 120 times a second in the game loop). Measured with V8's own GC trace:
// a child node runs update() 3 million times (after a warm-up, so the code is optimised) with varied loads — corners,
// braking, slides, grass, impacts, a set worn through to a puncture — and counts the garbage collections during the
// measured part. A control run in which every call allocates one small object must show collections (else the
// method would prove nothing).
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const TYRES = path.join(__dirname, '..', '..', 'js', 'tyres.js').replace(/\\/g, '/');

function child(control) {
  return `
    const T = require(${JSON.stringify(TYRES)});
    const ty = T.createTyres({ random: () => 0.9 });
    ty.fit('S'); ty.setWearRate(5);
    const N = 4096, SP = new Float64Array(N), LA = new Float64Array(N), BR = new Float64Array(N), DR = new Float64Array(N),
      SL = new Float64Array(N), HI = new Float64Array(N), GR = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      SP[i] = 20 + 60 * Math.abs(Math.sin(i * 0.01)); LA[i] = Math.sin(i * 0.013); BR[i] = i % 700 < 90 ? 0.8 : 0;
      DR[i] = i % 700 > 200 ? 1 : 0.3; SL[i] = i % 1500 < 120 ? 0.7 : 0; HI[i] = i === 2000 ? 0.6 : 0; GR[i] = i % 2000 < 150 ? 1 : 0;
    }
    const L = { speed: 0.5, lat: 0.5, brake: 0.5, drive: 0.5, slip: 0.5, onGrass: false, hit: 0.5 };
    let keep = null;
    function loop(n) {
      for (let i = 0; i < n; i++) {
        const k = i & (N - 1);
        L.speed = SP[k]; L.lat = LA[k]; L.brake = BR[k]; L.drive = DR[k]; L.slip = SL[k]; L.onGrass = GR[k] === 1; L.hit = HI[k];
        ty.update(0.008333333333333333, L);
        ${control ? 'keep = { a: i };' : ''}
      }
    }
    loop(400000);
    if (ty.state.puncture < 0) throw new Error('the set should be worn through by now');
    ty.fit('M'); ty.setWearRate(5);
    loop(100000);
    console.log('MARK');
    loop(3000000);
    console.log('END ' + ty.state.wear.map(w => w.toFixed(3)).join(' ') + ' puncture ' + ty.state.puncture + (keep ? '' : ''));
  `;
}
function gcCount(control) {
  const out = execFileSync(process.execPath, ['--trace-gc', '-e', child(control)], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const a = out.indexOf('MARK'), b = out.indexOf('END');
  if (a < 0 || b < 0) throw new Error('child output:\n' + out.slice(-2000));
  const mid = out.slice(a, b).split('\n').filter(l => /Scavenge|Mark-Compact|Mark-sweep|Minor/i.test(l));
  return { n: mid.length, end: out.slice(b).split('\n')[0], sample: mid.slice(0, 2) };
}
const real = gcCount(false), ctrl = gcCount(true);
console.log('update() x 3,000,000:', real.n, 'garbage collections', '(' + real.end + ')', real.sample.join(' | '));
console.log('control (one object per call):', ctrl.n, 'garbage collections');
const ok = real.n === 0 && ctrl.n > 0;
console.log(ok ? 'ok: update() allocates nothing' : 'FAIL');
process.exit(ok ? 0 : 1);
