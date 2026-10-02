// node devtests/ai-test/passing.js [seeds=1,2,3] [sc=B,C] [tracks=a,b,...] [list=1]
// Passing and contacts over more races than matrix.js: its race B (8 cars, two of each level, grid REVERSED, 4 laps)
// and C (15 cars, mixed levels and the season's cars, random grid, tyre wear x4, 3 laps) on its 14 circuits, each with
// other seeds (seed s: the field's seed + 17 s, the race's seed + 31 s - seed 0 is matrix.js's own race). One line per
// seed: on-track passes, contacts (heavy > 0.25, max), offs, R, stuck, cars not finished, finishing order vs skill
// (Spearman, median of B / C / all). list=1 prints every heavy contact (who, the modes). A single race is chaotic (a
// change anywhere moves every car a little and the contacts with them): compare versions over all the seeds
// (AI_JS=<other copy of js/ai.js> for the other one). Review r3 (2026-10-02): the old file 342 passes, 22 contacts
// (2 heavy), Spearman ~0.5..0.7 over seeds 1..3; the fixed one 437 passes, 3 contacts (1 heavy), ~0.7. ~4 min per seed.
'use strict';
const L = require('./lib'), F1 = L.F1;
const { createRace, spearman } = require('./sim');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const LV = F1.AI.LEVELS;
function field(n, year, seed, mode) {                 // (matrix.js's)
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
const SC = { B: { n: 8, laps: 4, quali: 0, grid: 'reverse', wear: 1, mode: 'two', year: 2025 },
  C: { n: 15, laps: 3, quali: 0, grid: 'random', wear: 4, mode: 'mixed', year: 2026 } };
const seeds = arg('seeds', '1,2,3').split(',').map(Number), scs = arg('sc', 'B,C').split(','), list = arg('list', '0') === '1';
const TRACKS = arg('tracks', 'monza,monaco,spa,suzuka,bahrain,zandvoort,singapore,silverstone,hungaroring,interlagos,baku,jeddah,vegas,austria').split(',');
const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
const all = { passes: 0, contacts: 0, heavy: 0 };
for (const off of seeds) {
  const tot = { races: 0, passes: 0, contacts: 0, heavy: 0, max: 0, offs: 0, R: 0, stuck: 0, unf: 0, rho: { B: [], C: [] }, list: [] };
  for (const name of TRACKS) for (const id of scs) {
    const sc = SC[id], t = L.track(L.IDS[name] || name);
    const cars = field(sc.n, sc.year, 3 + name.length + 17 * off, sc.mode);
    const r = createRace({ track: t.id, cars, laps: sc.laps, quali: sc.quali, wear: sc.wear, seed: 7 + name.length + 31 * off, grid: sc.grid }).run();
    const res = r.res, fin = r.cars.filter(c => c.pos > 0);
    tot.races++; tot.passes += res.overtakes; tot.contacts += res.contactEvents; tot.heavy += res.contactHeavy; tot.max = Math.max(tot.max, res.contactMax);
    tot.offs += r.cars.reduce((a, c) => a + c.offs, 0); tot.R += r.cars.reduce((a, c) => a + c.resets, 0); tot.stuck += r.cars.reduce((a, c) => a + c.stuck, 0);
    tot.unf += r.cars.filter(c => !c.fin).length;
    tot.rho[id].push(spearman(fin.map(c => c.pos), fin.map(c => -c.skill)));
    for (const c of (res.contactList || [])) if (c[3] > 0.25) tot.list.push(name + ' ' + id + ' ' + c.join(' '));
  }
  console.log('seed ' + off + ': ' + tot.races + ' races, passes ' + tot.passes + ', contacts ' + tot.contacts + ' (heavy ' + tot.heavy + ', max ' + tot.max.toFixed(2) + '), offs ' + tot.offs +
    ', R ' + tot.R + ', stuck ' + tot.stuck + ', not finished ' + tot.unf + ' | Spearman B ' + med(tot.rho.B).toFixed(2) + ' C ' + med(tot.rho.C).toFixed(2) +
    ' all ' + med(tot.rho.B.concat(tot.rho.C)).toFixed(2));
  if (list) for (const x of tot.list) console.log('   ' + x);
  all.passes += tot.passes; all.contacts += tot.contacts; all.heavy += tot.heavy;
}
console.log('total: passes ' + all.passes + ', contacts ' + all.contacts + ' (heavy ' + all.heavy + ')');
