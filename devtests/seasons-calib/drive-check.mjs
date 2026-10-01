// node devtests/seasons-calib/drive-check.mjs [years...]
//
// Drive-check of the cars of every season with the REAL car model: every CarSpec of F1.cars.list(year) (js/cars.js on
// the generated js/seasons-data.js) is driven by the node autopilot (driver.mjs: racing line built for that car,
// 120 Hz, flying lap = best of laps 2..3) on Monza (fast), Silverstone (fast corners) and the Hungaroring (twisty).
// Driven lap delta of a car = mean over the three of (its flying lap / the season's standard car's - 1), %.
// Reported per season: Spearman rank correlation of the driven order with the REAL qualifying order (F1DB median gap,
// tools/seasons-raw.json) and with the data's own target order (est.lapPct of the profile model, the calibration circuits), the
// driven spread fastest .. slowest, the character check (does a fast-circuit car gain on Monza against the
// Hungaroring?) and off-track runs. Writes devtests/seasons-calib/drive-check.json (only when every season was run).
// Exit code 1 when a car leaves the road on a flying lap or a correlation with the real order is below 0.8.
// About 3 min.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as B from '../../tools/build-cars.mjs';
import { driveLap, buildTracks } from './driver.mjs';

const require = createRequire(import.meta.url);
// the battery as the calibration used it (calibration.json `deploy`: E held on full throttle above 100 km/h)
const DEPLOY = JSON.parse(readFileSync(B.CALIB_FILE, 'utf8')).deploy === true ? { deploy: true } : undefined;
const only = process.argv.slice(2).filter(a => /^\d{4}$/.test(a)).map(Number);
const G = B.loadGame();
require(join(B.ROOT, 'js', 'seasons-data.js'));
require(join(B.ROOT, 'js', 'cars.js'));
const CARS = G.cars;
const { raw } = B.loadInputs();
const TRACKS = ['it-1922', 'gb-1948', 'hu-1986'];
const tracks = buildTracks(TRACKS);
const t0 = Date.now();

// ranks with ties averaged (1 = fastest)
function ranks(v) {
  const idx = v.map((x, i) => i).sort((a, b) => v[a] - v[b]), r = new Array(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function spearman(a, b) {
  const ra = ranks(a), rb = ranks(b), ma = B.mean(ra), mb = B.mean(rb);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < ra.length; i++) { sab += (ra[i] - ma) * (rb[i] - mb); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}

const out = { generatedBy: 'devtests/seasons-calib/drive-check.mjs', hz: 120, tracks: TRACKS, seasons: [] };
let bad = 0;
for (const s of CARS.seasons) {
  if (only.length && !only.includes(s.year)) continue;
  const list = CARS.list(s.year), rs = raw.seasons.find(q => q.year === s.year);
  const data = global.F1_SEASONS.find(q => q.year === s.year);
  const runs = list.map(spec => tracks.map(t => driveLap(t, spec, DEPLOY)));
  const std = runs[0];
  const rows = list.slice(1).map((spec, k) => {
    const r = runs[k + 1], e = rs.entries.find(q => q.id === spec.id), d = data.cars.find(q => q.id === spec.id);
    const per = r.map((x, i) => (x.flying / std[i].flying - 1) * 100);
    return { id: spec.id, realGapPct: e.pace.medianGapPct, leanPct: e.character.vsFieldPct, targetPct: d.est.lapPct, drivenPct: B.mean(per),
      perTrackPct: per, off: r.filter(x => x.grass || x.hits || !(x.flying > 0)).length, vmaxMonzaKmh: r[0].vmaxKmh };
  });
  const off = rows.reduce((n, r) => n + r.off, 0) + std.filter(x => x.grass || x.hits || !(x.flying > 0)).length;
  const rhoReal = spearman(rows.map(r => r.realGapPct), rows.map(r => r.drivenPct));
  const rhoTarget = spearman(rows.map(r => r.targetPct), rows.map(r => r.drivenPct));
  // character: Monza minus Hungaroring delta against the real fast-circuit lean (negative = gains on Monza)
  const rhoChar = spearman(rows.map(r => -r.leanPct), rows.map(r => r.perTrackPct[0] - r.perTrackPct[2]));
  const spread = Math.max(...rows.map(r => r.drivenPct)) - Math.min(...rows.map(r => r.drivenPct));
  const rec = { year: s.year, cars: rows.length, rhoReal: B.round(rhoReal, 3), rhoTarget: B.round(rhoTarget, 3), rhoCharacter: B.round(rhoChar, 3),
    drivenSpreadPct: B.round(spread, 3), offTrackRuns: off,
    standardLaps: Object.fromEntries(TRACKS.map((id, i) => [id, B.round(std[i].flying, 3)])),
    rows: rows.map(r => ({ id: r.id, realGapPct: r.realGapPct, targetPct: r.targetPct, drivenPct: B.round(r.drivenPct, 3), perTrackPct: r.perTrackPct.map(v => B.round(v, 3)),
      monzaVmaxKmh: B.round(r.vmaxMonzaKmh, 1) })) };
  out.seasons.push(rec);
  if (off || rhoReal < 0.8) bad++;
  console.log(s.year + '  cars ' + rows.length + '  rank correlation: real qualifying ' + rhoReal.toFixed(3) + ', data target ' + rhoTarget.toFixed(3) +
    ', character (Monza - Hungaroring vs lean) ' + rhoChar.toFixed(3) + '  driven spread ' + spread.toFixed(3) + ' %' + (off ? '  OFF-TRACK ' + off : ''));
  const order = rows.slice().sort((a, b) => a.drivenPct - b.drivenPct);
  console.log('      driven order: ' + order.map(r => r.id.slice(5) + ' ' + (r.drivenPct >= 0 ? '+' : '') + r.drivenPct.toFixed(2)).join(', '));
}
if (!only.length) { writeFileSync(join(B.ROOT, 'devtests', 'seasons-calib', 'drive-check.json'), JSON.stringify(out, null, 1) + '\n'); console.log('wrote devtests/seasons-calib/drive-check.json'); }
console.log((bad ? bad + ' season(s) with problems' : 'all seasons ok') + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
if (bad) process.exitCode = 1;
