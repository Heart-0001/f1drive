// node devtests/ai-test/matrix.js [tracks=a,b,...] [quick=1] [json=devtests/ai-test/out/matrix.json]
// The scenario matrix of the computer drivers: on every circuit three Grand Prix (devtests/ai-test/sim.js, the real
// car / tyres / collide / pit / laps / session at 1/120 s, standing starts on the painted grid):
//   A  4 cars, one of each level, qualifying 1 lap -> grid by qualifying, 3 laps
//   B  8 cars, two of each level, grid reversed (slowest in front), 4 laps
//   C 15 cars, mixed levels and the season's cars, random grid, 3 laps, tyre wear x4 (pit stops)
// Reported per race and in total: finishing order vs skill (Spearman), on-track passes, contacts (count, heavy > 0.25,
// max), offs, resets, stuck events, pit stops (+ lane speeding / penalties), best race lap of every car against the
// reference lap of its own car (the line's margins driven perfectly, F1.createAIDriver({reference: true})) per level,
// and the cost of think() / car.update. Exit code 1 when a race does not finish or a hard limit is broken (a heavy
// contact rate, resets, stuck cars, speeding in the pit lane).
'use strict';
const fs = require('fs'), path = require('path');
const L = require('./lib'), F1 = L.F1;
const { createRace, spearman } = require('./sim');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const TRACKS = arg('tracks', 'monza,monaco,spa,suzuka,bahrain,zandvoort,singapore,silverstone,hungaroring,interlagos,baku,jeddah,vegas,austria').split(',');
const quick = arg('quick', '0') === '1';
const out = arg('json', path.join(__dirname, 'out', 'matrix.json'));
const LV = F1.AI.LEVELS;

function field(n, year, seed, mode) {
  const rnd = F1.AI.makeRandom(seed);
  const cars = F1.cars.list(year).filter(c => !/-standard$/.test(c.id));
  const list = [];
  for (let i = 0; i < n; i++) {
    const lv = mode === 'one' ? LV[i % 4] : (mode === 'two' ? LV[i >> 1 & 3] : LV[Math.floor(rnd() * 4)]);
    const car = cars[(i * 7 + seed) % cars.length].id;
    list.push({ skill: lv.skill, car, name: lv.id.slice(0, 3) + (i + 1) + ' ' + car.replace(/^\d+-/, '').slice(0, 8) });
  }
  return list;
}

const refCache = new Map();
function refLap(t, specId) {
  const key = t.id + '|' + specId;
  if (refCache.has(key)) return refCache.get(key);
  const car = F1.createCar(F1.cars.get(specId) || F1.REF_SPEC, { tyres: false });
  const ai = F1.createAIDriver({ track: t, raceLine: L.line(t, null), car, reference: true, seed: 1, id: 1 });
  car.reset(t, 0); car.setBattery(1); ai.reset();
  const S = t.samples, N = S.length, st = car.state, laps = [], ctx = F1.AI.createContext();
  let time = 0, prev = 0, start = 0;
  while (laps.length < 3 && time < 600) {
    const inp = ai.think(1 / 120, null, ctx); car.update(1 / 120, inp, t); time += 1 / 120;
    if (prev > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - start); start = tc;
    }
    prev = st.sampleIndex;
  }
  const r = Math.min(...laps.slice(1));
  refCache.set(key, r);
  return r;
}

const SCEN = [
  { id: 'A', n: 4, laps: 3, quali: 1, grid: 'quali', wear: 1, mode: 'one', year: 2025 },
  { id: 'B', n: 8, laps: quick ? 3 : 4, quali: 0, grid: 'reverse', wear: 1, mode: 'two', year: 2025 },
  { id: 'C', n: 15, laps: 3, quali: 0, grid: 'random', wear: 4, mode: 'mixed', year: 2026 }
];
const rows = [], gaps = {}, t0 = Date.now();
let bad = 0;
const tot = { races: 0, cars: 0, laps: 0, passes: 0, contacts: 0, heavy: 0, max: 0, offs: 0, resets: 0, stuck: 0, pits: 0, speeding: 0, penalties: 0,
  rho: [], thinkUs: [], thinkMax: 0, carUs: [], simS: 0, mistakes: 0, unfinished: 0 };
