// node devtests/ai-test/critic-mixed.js [only=lapping,erratic,pit,wear,seasons,hairpin,determinism] [v=1]
// The critic's stress cases 2 and 5..10 (critic-sim.js: the real car / tyres / collide / pit / laps):
//   lapping      a rookie in a 2026 Cadillac among 7 pros / legends in the top 2026 cars, 10 laps on short circuits: how
//                often it is lapped, blue-flag yields, contacts with it, the time the faster cars spend held up behind it
//                (a car whose binding cap is the backmarker; only cars whose pace is better than its own)
//   erratic      8 computer cars with 2 "humans" (pace unknown, as a human's is): one erratic (steering noise, brake
//                tests, lifts), one erratic AND blind (sees nobody), 5 laps: contacts, who ran into whom
//   pit          10 cars, every one told to stop on the same lap (adjacent boxes): speeding / penalties, stops served in
//                the own box, contacts at the pit entry / exit, the merge back onto the track
//   wear         8 cars at wear x5 (the game's maximum, net/session.js WEAR_MAX), 10 laps: stops per car, punctures, tyres
//                run past 97 %, finishing
//   seasons      the same skill in 2010 cars (V8, no KERS) and 2026 cars: lap times, battery use, nobody stuck
//   hairpin      Monaco: alone at skill 0 / 1 (the Grand Hotel hairpin: speed, wall hits, R) and 15 cars, 3 laps
//   determinism  the same 15-car race twice: identical to the bit
// Exit 1 on a hard failure (marked FAIL).
'use strict';
const { createScenario, summarize, fmtSum, field, arg, F1, L } = require('./critic-sim');
const only = arg('only', 'lapping,erratic,pit,wear,seasons,hairpin,determinism').split(','), verbose = arg('v', '0') === '1';
let bad = 0;
const t0 = Date.now();
function fail(msg) { bad++; return '  <-- FAIL ' + msg; }

// ---- lapping
if (only.includes('lapping')) {
  console.log('== lapping: a 2026 Cadillac rookie among 2026 pros / legends in the top cars, 10 laps');
  for (const tr of ['austria', 'hungaroring', 'interlagos', 'mx-1962']) {
    const t = L.track(L.IDS[tr] || tr), N = t.samples.length, ds = t.length / N;
    const fast = ['2026-mercedes', '2026-mclaren', '2026-ferrari', '2026-red-bull'];
    const cars = [{ kind: 'ai', skill: 0, car: '2026-cadillac', name: 'BACK', at: Math.round(400 / ds), v: 40 }];
    for (let i = 0; i < 7; i++) cars.push({ kind: 'ai', skill: i < 3 ? 1 : 0.7, car: fast[i % fast.length], name: (i < 3 ? 'leg' : 'pro') + i, at: Math.round((300 - i * 40) / ds + N) % N, v: 40 });
    const sc = createScenario({ track: t.id, cars, laps: 10, seed: 5 });
    const backPace = sc.cars[0].ai.pace;
    // time the faster cars spend held up by the backmarker (their binding cap is it, within 60 m behind it)
    let heldT = 0, maxHeld = 0, cur = new Map();
    const rep = (function () {
      const maxS = 10 * 200;
      while (sc.time < maxS) {
        sc.step();
        for (const c of sc.cars) if (c.id !== 1 && c.ai.pace < backPace * 0.995) {
          // held up: its binding cap is the backmarker's, within 40 m of it, at (or over) that cap
          const a = c.ai.state, b0 = sc.cars[0].car.state, st = c.car.state;
          const held = a.capBy === 1 && Math.hypot(b0.x - st.x, b0.z - st.z) < 40 && a.targetSpeed < st.speed + 1;
          const h = (cur.get(c.id) || 0);
          if (held) { heldT += 1 / 120; cur.set(c.id, h + 1 / 120); if (h + 1 / 120 > maxHeld) maxHeld = h + 1 / 120; } else cur.set(c.id, 0);
        }
        if (sc.cars.every(c => c.fin)) break;
      }
      return sc.run();
    })();
    const back = rep.cars[0], sm = summarize(rep);
    const lapsDown = rep.cars.slice(1).reduce((m, c) => Math.max(m, c.laps), 0) - back.laps;
    const paces = sc.cars.map(c => c.ai.pace.toFixed(1));
    const withBack = rep.contacts.filter(k => k.a === 'BACK' || k.b === 'BACK');
    const f = withBack.some(k => k.h > 0.3) || sm.resets > 0 || maxHeld > 25 || !sm.finished;
    console.log('  ' + t.id.padEnd(8) + ' (paces ' + paces[0] + ' vs ' + paces.slice(1).join('/') + ') backmarker ' + lapsDown + ' lap(s) down, yields ' + back.stats.yields + ', contacts with it ' + withBack.length + ' (max ' + withBack.reduce((m, k) => Math.max(m, k.h), 0).toFixed(2) + ')' +
      ', leaders held up ' + heldT.toFixed(1) + ' s in all (longest ' + maxHeld.toFixed(1) + ' s) | ' + fmtSum(sm) + (f ? fail('') : ''));
    if (verbose) for (const k of rep.contacts) console.log('    ' + k.t + ' ' + k.a + ' x ' + k.b + ' h ' + k.h + ' [' + k.modes + ']');
  }
}

