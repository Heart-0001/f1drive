// node devtests/tyre-test/calib.js [--cars=a,b] [--tracks=re|all] [--drivers=line,human] [--compounds=S,M,H]
//   [--rates=1] [--workers=14] [--tag=name] [--maxkm=600]
//
// The tyre calibration matrix: every (car, track, driver, compound, wear rate) stint is DRIVEN with the real modules
// (devtests/tyre-test/drivers.js: js/car.js at 1/120 s with its js/tyres.js) from a standing start until the most
// worn tyre reaches 100 % (or a puncture, or --maxkm). Recorded per stint: km and laps to 50 / 75 (the cliff: 4 %
// grip lost, the cubic drop starts) / 90 / 100 % wear, any puncture (when, which tyre, why: worn through or an
// impact, and the impact's source), wall impacts, max temperatures, time sliding / off the asphalt, flat spots.
// Runs in parallel worker processes; writes out/calib-<tag>.json and prints the tables of devtests/tyre-test/README.md.
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const { fork } = require('child_process');

const CARS_DEFAULT = ['2010-red-bull', '2014-mercedes', '2023-red-bull', '2026-mercedes'];

if (process.argv[2] === '--worker') {
  const D = require('./drivers');
  process.on('message', job => {
    if (job === 'exit') process.exit(0);
    const t0 = Date.now();
    let r;
    try {
      r = D.stint({ track: job.track, car: job.car, driver: job.driver, compound: job.compound, wear: job.rate,
        laps: Math.ceil(job.maxkm * 1000 / D.L.track(job.track).length), seed: job.seed || 1, stopAtPuncture: true });
      r = { ok: true, track: r.track, car: r.car, driver: r.driver, compound: r.compound, rate: job.rate, km: r.km, lapKm: r.lapKm,
        lapT: r.laps.length > 2 ? r.laps[2] : (r.laps[1] || r.laps[0] || 0), kmTo: r.kmTo, lapsTo: r.lapsTo, punct: r.punct,
        hits: r.hits.length, hitMax: r.hits.reduce((m, h) => Math.max(m, h.hit), 0), hitList: r.hits.slice(0, 12), maxTemp: r.maxTemp,
        slipS: r.slipS, grassS: r.grassS, flat: r.flat, finalWear: r.finalWear, atCliff: r.atCliff, hotAt: r.hotAt, ms: Date.now() - t0 };
    } catch (e) { r = { ok: false, job, err: String(e && e.stack || e) }; }
    process.send(r);
  });
  return;
}

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const list = (k, d) => opt(k, d).split(',').filter(Boolean);
const L = require('../ai-test/lib');
const allTracks = global.F1_TRACKS.map(t => t.id);
const tr = opt('tracks', 'all');
const tracks = tr === 'all' ? allTracks : allTracks.filter(id => new RegExp(tr, 'i').test(id + ' ' + global.F1_TRACKS.find(t => t.id === id).name));
const cars = list('cars', CARS_DEFAULT.join(','));
const drivers = list('drivers', 'line,human');
const compounds = list('compounds', 'S,M,H');
const rates = list('rates', '1').map(Number);
const workers = +opt('workers', String(Math.max(1, Math.min(14, os.cpus().length - 2))));
const maxkm = +opt('maxkm', '600');
const tag = opt('tag', 'run');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const jobs = [];
for (const rate of rates) for (const compound of compounds) for (const driver of drivers) for (const car of cars) for (const track of tracks)
  jobs.push({ track, car, driver, compound, rate, maxkm: maxkm / rate });
// longest first (hard, rate 1) for a better spread over the workers
const est = j => (j.compound === 'H' ? 3 : j.compound === 'M' ? 2 : 1) / j.rate;
jobs.sort((a, b) => est(b) - est(a));

