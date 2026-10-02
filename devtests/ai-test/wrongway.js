// node devtests/ai-test/wrongway.js [v=8,15,40] [tracks=monaco,baku,spa,singapore,monza] [pos=0.2,0.45,0.7] [maxS=90]
// A car coming the WRONG WAY along the racing line (critic-sim.js's kinematic ghost: it never gives way, never stops
// and is not moved by contacts - worse than any human who turned round) meets 8 computer cars (a rolling stream, the
// 2026 field) on the street circuits and Monza, started from each place `pos` (share of the lap), for maxS s. Per
// speed: head-on hits (heavy > 0.25, the sum of their severities, max), contacts between computer cars, pile-ups, R,
// wall hits - summed over the runs, so that one chaotic run does not decide. AI_JS=<another copy of js/ai.js> for a
// comparison. Review r3 (2026-10-02), 15 runs per speed, old file -> fixed: 40 m/s 57 head-ons (52 heavy) -> 12 (10),
// pile-ups 14 -> 2; 15 m/s 23 (19) -> 3 (0), pile-ups 7 -> 0; 8 m/s 16 (13) -> 6 (5) (Monaco: cars stopped in a street
// with no room, reversing slower than the ghost comes on). ~1 min per speed.
'use strict';
const { createScenario, summarize, field, arg, L } = require('./critic-sim');
const VS = arg('v', '8,15,40').split(',').map(Number), TR = arg('tracks', 'monaco,baku,spa,singapore,monza').split(',');
const POS = arg('pos', '0.2,0.45,0.7').split(',').map(Number), maxS = +arg('maxS', 90);
for (const v of VS) {
  const T = { runs: 0, headOn: 0, headHeavy: 0, headMax: 0, sumH: 0, aiai: 0, aiaiHeavy: 0, pile: 0, R: 0, walls: 0 };
  for (const track of TR) for (const pos of POS) {
    const t = L.track(L.IDS[track] || track), N = t.samples.length;
    const cars = field(8, { seed: 2, year: 2026 }).map((c, i) => Object.assign(c, { at: 40 + i * 25, v: 30 }));
    cars.push({ kind: 'wrong', name: 'wrong', at: Math.floor(N * pos), v });
    const rep = createScenario({ track, laps: 2, seed: 2, start: 'spread', cars, maxS }).run(), s = summarize(rep);
    const ho = rep.contacts.filter(c => c.kind === 'head-on'), ai = rep.contacts.filter(c => c.kind !== 'head-on');
    T.runs++; T.headOn += ho.length; T.headHeavy += ho.filter(c => c.h > 0.25).length; T.headMax = Math.max(T.headMax, ...ho.map(c => c.h), 0);
    T.sumH += ho.reduce((a, c) => a + c.h, 0); T.aiai += ai.length; T.aiaiHeavy += ai.filter(c => c.h > 0.25).length;
    T.pile += s.pileups; T.R += s.resets; T.walls += s.walls;
  }
  console.log('v ' + String(v).padStart(2) + ' m/s, ' + T.runs + ' runs: head-on ' + T.headOn + ' (heavy ' + T.headHeavy + ', sum ' + T.sumH.toFixed(1) + ', max ' + T.headMax.toFixed(2) +
    ') | AI-AI ' + T.aiai + ' (heavy ' + T.aiaiHeavy + ') | pile-ups ' + T.pile + ' | R ' + T.R + ' | wall hits ' + T.walls);
}