// ---- erratic humans
if (only.includes('erratic')) {
  console.log('== erratic humans (pace unknown): one with noise / brake tests / lifts, one also blind to everybody; 8 computer cars, 5 laps');
  let tot = { c: 0, aiStrike: 0, aiStrikeHeavy: 0, humStrike: 0, max: 0, R: 0 };
  for (const tr of ['interlagos', 'hungaroring', 'mx-1962', 'baku', 'silverstone', 'monza']) {
    const t = L.track(L.IDS[tr] || tr), N = t.samples.length, ds = t.length / N;
    const cars = field(8, { seed: tr.length, year: 2025 }).map((c, i) => Object.assign(c, { at: Math.round((600 - i * 45) / ds + N) % N, v: 35 }));
    cars.push({ kind: 'erratic', skill: 0.6, car: '2025-ferrari', name: 'HUM', at: Math.round(640 / ds) % N, v: 35, noise: 0.12, brakeEvery: 14, liftEvery: 9 });
    cars.push({ kind: 'erratic', skill: 0.4, car: '2025-mclaren', name: 'BLIND', blind: true, at: Math.round(260 / ds) % N, v: 35, noise: 0.15, brakeEvery: 18, liftEvery: 11, weave: 0.08 });
    const rep = createScenario({ track: t.id, cars, laps: 5, seed: 9, maxS: 900 }).run(), sm = summarize(rep);
    const hum = rep.contacts.filter(k => k.ka === 'erratic' || k.kb === 'erratic');
    const aiStr = hum.filter(k => k.strikerKind === 'ai'), humStr = hum.filter(k => k.strikerKind === 'erratic');
    tot.c += hum.length; tot.aiStrike += aiStr.length; tot.aiStrikeHeavy += aiStr.filter(k => k.h > 0.25).length; tot.humStrike += humStr.length;
    tot.max = Math.max(tot.max, ...aiStr.map(k => k.h), 0); tot.R += rep.cars.filter(c => c.kind === 'ai').reduce((s, c) => s + c.resets, 0);
    const f = aiStr.some(k => k.h > 0.4) || !sm.finished;
    console.log('  ' + t.id.padEnd(8) + ' contacts with the humans ' + hum.length + ': the computer car ran into one ' + aiStr.length + ' (max ' + aiStr.reduce((m, k) => Math.max(m, k.h), 0).toFixed(2) + '), a human ran into a computer car ' +
      humStr.length + ', side ' + hum.filter(k => !k.striker).length + ' | AI-AI ' + rep.contacts.filter(k => k.ka === 'ai' && k.kb === 'ai').length + ' | ' + fmtSum(sm) + (f ? fail('') : ''));
    if (verbose) for (const k of hum) console.log('    ' + k.t + ' ' + k.a + ' x ' + k.b + ' ' + k.kind + ' h ' + k.h + ' striker ' + k.striker + ' [' + k.modes + ']');
  }
  console.log('  total: ' + tot.c + ' contacts with the humans, computer car the striker in ' + tot.aiStrike + ' (heavy ' + tot.aiStrikeHeavy + ', max ' + tot.max.toFixed(2) + '), human the striker in ' + tot.humStrike + ', computer cars R ' + tot.R);
}

