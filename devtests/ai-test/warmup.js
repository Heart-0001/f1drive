// node devtests/ai-test/warmup.js [track=suzuka] [races=1] [sync=1]
// What F1.AI.warmUp buys: think()'s allocation in the FIRST races of a fresh process (15 cars, qualifying + 5 laps,
// wear x3, sim.js) without and with the warm-up (each in its own node process), measured with V8's sampling heap
// profiler (young garbage included; only frames of js/ai.js counted, the contact resolver apart). sync=1 runs node with
// --no-concurrent-recompilation: the simulation runs ~170x faster than real time, so with V8's background compiler the
// waits for a compile job would cover far more think() calls than in the game; a synchronous compile is the closer model.
'use strict';
const path = require('path');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
if (!process.env.WARMUP_CHILD) {
  const { spawnSync } = require('child_process');
  const flags = arg('sync', '1') === '1' ? ['--no-concurrent-recompilation'] : [];
  for (const warm of ['0', '1']) {
    const r = spawnSync(process.execPath, flags.concat([__filename].concat(process.argv.slice(2))), { encoding: 'utf8', env: Object.assign({}, process.env, { WARMUP_CHILD: '1', WARM: warm }) });
    process.stdout.write(r.stdout); if (r.status) { process.stdout.write(r.stderr); process.exit(1); }
  }
  process.exit(0);
}
const inspector = require('inspector');
const session = new inspector.Session(); session.connect();
const post = (m, p) => new Promise((res, rej) => session.post(m, p || {}, (e, r) => e ? rej(e) : res(r)));
const L = require('./lib'), F1 = L.F1;
const { createRace } = require('./sim');
const track = arg('track', 'suzuka'), races = +arg('races', 1), warm = process.env.WARM === '1';
const cars = F1.cars.list(2026).filter(c => !/standard/.test(c.id));
(async () => {
  let head = warm ? 'with F1.AI.warmUp' : 'without warm-up  ';
  if (warm) {
    const t = L.track(L.IDS[track] || track), t0 = Date.now();
    const w = F1.AI.warmUp(t, L.line(t, null));
    head += ' (' + (Date.now() - t0) + ' ms, ' + w.calls + ' think calls, stops ' + w.pitStops + ', R ' + w.resets + ', mistakes ' + w.mistakes + ')';
  }
  console.log(head);
  for (let r = 0; r < races; r++) {
    const spec = [];
    for (let i = 0; i < 15; i++) spec.push({ skill: [0, 0.35, 0.7, 1][(i + r) % 4], car: cars[(i + r) % cars.length].id, name: 'c' + i });
    const sim = createRace({ track, cars: spec, laps: 5, quali: 1, wear: 3, seed: 3 + r, grid: 'quali' });
    let calls = 0; sim.cars.forEach(c => { const f = c.ai.think; c.ai.think = function (a, b, d) { calls++; return f(a, b, d); }; });
    await post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    while (sim.time < 2000 && sim.session.phase !== 'results') sim.step();
    const { profile } = await post('HeapProfiler.stopSampling');
    let think = 0, contacts = 0;
    (function walk(nd, inAi, fn) {
      const cf = nd.callFrame, isAi = /[\\/]js[\\/]ai\.js$/.test(cf.url || ''), name = isAi ? cf.functionName : fn;
      if (nd.selfSize > 0 && (isAi || inAi)) { if (name === 'resolveAll') contacts += nd.selfSize; else think += nd.selfSize; }
      for (const c of nd.children) walk(c, inAi || isAi, name);
    })(profile.head, false, '');
    console.log('  race ' + (r + 1) + ' (' + sim.track.id + ', ' + Math.round(sim.time) + ' s): think() ' + (think / 1048576).toFixed(1) + ' MB = ' +
      (think / calls).toFixed(1) + ' B/call over ' + calls + ' calls; contact resolver ' + (contacts / 1048576).toFixed(1) + ' MB');
  }
})();
