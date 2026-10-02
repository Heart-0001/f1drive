// node devtests/ai-test/press.js [runs=24] [track=it-1922] [zone=280-345] [hold=12] [v=1] [trace=run:id1,id2[:from:to s]]
// Pressing a slower car into a braking zone, in the field of devtests/gp-e2e/bots.js part pits: Monza (2026 cars), the
// player's Ferrari on pole (its own computer driver at skill 1, a human for the bots: pace unknown) stalled for `hold`
// s, the 15 computer cars of F1.AI.lineup (2026, mixed, as js/main.js asks for them) behind it in join order. Lap 1
// only, through Monza's first chicane (samples `zone`). Run k shifts every driver's seed by k (reaction at the lights,
// pace noise, wander): the same grid, other lap-1 traffic. Reported: every contact on lap 1 (the chicane's apart), its
// striker (the car behind), what both were doing and whether the striker had been pressing the other car (ai.state.press)
// in the 3 s before. The Electron run of the same field: bots.js part pits (contacts in its CONTACTS line when
// instrumented). Exit 1 when a chicane contact is over 0.12.
'use strict';
const { createScenario, arg, F1 } = require('./critic-sim');
const runs = +arg('runs', 24), tr = arg('track', 'it-1922'), hold = +arg('hold', 12), verbose = arg('v', '0') === '1';
const zone = arg('zone', '280-345').split('-').map(Number), year = 2026;
const traceArg = arg('trace', ''), traceRun = traceArg ? +traceArg.split(':')[0] : -1, traceIds = traceArg ? traceArg.split(':')[1].split(',').map(Number) : [];
const traceFrom = traceArg && traceArg.split(':')[2] ? +traceArg.split(':')[2] : 0, traceTo = traceArg && traceArg.split(':')[3] ? +traceArg.split(':')[3] : 45;

const line = F1.AI.lineup({ cars: F1.cars.list(year), taken: ['2026-ferrari'], count: 15, skill: 'mixed', seed: year,
  drivers: typeof F1.cars.drivers === 'function' ? F1.cars.drivers : null, names: ['Player'] });
if (verbose) line.forEach((e, i) => console.log('  #' + (i + 2) + ' ' + e.name.padEnd(18) + e.car.padEnd(22) + ' skill ' + e.skill));

const tot = { runs: 0, lap1: 0, zone: 0, zoneMax: 0, zoneOver: 0, pressHits: 0, max: 0, heavy: 0, wall: 0 };
const t0 = Date.now();
for (let k = 0; k < runs; k++) {
  const cars = [{ kind: 'human', skill: 1, car: '2026-ferrari', name: 'player', seed: 4242 + k, slot: 0, holdS: hold }]
    .concat(line.map((e, i) => ({ kind: 'ai', skill: e.skill, car: e.car, name: e.name.split(' ').pop(), seed: e.seed + k, slot: i + 1 })));
  // the last time each car pressed another one, and which
  const pressAt = new Map(), pressWho = new Map();
  let sc;
  const opts = { track: tr, cars, laps: 3, seed: 1, start: 'grid', lockS: 2, maxS: 2 + 45,
    until: api => {
      for (const c of api.cars) if (c.ai && c.ai.state.press >= 0) { pressAt.set(c.id, api.time); pressWho.set(c.id, c.ai.state.press); }
      return false;
    } };
  if (k === traceRun) opts.trace = { ids: traceIds, from: 2 + traceFrom, to: 2 + traceTo };
  sc = createScenario(opts);
  const rep = sc.run();
  tot.runs++;
  const rows = [];
  for (const c of rep.contacts) {
    const inZone = c.idx >= zone[0] && c.idx <= zone[1];
    const strikerId = c.striker ? sc.cars.find(x => x.name === c.striker).id : -1;
    const victimId = c.striker ? (c.ids[0] === strikerId ? c.ids[1] : c.ids[0]) : -1;
    const pressed = strikerId > 0 && pressWho.get(strikerId) === victimId && c.t - (pressAt.get(strikerId) || -1e9) < 3;
    tot.lap1++; tot.max = Math.max(tot.max, c.h); if (c.h > 0.25) tot.heavy++;
    if (inZone) { tot.zone++; tot.zoneMax = Math.max(tot.zoneMax, c.h); if (c.h > 0.12) tot.zoneOver++; }
    if (pressed) tot.pressHits++;
    rows.push('    ' + (c.t - 2).toFixed(2) + ' s  ' + c.a + ' (#' + c.ids[0] + ') x ' + c.b + ' (#' + c.ids[1] + ')  h ' + c.h.toFixed(2) + ' ' + c.kind + ' @' + c.idx +
      (inZone ? ' CHICANE' : '') + '  striker ' + (c.striker || '-') + (pressed ? ' (PRESSING it ' + (c.t - pressAt.get(strikerId)).toFixed(2) + ' s ago)' : '') +
      '  gap ' + c.gap + ' closing ' + c.closing + '  [' + c.modes + ']');
  }
  const zh = rep.contacts.filter(c => c.idx >= zone[0] && c.idx <= zone[1]).reduce((m, c) => Math.max(m, c.h), 0);
  console.log(('run ' + k).padEnd(7) + ' contacts ' + String(rep.contacts.length).padStart(2) + '  chicane max ' + zh.toFixed(2) + (zh > 0.12 ? '  <-- over 0.12' : ''));
  if (verbose || zh > 0.12) rows.forEach(r => console.log(r));
  if (k === traceRun) sc.traceRows.forEach(r => console.log('  ' + r));
}
console.log('\n' + tot.runs + ' runs (lap 1, ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s): contacts ' + tot.lap1 + ' (heavy ' + tot.heavy + ', max ' + tot.max.toFixed(2) + '), at the chicane ' + tot.zone +
  ' (max ' + tot.zoneMax.toFixed(2) + ', over 0.12: ' + tot.zoneOver + '), the striker pressing the car it hit: ' + tot.pressHits);
process.exit(tot.zoneOver ? 1 : 0);