// ---- pit lane: everybody on the same lap
if (only.includes('pit')) {
  console.log('== pit lane: 10 cars told to stop on lap 2 (adjacent boxes), 3 laps');
  for (const tr of ['monza', 'bahrain', 'spa', 'baku', 'singapore', 'hungaroring']) {
    const t = L.track(L.IDS[tr] || tr);
    if (!t.pit) { console.log('  ' + t.id + ' no pit lane'); continue; }
    const cars = field(10, { seed: 2 + tr.length, year: 2026 });
    const sc = createScenario({ track: t.id, cars, laps: 3, seed: 4, start: 'grid', forcePit: { lap: 2, compound: 'H' } });
    const rep = sc.run(), sm = summarize(rep);
    const stops = rep.cars.reduce((s, c) => s + c.pits.length, 0), served = rep.cars.filter(c => c.pits.length >= 1).length;
    const P = t.pit, N = t.samples.length;
    const near = k => { const i = k.idx, u = ((i - P.from) % N + N) % N, L2 = ((P.to - P.from) % N + N) % N; return u <= L2 + 60 || u >= N - 60; };
    const pitC = rep.contacts.filter(near);
    const lane = rep.cars.map(c => c.laneMax), held = rep.cars.flatMap(c => c.pits.map(p => p.held));
    const f = sm.speeding > 0 || sm.penalties > 0 || served < 10 || pitC.some(k => k.h > 0.3) || !sm.finished;
    console.log('  ' + t.id.padEnd(8) + ' stops ' + stops + ' (cars served ' + served + '/10), held ' + Math.min(...held).toFixed(1) + '..' + Math.max(...held).toFixed(1) + ' s, lane top ' + Math.max(...lane) + ' km/h (limit ' + P.limitKmh + ')' +
      ', contacts near the pit lane ' + pitC.length + ' (max ' + pitC.reduce((m, k) => Math.max(m, k.h), 0).toFixed(2) + ') | ' + fmtSum(sm) + (f ? fail('') : ''));
    if (verbose) for (const k of pitC) console.log('    ' + k.t + ' ' + k.a + ' x ' + k.b + ' h ' + k.h + ' @' + k.idx + ' [' + k.modes + ']');
  }
}

// ---- very high wear
if (only.includes('wear')) {
  console.log('== tyre wear x5 (the maximum), 8 cars, 10 laps');
  for (const tr of ['bahrain', 'silverstone', 'suzuka', 'jeddah']) {
    const t = L.track(L.IDS[tr] || tr);
    const cars = field(8, { seed: 3 + tr.length, year: 2025 });
    const sc = createScenario({ track: t.id, cars, laps: 10, wear: 5, seed: 6, start: 'grid', maxS: 2400 });
    let punct = 0, over = 0, wasP = new Map();
    while (sc.time < 2400 && !sc.cars.every(c => c.fin)) {
      sc.step();
      for (const c of sc.cars) {
        const ty = c.car.tyres.state, p = ty.puncture >= 0;
        if (p && !wasP.get(c.id)) punct++; wasP.set(c.id, p);
        const w = Math.max(...ty.wear); if (w > 0.97) over++;
      }
    }
    const rep = sc.run(), sm = summarize(rep);
    const stops = rep.cars.map(c => c.pits.length);
    const f = !sm.finished || sm.speeding > 0 || sm.stuck > 0;
    console.log('  ' + t.id.padEnd(8) + ' stops per car ' + stops.join(',') + ' (compounds ' + rep.cars.map(c => c.pits.map(p => p.compound).join('')).join(' ') + '), punctures ' + punct + ', steps on a tyre past 97 %: ' + over + ' | ' + fmtSum(sm) + (f ? fail('') : ''));
  }
}

