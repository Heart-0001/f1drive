// node devtests/ai-test/critic-start.js [tracks=baku,jeddah,...] [seeds=3] [n=15] [laps=2] [skill=mixed|0..1] [v=1]
// The critic's stress case 1: n computer cars from a standing start on the painted grid (random order, mixed levels,
// the season's cars) into a tight first corner, laps laps. Reported per race: contacts (lap 1 / later), heavy ones
// (> 0.25), the computer cars that ran into the back of another, pile-ups (3+ cars within 3 s / 60 m), R, stuck cars,
// offs, wall hits, and how long the field took to clear lap 1. Exit 1 on a pile-up, a stuck car, an R or an AI
// rear-end harder than 0.3.
'use strict';
const { createScenario, summarize, fmtSum, field, arg, F1 } = require('./critic-sim');
const TR = arg('tracks', 'baku,jeddah,hungaroring,interlagos,austria,vegas,mx-1962,monaco,cota,it-1953,nl-1948,au-1953').split(',');
const seeds = +arg('seeds', 3), n = +arg('n', 15), laps = +arg('laps', 2), verbose = arg('v', '0') === '1';
const skill = arg('skill', 'mixed');
let bad = 0;
const tot = { races: 0, contacts: 0, lap1: 0, heavy: 0, aiRear: 0, aiRearHeavy: 0, max: 0, pile: 0, R: 0, stuck: 0, offs: 0, walls: 0, lapsDone: 0 };
const t0 = Date.now();
for (const tr of TR) {
  for (let s = 1; s <= seeds; s++) {
    const cars = field(n, { seed: s * 11 + tr.length, year: 2025 + (s % 2), skill: skill === 'mixed' ? null : skill });
    const rnd = F1.AI.makeRandom(s * 7 + 3), order = cars.map((c, i) => i + 1);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const sc = createScenario({ track: tr, cars, laps, seed: s, start: 'grid', gridOrder: order });
    const rep = sc.run(), sm = summarize(rep);
    const lead = rep.cars.reduce((m, c) => Math.min(m, c.lapTimes[0] || 1e9), 1e9) + 2;
    const lap1 = rep.contacts.filter(k => k.t < lead);
    const firstLapClear = Math.max(...rep.cars.map(c => c.lapTimes[0] || 0)) + 2;
    tot.races++; tot.contacts += sm.contacts; tot.lap1 += lap1.length; tot.heavy += sm.heavy; tot.aiRear += sm.aiRear; tot.aiRearHeavy += sm.aiRearHeavy;
    tot.max = Math.max(tot.max, sm.maxH); tot.pile += sm.pileups; tot.R += sm.resets; tot.stuck += sm.stuck; tot.offs += sm.offs; tot.walls += sm.walls;
    tot.lapsDone += rep.cars.reduce((a, c) => a + c.laps, 0);
    const fail = sm.pileups > 0 || sm.stuck > 0 || sm.resets > 0 || sm.aiRearMax > 0.3 || !sm.finished;
    if (fail) bad++;
    console.log((sc.track.id + ' s' + s).padEnd(14) + ' lap1 ' + String(lap1.length).padStart(2) + ' | ' + fmtSum(sm) + ' | lap 1 cleared in ' + firstLapClear.toFixed(1) + ' s' + (fail ? '  <-- FAIL' : ''));
    if (verbose || fail) {
      for (const k of rep.contacts.slice(0, 14)) console.log('    ' + k.t.toFixed(2) + ' ' + k.a + ' x ' + k.b + ' ' + k.kind + ' h ' + k.h + ' gap ' + k.gap + ' closing ' + k.closing + ' @' + k.idx + ' striker ' + k.striker + ' [' + k.modes + ']');
      for (const c of rep.cars) if (c.resets || c.stuck || c.maxStuck > 6) console.log('    ' + c.name + ' R ' + c.resets + ' stuck ' + c.stuck + ' maxStuck ' + c.maxStuck + ' @' + c.maxStuckAt + ' log ' + c.log.map(e => e[0] + '@' + e[2] + ' ' + e[1]).join(' | '));
    }
  }
}
console.log('\n' + tot.races + ' races of ' + n + ' cars x ' + laps + ' laps (' + tot.lapsDone + ' car-laps) in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s: contacts ' + tot.contacts + ' (lap 1: ' + tot.lap1 + ', ' +
  (tot.contacts / tot.lapsDone * 100).toFixed(1) + ' per 100 car-laps), heavy ' + tot.heavy + ', max ' + tot.max.toFixed(2) + ', AI rear-ends ' + tot.aiRear + ' (heavy ' + tot.aiRearHeavy + '), pile-ups ' + tot.pile +
  ', R ' + tot.R + ', stuck ' + tot.stuck + ', offs ' + tot.offs + ', wall hits ' + tot.walls);
process.exit(bad ? 1 : 0);