const results = [];
let next = 0, done = 0;
const t0 = Date.now();
console.log(jobs.length + ' stints on ' + workers + ' workers (' + cars.join(' ') + ' | ' + tracks.length + ' tracks | ' + drivers.join(' ') + ' | ' + compounds.join('') + ' | x' + rates.join(',x') + ')');
const pool = [];
for (let w = 0; w < Math.min(workers, jobs.length); w++) {
  const p = fork(__filename, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  p.on('message', r => {
    results.push(r); done++;
    if (!r.ok) console.log('ERROR', JSON.stringify(r.job), r.err);
    if (done % 50 === 0) console.log('  ' + done + ' / ' + jobs.length + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
    feed(p);
  });
  pool.push(p);
  feed(p);
}
function feed(p) {
  if (next < jobs.length) p.send(jobs[next++]);
  else { p.send('exit'); if (done === jobs.length) finish(); }
}
let finished = false;
function finish() {
  if (finished) return; finished = true;
  fs.writeFileSync(path.join(OUT, 'calib-' + tag + '.json'), JSON.stringify(results));
  report(results);
  console.log('done in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s -> out/calib-' + tag + '.json');
}

function report(R) {
  R = R.filter(r => r.ok);
  const f1 = x => x === undefined || x === null ? '  -- ' : x.toFixed(1).padStart(5);
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
  for (const rate of rates) {
    console.log('\n=== wear x' + rate + ': laps to the cliff (75 %) / to 100 %, per track (5 km-equivalent km / 5 in the summary)');
    for (const driver of drivers) for (const car of cars) {
      console.log('\n-- ' + car + ', driver ' + driver + ' -- laps to 75 % / 100 %  (S | M | H)');
      for (const track of tracks) {
        const row = compounds.map(c => R.find(r => r.rate === rate && r.driver === driver && r.car === car && r.track === track && r.compound === c));
        const td = global.F1_TRACKS.find(t => t.id === track);
        console.log(track.padEnd(8) + ' ' + td.name.slice(0, 26).padEnd(26) + row.map((r, i) => !r ? '   --' :
          compounds[i] + f1(r.lapsTo[0.75]) + f1(r.lapsTo[1]) + (r.punct && r.punct.cause !== 'worn through' ? ' P!' : '   ')).join('  ') +
          '   lap ' + (row[0] ? row[0].lapT.toFixed(1) : '--'));
      }
      for (const c of compounds) {
        const rs = R.filter(r => r.rate === rate && r.driver === driver && r.car === car && r.compound === c);
        const km75 = rs.map(r => r.kmTo[0.75]).filter(x => x !== undefined), km100 = rs.map(r => r.kmTo[1]).filter(x => x !== undefined);
        console.log('   ' + c + ': km to 75 %: mean ' + mean(km75).toFixed(0) + ' median ' + med(km75).toFixed(0) + ' min ' + Math.min(...km75).toFixed(0) +
          ' max ' + Math.max(...km75).toFixed(0) + ' | to 100 %: mean ' + mean(km100).toFixed(0) + ' (' + (mean(km100) / 5).toFixed(1) + ' laps of 5 km)' +
          (km75.length < rs.length ? ' | ' + (rs.length - km75.length) + ' never reached 75 %' : ''));
      }
    }
  }
  const bad = R.filter(r => r.punct && (r.punct.cause !== 'worn through' || Math.max(...r.punct.wear) < 1));
  console.log('\npunctures before 100 % wear / from impacts: ' + bad.length);
  bad.slice(0, 30).forEach(r => console.log('  ' + r.car + ' ' + r.track + ' ' + r.driver + ' ' + r.compound + ' x' + r.rate + ' ' + JSON.stringify(r.punct)));
  const hot = R.slice().sort((a, b) => Math.max(...b.maxTemp) - Math.max(...a.maxTemp)).slice(0, 5);
  console.log('hottest: ' + hot.map(r => r.car + ' ' + r.track + ' ' + r.driver + ' ' + r.compound + ' ' + Math.max(...r.maxTemp).toFixed(0)).join(', '));
}