console.log('track        sc cars laps  rho  passes contacts(heavy,max) offs R stuck pits spd mist | best race lap vs own car\'s reference, per level');
for (const name of TRACKS) {
  const t = L.track(L.IDS[name] || name);
  for (const sc of SCEN) {
    const cars = field(sc.n, sc.year, 3 + name.length, sc.mode);
    const r = createRace({ track: t.id, cars, laps: sc.laps, quali: sc.quali, wear: sc.wear, seed: 7 + name.length, grid: sc.grid }).run();
    const res = r.res, fin = r.cars.filter(c => c.pos > 0);
    const rho = spearman(fin.map(c => c.pos), fin.map(c => -c.skill));
    const evs = r.cars.reduce((a, c) => a.concat(c.events.map(e => e[1])), []);
    const speeding = evs.filter(e => e === 'speeding').length, pens = evs.filter(e => e === 'penaltyStart').length;
    const pits = r.cars.reduce((s, c) => s + c.pits.filter(p => p.phase === 'race').length, 0);
    const unfinished = r.cars.filter(c => !c.fin).length;
    const per = {};
    for (const c of r.cars) {
      if (!(c.best > 0)) continue;
      const g = (c.best / refLap(t, c.car) - 1) * 100, lv = F1.AI.levelOf(c.skill).id;
      (per[lv] = per[lv] || []).push(g); (gaps[lv] = gaps[lv] || []).push(g);
    }
    const sum = k => r.cars.reduce((s, c) => s + c[k], 0);
    const row = { track: t.id, sc: sc.id, n: sc.n, laps: sc.laps, rho, passes: res.overtakes, contacts: res.contactEvents, heavy: res.contactHeavy,
      max: res.contactMax, offs: sum('offs'), resets: sum('resets'), stuck: sum('stuck'), pits, speeding, penalties: pens, mistakes: sum('mistakes'),
      unfinished, ended: res.finishedPhase, per, thinkUs: r.cars.reduce((s, c) => s + c.thinkUs, 0) / r.cars.length,
      thinkMaxUs: Math.max(...r.cars.map(c => c.thinkMaxUs)), carUs: r.cars.reduce((s, c) => s + c.carUs, 0) / r.cars.length, simS: res.simS, wallMs: res.wallMs,
      contactList: (res.contactList || []).slice(0, 10) };
    rows.push(row);
    tot.races++; tot.cars += sc.n; tot.laps += sc.n * sc.laps; tot.passes += row.passes; tot.contacts += row.contacts; tot.heavy += row.heavy;
    tot.max = Math.max(tot.max, row.max); tot.offs += row.offs; tot.resets += row.resets; tot.stuck += row.stuck; tot.pits += pits;
    tot.speeding += speeding; tot.penalties += pens; tot.rho.push(rho); tot.thinkUs.push(row.thinkUs); tot.thinkMax = Math.max(tot.thinkMax, row.thinkMaxUs);
    tot.carUs.push(row.carUs); tot.simS += res.simS; tot.mistakes += row.mistakes; tot.unfinished += unfinished;
    if (res.finishedPhase !== 'results' || speeding) bad++;
    console.log(t.id.padEnd(12) + ' ' + sc.id + ' ' + String(sc.n).padStart(4) + ' ' + String(sc.laps).padStart(4) + ' ' + rho.toFixed(2).padStart(5) + ' ' +
      String(row.passes).padStart(6) + ' ' + (row.contacts + '(' + row.heavy + ',' + row.max.toFixed(2) + ')').padStart(13) + ' ' + String(row.offs).padStart(5) + ' ' +
      String(row.resets).padStart(1) + ' ' + String(row.stuck).padStart(5) + ' ' + String(pits).padStart(4) + ' ' + String(speeding).padStart(3) + ' ' + String(row.mistakes).padStart(4) + ' | ' +
      LV.map(l => per[l.id] ? l.id.slice(0, 3) + ' ' + (per[l.id].reduce((a, b) => a + b, 0) / per[l.id].length).toFixed(1) + '%' : '').filter(Boolean).join('  ') +
      (row.ended !== 'results' ? '  ENDED IN ' + row.ended : '') + (unfinished ? '  (' + unfinished + ' not classified as finished)' : ''));
  }
}
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
console.log('\n' + tot.races + ' races, ' + tot.cars + ' cars, ' + tot.laps + ' race laps, ' + (tot.simS / 3600).toFixed(1) + ' h simulated in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
console.log('finishing order vs skill (Spearman): median ' + med(tot.rho).toFixed(2) + ' (A ' + med(rows.filter(r => r.sc === 'A').map(r => r.rho)).toFixed(2) +
  ', B ' + med(rows.filter(r => r.sc === 'B').map(r => r.rho)).toFixed(2) + ', C ' + med(rows.filter(r => r.sc === 'C').map(r => r.rho)).toFixed(2) + ')');
console.log('on-track passes ' + tot.passes + ' | contacts ' + tot.contacts + ' (' + (tot.contacts / tot.laps * 100).toFixed(1) + ' per 100 car-laps; heavy > 0.25: ' + tot.heavy + ', max ' + tot.max.toFixed(2) + ')' +
  ' | offs ' + tot.offs + ' | resets ' + tot.resets + ' | stuck ' + tot.stuck + ' | mistakes ' + tot.mistakes + ' | pit stops ' + tot.pits + ' (speeding ' + tot.speeding + ', penalties ' + tot.penalties + ')' +
  ' | cars not finished ' + tot.unfinished);
console.log('best race lap vs the reference of its own car, median per level: ' + LV.map(l => l.id + ' ' + (gaps[l.id] ? '+' + med(gaps[l.id]).toFixed(2) + ' %' : '-')).join(', ') +
  '  (in traffic, standing start, tyre wear; alone: ' + LV.map(l => '+' + l.lapPct).join(' / ') + ' %)');
console.log('think() ' + (tot.thinkUs.reduce((a, b) => a + b, 0) / tot.thinkUs.length).toFixed(2) + ' us per call (max single call ' + tot.thinkMax.toFixed(0) + ' us), car.update ' +
  (tot.carUs.reduce((a, b) => a + b, 0) / tot.carUs.length).toFixed(2) + ' us per step');
try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), rows, gaps, tot }, null, 1)); console.log('-> ' + out); } catch (e) { console.log('json not written: ' + e.message); }
process.exit(bad ? 1 : 0);
