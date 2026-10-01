// node devtests/ai-test/race.js [track=monza] [n=8] [laps=5] [quali=0] [skills=mixed|rookie|...|0.5,1,...]
//                               [year=2025] [cars=same|season] [wear=1] [grid=reverse|order|random] [seed=1] [json=out.json]
// One Grand Prix of n computer cars (devtests/ai-test/sim.js: the real car / tyres / collide / pit / laps / session).
// Prints the classification, lap times per skill, finishing order vs skill (Spearman), on-track passes, contacts,
// offs, resets / stuck events, pit stops and the CPU cost of think().
'use strict';
const L = require('./lib'), F1 = L.F1;
const { createRace, spearman } = require('./sim');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };

function field(n, skills, year, carsMode, seed) {
  const rnd = F1.AI.makeRandom(seed * 13 + 5);
  const lv = F1.AI.LEVELS.map(l => l.skill);
  const list = F1.cars.list(year).filter(c => !/-standard$/.test(c.id));
  const out = [];
  for (let i = 0; i < n; i++) {
    let s;
    if (skills === 'mixed') s = lv[i % lv.length];
    else if (/^[a-z]+$/.test(skills)) s = F1.AI.skillOf(skills);
    else { const a = skills.split(',').map(Number); s = a[i % a.length]; }
    const car = carsMode === 'same' ? year + '-standard' : list[i % list.length].id;
    out.push({ skill: s, car, name: (F1.AI.levelOf(s).id.slice(0, 3)) + (i + 1) + ' ' + car.replace(/^\d+-/, '').slice(0, 8) });
  }
  return out;
}

function report(r, label) {
  const rows = r.cars.slice().sort((a, b) => (a.pos || 99) - (b.pos || 99));
  console.log('\n=== ' + label + ' : ' + r.track + ', ' + r.cars.length + ' cars, ' + r.R + ' laps' + (r.Q ? ', qualifying ' + r.Q : '') + ', wear x' + r.wear +
    ' (' + r.res.simS.toFixed(0) + ' s simulated in ' + (r.res.wallMs / 1000).toFixed(1) + ' s, ended in ' + r.res.finishedPhase + ')');
  console.log('pos grid name                  skill car               laps  best      total      pits          mist off wall R  rev pass/try def yld cont');
  for (const c of rows) {
    console.log(String(c.pos).padStart(3) + ' ' + String(c.grid).padStart(4) + ' ' + c.name.padEnd(21) + ' ' + c.skill.toFixed(2) + ' ' + c.car.padEnd(17) + ' ' +
      String(c.laps).padStart(3) + (c.fin ? 'F' : (c.dnf ? 'D' : ' ')) + ' ' + L.fmt(c.best).padStart(9) + ' ' + (c.fin ? L.fmt(c.time) : '').padStart(10) + ' ' +
      (c.pits.map(p => 'L' + p.lap + p.compound).join(',') || '-').padEnd(13) + ' ' +
      String(c.mistakes + (c.big ? '(' + c.big + ')' : '')).padStart(4) + ' ' + String(c.offs).padStart(3) + ' ' + String(c.wall).padStart(4) + ' ' +
      String(c.resets).padStart(2) + ' ' + String(c.reverses).padStart(3) + ' ' + (c.passes + '/' + c.passTries).padStart(8) + ' ' +
      String(c.defends).padStart(3) + ' ' + String(c.yields).padStart(3) + ' ' + String(c.contacts).padStart(4));
  }
  // lap times per skill: median of the clean race laps (not lap 1, not a pit lap)
  const bySkill = {};
  for (const c of r.cars) (bySkill[c.skill.toFixed(2)] = bySkill[c.skill.toFixed(2)] || []).push(...c.cleanLaps);
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
  console.log('clean race laps per skill (median / best / sd): ' + Object.keys(bySkill).sort().map(k => {
    const a = bySkill[k], m = med(a), sd = a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) : 0;
    return k + ': ' + L.fmt(m) + ' / ' + L.fmt(Math.min(...a)) + ' / ' + sd.toFixed(2) + ' s (' + a.length + ')';
  }).join('  '));
  const fin = r.cars.filter(c => c.pos > 0);
  const rho = spearman(fin.map(c => c.pos), fin.map(c => -c.skill));
  const res = r.res;
  console.log('finishing order vs skill: Spearman ' + rho.toFixed(2) + ' (1 = strictly by skill)');
  console.log('on-track passes ' + res.overtakes + ' (pass attempts ' + r.cars.reduce((s, c) => s + c.passTries, 0) + ', completed by the passer ' + r.cars.reduce((s, c) => s + c.passes, 0) + ')' +
    ' | contacts ' + res.contactEvents + ' (heavy > 0.25: ' + res.contactHeavy + ', max ' + res.contactMax.toFixed(2) + ', mean ' + (res.contactEvents ? res.contactSum / res.contactEvents : 0).toFixed(2) + ')' +
    ' | offs ' + r.cars.reduce((s, c) => s + c.offs, 0) + ' | wall hits ' + r.cars.reduce((s, c) => s + c.wall, 0) +
    ' | resets ' + r.cars.reduce((s, c) => s + c.resets, 0) + ' | stuck ' + r.cars.reduce((s, c) => s + c.stuck, 0) +
    ' | mistakes ' + r.cars.reduce((s, c) => s + c.mistakes, 0) + ' | pit stops ' + r.cars.reduce((s, c) => s + c.pits.length, 0));
  const tu = r.cars.map(c => c.thinkUs), tm = Math.max(...r.cars.map(c => c.thinkMaxUs)), cu = r.cars.map(c => c.carUs);
  console.log('cost per call: think mean ' + (tu.reduce((a, b) => a + b, 0) / tu.length).toFixed(2) + ' us (max single call ' + tm.toFixed(0) + ' us), car.update mean ' +
    (cu.reduce((a, b) => a + b, 0) / cu.length).toFixed(2) + ' us');
  if (res.contactList && res.contactList.length) console.log('contacts: ' + res.contactList.slice(0, 12).map(x => x.join(' ')).join(' | '));
  const ev = r.cars.filter(c => c.events.length).map(c => c.name + ': ' + c.events.slice(0, 6).map(e => e.join(' ')).join(', '));
  if (ev.length) console.log('events: ' + ev.join(' | '));
  if (process.env.AILOG) for (const c of r.cars) if (c.log.length) console.log('  log ' + c.name + ': ' + c.log.map(e => e[0] + 's@' + e[2] + ' ' + e[1]).join(' | '));
}

if (require.main === module) {
  const track = arg('track', 'monza'), n = +arg('n', 8), laps = +arg('laps', 5), quali = +arg('quali', 0);
  const skills = arg('skills', 'mixed'), year = +arg('year', 2025), carsMode = arg('cars', 'season'), wear = +arg('wear', 1);
  const grid = arg('grid', 'reverse'), seed = +arg('seed', 1);
  const cars = field(n, skills, year, carsMode, seed);
  const r = createRace({ track, cars, laps, quali, wear, seed, grid }).run();
  report(r, track + ' ' + n + ' cars ' + skills);
  const out = arg('json', '');
  if (out) require('fs').writeFileSync(out, JSON.stringify(r, null, 1));
}
module.exports = { field, report };