// ---- seasons
if (only.includes('seasons')) {
  console.log('== seasons: skill 0.7 alone, 3 laps, 2010 cars (V8, no KERS) vs 2026');
  for (const tr of ['monza', 'spa', 'monaco']) {
    const t = L.track(L.IDS[tr] || tr), parts = [];
    for (const id of ['2010-red-bull', '2010-hrt', '2014-mercedes', '2026-mercedes', '2026-cadillac']) {
      const sc = createScenario({ track: t.id, cars: [{ kind: 'ai', skill: 0.7, car: id, name: id, at: 0, v: 0 }], laps: 3, seed: 2 });
      let dep = 0, n = 0;
      while (sc.time < 700 && !sc.cars[0].fin) { sc.step(); const st = sc.cars[0].car.state; if (sc.cars[0].laps.length >= 1) { n++; if (st.deploy > 0) dep++; } }
      const rep = sc.run(), c = rep.cars[0];
      parts.push(id.replace(/^20/, '') + ' ' + L.fmt(c.best) + ' (ERS ' + (n ? (dep / n * 100).toFixed(0) : 0) + ' %, R ' + c.resets + ', walls ' + c.walls + ')');
      if (c.resets || !c.fin) { bad++; parts[parts.length - 1] += ' FAIL'; }
    }
    console.log('  ' + t.id.padEnd(8) + ' ' + parts.join(' | '));
  }
}

// ---- Monaco hairpin
if (only.includes('hairpin')) {
  const t = L.track('mc-1929'), line = L.line(t, null), N = t.samples.length;
  const car0 = F1.createCar(F1.REF_SPEC, { tyres: false });
  const prof = F1.AI.profile(F1.AI.prepare(t, line), car0.perf, 0.86, 0.8);
  let hp = 0; for (let i = 0; i < N; i++) if (prof[i] < prof[hp]) hp = i;
  console.log('== Monaco hairpin (slowest profile point at sample ' + hp + ', ' + (prof[hp] * 3.6).toFixed(0) + ' km/h; js/car.js ' + (typeof car0.perf.steerLockAt === 'function' ? 'has' : 'has no') + ' perf.steerLockAt)');
  for (const skill of [0, 1]) {
    const sc = createScenario({ track: t.id, cars: [{ kind: 'ai', skill, car: '2026-mercedes', name: 's' + skill, at: (hp - 300 + N) % N, v: 40 }], laps: 3, seed: 1 });
    let vMin = 1e9, walls = 0, hitOn = false, steerMax = 0, gr = 0;
    while (sc.time < 400 && !sc.cars[0].fin) {
      sc.step(); const c = sc.cars[0], st = c.car.state, k = ((st.sampleIndex - hp) % N + N) % N;
      if (k < 30 || k > N - 30) {
        vMin = Math.min(vMin, st.speed); steerMax = Math.max(steerMax, Math.abs(st.steer));
        const h = st.hit > 0.02; if (h && !hitOn) walls++; hitOn = h; if (st.onGrass) gr++;
      }
    }
    const rep = sc.run(), c = rep.cars[0];
    const f = c.resets > 0 || !c.fin || c.maxStuck > 8;
    console.log('  alone skill ' + skill + ': laps ' + c.lapTimes.map(x => L.fmt(x)).join(' ') + ', hairpin min ' + (vMin * 3.6).toFixed(1) + ' km/h, steer max ' + steerMax.toFixed(2) + ', wall hits there ' + walls + ', grass steps ' + gr + ', R ' + c.resets + (f ? fail('') : ''));
  }
  const cars = field(15, { seed: 8, year: 2026 });
  const rep = createScenario({ track: t.id, cars, laps: 3, seed: 8, start: 'grid' }).run(), sm = summarize(rep);
  const atHp = rep.contacts.filter(k => { const d = ((k.idx - hp) % N + N) % N; return d < 40 || d > N - 40; });
  console.log('  15 cars, 3 laps: ' + fmtSum(sm) + ' | contacts at the hairpin ' + atHp.length + (sm.resets > 2 || !sm.finished ? fail('') : ''));
}

// ---- determinism
if (only.includes('determinism')) {
  const run = () => {
    const cars = field(15, { seed: 12, year: 2026 });
    const rep = createScenario({ track: 'sa-2021', cars, laps: 2, seed: 12, start: 'grid', wear: 3 }).run();
    return JSON.stringify(rep.cars.map(c => [c.name, c.laps, c.lapTimes, c.resets, c.contacts])) + JSON.stringify(rep.contacts.map(k => [k.t, k.a, k.b, k.h]));
  };
  const a = run(), b = run();
  console.log('== determinism: the same 15-car race twice at Jeddah: ' + (a === b ? 'identical' : 'DIFFERENT') + (a === b ? '' : fail('')));
}
console.log('(' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)' + (bad ? ' ' + bad + ' FAILED' : ''));
process.exit(bad ? 1 : 0);
