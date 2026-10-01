// node devtests/ai-test/critic-obstacle.js [tracks=...] [mode=parked|wrong|both] [n=10] [v=1]
// The critic's stress cases 3 and 4. A stream of n computer cars (mixed levels, rolling start ~1.3 s apart) meets:
//   parked  a stopped car ON THE RACING LINE at automatically chosen places: the apex of the fastest walled corner
//           (blind: a wall close on the inside), just past the exit of the slowest corner, mid-straight at top speed,
//           in the braking zone of the slowest corner; and a crashed car ACROSS the road (yaw 90 deg) at the blind apex
//   wrong   a car driving the WRONG WAY along the racing line at 15 m/s and at 45 m/s (a human who turned round)
// Each run lasts until every computer car has done 2 laps (or 400 s). Reported: hits on the obstacle (count, worst
// severity, the speed of the computer car), contacts between computer cars, R, stuck cars, the slowest pass (time
// lost against an undisturbed lap). Exit 1 when a computer car hits a PARKED car harder than 0.4, a computer car stands
// for more than 60 s, the run needs more than 3 R or does not finish. The wrong-way car is a kinematic ghost that never
// gives way and is not moved by contacts (worse than any human): those runs are reported, not judged.
// ('stuck' = 10 s without 0.4 % of a lap of progress: in a single-file queue past a wreck that is waiting, not a fault)
'use strict';
const { createScenario, summarize, fmtSum, arg, F1, L } = require('./critic-sim');
const TR = arg('tracks', 'monaco,baku,jeddah,singapore,vegas,spa,suzuka,hungaroring,mx-1962,interlagos,austria').split(',');
const mode = arg('mode', 'both'), n = +arg('n', 10), verbose = arg('v', '0') === '1';

function places(t, line) {
  const S = t.samples, N = S.length, P = line.points, ds = t.length / N;
  const car = F1.createCar(F1.REF_SPEC, { tyres: false });
  const prof = F1.AI.profile(F1.AI.prepare(t, line), car.perf, 0.86, 0.8);
  let fast = -1, fastV = 0, slow = 0, top = 0;
  for (let i = 0; i < N; i++) {
    const k = Math.abs(P[i].curvature || 0), s = S[i];
    const inside = (P[i].curvature || 0) < 0 ? s.wallPosDist : s.wallNegDist;     // curvature < 0: left turn, inside +n
    if (k > 1 / 400 && prof[i] > fastV && prof[i] < 75 && inside < 9) { fastV = prof[i]; fast = i; }
    if (prof[i] < prof[slow]) slow = i;
    if (prof[i] > prof[top] && k < 1 / 2000) top = i;
  }
  const out = [];
  if (fast >= 0) out.push({ what: 'blind apex ' + (fastV * 3.6).toFixed(0) + ' km/h', at: fast });
  out.push({ what: 'slowest exit', at: (slow + Math.round(40 / ds)) % N });
  out.push({ what: 'straight', at: top });
  out.push({ what: 'braking zone', at: (slow - Math.round(90 / ds) + N) % N });
  if (fast >= 0) out.push({ what: 'across at blind apex', at: fast, yaw: Math.PI / 2 });
  return out;
}

let bad = 0;
const tot = { runs: 0, obsHits: 0, obsHeavy: 0, obsMax: 0, aiContacts: 0, aiHeavy: 0, R: 0, stuck: 0 };
const t0 = Date.now();
for (const tr of TR) {
  const t = L.track(L.IDS[tr] || tr), line = L.line(t, null), N = t.samples.length, ds = t.length / N;
  const cases = [];
  if (mode !== 'wrong') for (const p of places(t, line)) cases.push({ kind: 'parked', label: p.what, at: p.at, yaw: p.yaw || 0 });
  if (mode !== 'parked') for (const v of [15, 45]) cases.push({ kind: 'wrong', label: 'wrong way ' + v + ' m/s', at: Math.floor(N * 0.5), v });
  for (const cs of cases) {
    const rnd = F1.AI.makeRandom(cs.at + 17);
    const cars = [];
    const startAt = (cs.kind === 'parked' ? cs.at - Math.round(900 / ds) : cs.at - Math.round(1500 / ds));
    for (let i = 0; i < n; i++) {
      const lv = F1.AI.LEVELS[Math.floor(rnd() * 4)].skill;
      cars.push({ kind: 'ai', skill: lv, car: '2025-standard', name: F1.AI.levelOf(lv).id.slice(0, 3) + (i + 1), at: startAt - i * Math.round(60 / ds), v: 45 });
    }
    cars.push({ kind: cs.kind, name: cs.kind === 'parked' ? 'PARKED' : 'WRONG', at: cs.at, yaw: cs.yaw, v: cs.v });
    const sc = createScenario({ track: t.id, cars, laps: 2, seed: 3, start: 'spread', maxS: 400 });
    const rep = sc.run(), sm = summarize(rep);
    const obs = rep.contacts.filter(k => k.ka === cs.kind || k.kb === cs.kind);
    const ai = rep.contacts.filter(k => k.ka === 'ai' && k.kb === 'ai');
    const obsMax = obs.reduce((m, k) => Math.max(m, k.h), 0);
    tot.runs++; tot.obsHits += obs.length; tot.obsHeavy += obs.filter(k => k.h > 0.15).length; tot.obsMax = Math.max(tot.obsMax, obsMax);
    tot.aiContacts += ai.length; tot.aiHeavy += ai.filter(k => k.h > 0.25).length; tot.R += sm.resets; tot.stuck += sm.stuck;
    const fail = cs.kind === 'parked' && (obsMax > 0.4 || sm.maxStuck > 60 || sm.resets > 3 || !sm.finished);
    if (fail) bad++;
    const aiCars = rep.cars.filter(c => c.kind === 'ai');
    const lap2 = aiCars.map(c => c.lapTimes[1]).filter(Boolean);
    console.log((t.id + ' ' + cs.label).padEnd(40) + ' obstacle hits ' + obs.length + ' (max ' + obsMax.toFixed(2) + ')  AI-AI ' + ai.length + ' (heavy ' + ai.filter(k => k.h > 0.25).length + ')  R ' + sm.resets +
      ' stuck ' + sm.stuck + ' (max ' + sm.maxStuck.toFixed(1) + ' s)  offs ' + sm.offs + '  finished ' + sm.finished + (fail ? '  <-- FAIL' : ''));
    if (verbose || fail) {
      for (const k of rep.contacts.slice(0, 10)) console.log('    ' + k.t.toFixed(2) + ' ' + k.a + ' x ' + k.b + ' ' + k.kind + ' h ' + k.h + ' gap ' + k.gap + ' @' + k.idx + ' [' + k.modes + ']');
      for (const c of aiCars) if (c.resets || c.stuck || c.maxStuck > 5) console.log('    ' + c.name + ' R ' + c.resets + ' stuck ' + c.stuck + ' maxStuck ' + c.maxStuck + ' @' + c.maxStuckAt + ' log ' + c.log.map(e => e[0] + '@' + e[2] + ' ' + e[1]).join(' | '));
    }
  }
}
console.log('\n' + tot.runs + ' runs in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s: obstacle hits ' + tot.obsHits + ' (> 0.15: ' + tot.obsHeavy + ', max ' + tot.obsMax.toFixed(2) + '), AI-AI contacts ' + tot.aiContacts +
  ' (heavy ' + tot.aiHeavy + '), R ' + tot.R + ', stuck ' + tot.stuck);
process.exit(bad ? 1 : 0);
