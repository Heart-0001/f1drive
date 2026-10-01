// node devtests/seasons-calib/ers-effect.mjs [--check] [--jobs N] [years...]
//
// The DRIVEN lap-time effect of every car's battery, for tools/build-cars.mjs (METHOD B). tools/ers-data.json gives
// every car of 2011..2026 its own battery (deploy / harvest / store multipliers, or none: the cars that raced without
// KERS; read through build-cars' carErs, so cut exactly as the build cuts it). The per-car solve of build-cars uses the
// profile model (js/raceline.js's speed profile), which has no battery, while the lap-time targets are laps WITH the
// battery deployed (as the calibration drives them). So the battery's share is measured here by driving: the season's
// standard car (the calibrated era physics of calibration.json) is driven by the node autopilot (driver.mjs, E held on
// full throttle above 100 km/h, the battery refilled only by harvesting: the calibration's laps) on every calibration
// circuit, once as it is and once with every battery of that season that differs from the standard one;
//     effect = mean over the circuits of (flying lap with that battery / the standard car's flying lap - 1), %
// (positive = slower). build-cars adds it to the profile delta of every car with that battery, so the chassis level
// absorbs it: a strong battery gets a weaker chassis, a car without KERS a stronger one, the lap time stays on target.
// The standard car's own laps are compared with calibration.json's (the same deterministic drive): a difference means
// js/car.js or the driver changed since the calibration.
// Writes devtests/seasons-calib/ers-effect.json (fingerprinted with calibration.json: build-cars refuses a stale file,
// and one without a battery some car has).
//   --check    re-run and compare with ers-effect.json (exit code 1 when it differs)
//   --jobs N   seasons driven in N child processes at once (default 4; the result does not depend on it)
//   years      only these seasons (prints, writes nothing)
//   --probe <year> <key> <track,track>   drive just that battery (a key of the file, e.g. 1.08/1.12/1 or none) and the
//              standard car on those circuits, print { stdLaps, perTrackPct } as JSON (test/cars.test.js: determinism)
// Deterministic: fixed 1/120 s step, no randomness, tyres off. About 12 min with --jobs 1 (64 variants x 40
// circuits, 0.27 s a lap), about 4 min with 4 jobs.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as B from '../../tools/build-cars.mjs';
import { driveLap, buildTracks } from './driver.mjs';

const args = process.argv.slice(2);
const CHECK = args.includes('--check'), CHILD = args.includes('--child'), pi = args.indexOf('--probe');
const ji = args.indexOf('--jobs'), JOBS = ji >= 0 ? Math.max(1, Math.min(16, parseInt(args[ji + 1], 10) || 1)) : 4;
const only = pi >= 0 ? [] : args.filter((a, i) => /^\d{4}$/.test(a) && args[i - 1] !== '--jobs').map(Number);
const t0 = Date.now();
const inp = B.loadInputs();
const calib = JSON.parse(readFileSync(B.CALIB_FILE, 'utf8'));
const combos = B.ersCombos(inp, calib);
const YEARS = [...new Set(combos.map(c => c.year))].filter(y => !only.length || only.includes(y));
const DEPLOY = { deploy: true };
const r6 = v => B.round(v, 6);

// one season: the standard car and every battery of that season that differs from it
function season(year, tracks) {
  const std = B.standardSpec(inp.eras, year, calib);
  const drive = spec => tracks.map(t => driveLap(t, spec, DEPLOY));
  const stdRuns = drive(std);
  const calLaps = year === B.CFG.ANCHOR ? calib.reference.laps : calib.seasons[year].laps;
  const calDiff = Math.max(...tracks.map((t, i) => Math.abs(stdRuns[i].flying - calLaps[t.id])));
  const off = runs => runs.filter(r => r.grass || r.hits || !(r.flying > 0)).length;
  const out = { stdLaps: Object.fromEntries(tracks.map((t, i) => [t.id, B.round(stdRuns[i].flying, 4)])), stdVsCalibrationMaxS: B.round(calDiff, 5),
    stdOffTrackRuns: off(stdRuns), combos: {} };
  for (const c of combos.filter(q => q.year === year)) {
    const m = { power: 1, drag: 1, downforce: 1, grip: 1, brake: 1, traction: 1, ersPower: c.ersPower, ersHarvest: c.ersHarvest, ersStore: c.ersStore };
    const runs = drive(B.applyWith(std, m, c.hasErs));
    const per = runs.map((r, i) => (r.flying / stdRuns[i].flying - 1) * 100);
    out.combos[c.key] = { hasErs: c.hasErs, ersPower: c.ersPower, ersHarvest: c.ersHarvest, ersStore: c.ersStore, cars: c.cars,
      meanPct: r6(B.mean(per)), medianPct: r6(B.median(per)), perTrackPct: Object.fromEntries(tracks.map((t, i) => [t.id, B.round(per[i], 4)])),
      offTrackRuns: off(runs) };
  }
  return out;
}

if (pi >= 0) {
  // one battery on a few circuits, exactly as season() drives it
  const year = Number(args[pi + 1]), key = args[pi + 2], ids = String(args[pi + 3] || '').split(',').filter(Boolean);
  const c = combos.find(q => q.year === year && q.key === key);
  if (!c || !ids.length) { console.error('--probe: no battery ' + year + ' ' + key + ' (or no circuits)'); process.exit(2); }
  const tracks = buildTracks(ids), std = B.standardSpec(inp.eras, year, calib);
  const m = { power: 1, drag: 1, downforce: 1, grip: 1, brake: 1, traction: 1, ersPower: c.ersPower, ersHarvest: c.ersHarvest, ersStore: c.ersStore };
  const s = tracks.map(t => driveLap(t, std, DEPLOY)), r = tracks.map(t => driveLap(t, B.applyWith(std, m, c.hasErs), DEPLOY));
  process.stdout.write(JSON.stringify({ stdLaps: Object.fromEntries(tracks.map((t, i) => [t.id, B.round(s[i].flying, 4)])),
    perTrackPct: Object.fromEntries(tracks.map((t, i) => [t.id, B.round((r[i].flying / s[i].flying - 1) * 100, 4)])) }) + '\n');
} else if (CHILD) {
  // a child: the seasons on the command line, as JSON on stdout
  const tracks = buildTracks(B.trackIds()), res = {};
  for (const y of YEARS) res[y] = season(y, tracks);
  process.stdout.write(JSON.stringify(res));
} else {
  // seasons spread over the jobs by their number of drives (largest first)
  const groups = Array.from({ length: Math.min(JOBS, YEARS.length) }, () => ({ years: [], n: 0 }));
  for (const y of YEARS.slice().sort((a, b) => combos.filter(c => c.year === b).length - combos.filter(c => c.year === a).length || a - b)) {
    const g = groups.reduce((p, q) => q.n < p.n ? q : p);
    g.years.push(y); g.n += 1 + combos.filter(c => c.year === y).length;
  }
  console.log('ers-effect: ' + combos.filter(c => YEARS.includes(c.year)).length + ' batteries in ' + YEARS.length + ' seasons, ' + B.trackIds().length + ' circuits, ' + groups.length + ' job(s): ' +
    groups.map(g => g.years.join(',')).join(' | '));
  const self = fileURLToPath(import.meta.url);
  const runChild = g => new Promise((res, rej) => {
    const p = spawn(process.execPath, [self, '--child', ...g.years.map(String)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let s = '';
    p.stdout.on('data', d => { s += d; });
    p.on('error', rej);
    p.on('close', code => { if (code) rej(new Error('child ' + g.years.join(',') + ' exited ' + code)); else { try { res(JSON.parse(s)); } catch (e) { rej(e); } } });
  });
  const parts = await Promise.all(groups.map(runChild));
  const seasons = {};
  for (const y of YEARS) seasons[y] = parts.find(p => p[y])[y];
  let warn = 0;
  for (const y of YEARS) {
    const s = seasons[y];
    if (s.stdVsCalibrationMaxS > 0.001) { warn++; console.log('WARNING ' + y + ': the standard car laps up to ' + s.stdVsCalibrationMaxS + ' s away from calibration.json (js/car.js or the driver changed? re-run calibrate.mjs)'); }
    if (s.stdOffTrackRuns) { warn++; console.log('WARNING ' + y + ': the standard car left the road ' + s.stdOffTrackRuns + 'x'); }
    console.log(y + '  standard car: laps as calibrated (max ' + s.stdVsCalibrationMaxS.toFixed(5) + ' s)');
    for (const [k, c] of Object.entries(s.combos)) {
      if (c.offTrackRuns) { warn++; console.log('WARNING ' + y + ' ' + k + ': off the road ' + c.offTrackRuns + 'x'); }
      console.log('      ' + (c.hasErs ? 'deploy ' + c.ersPower + ' harvest ' + c.ersHarvest + ' store ' + c.ersStore : 'no battery').padEnd(40) +
        ' lap ' + (c.meanPct >= 0 ? '+' : '') + c.meanPct.toFixed(3) + ' % (median ' + (c.medianPct >= 0 ? '+' : '') + c.medianPct.toFixed(3) + ' %)  ' + c.cars.map(id => id.slice(5)).join(', '));
    }
  }
  const out = { generatedBy: 'devtests/seasons-calib/ers-effect.mjs', fingerprint: B.ersEffectFingerprint(calib), calibrationFingerprint: calib.fingerprint,
    method: 'the season\'s standard car (calibration.json) driven by devtests/seasons-calib/driver.mjs deploying the battery (E held on full throttle above 100 km/h, refilled only by harvesting), 120 Hz, flying lap = best of laps 2..3, on every calibration circuit; once as it is and once with each battery of tools/ers-data.json (as tools/build-cars.mjs carErs cuts it) that differs from it; meanPct = mean over the circuits of (lap with that battery / the standard car\'s - 1) x 100',
    hz: 120, tracks: B.trackIds(), seasons };
  const text = JSON.stringify(out, null, 1) + '\n';
  if (CHECK) {
    const old = existsSync(B.ERS_EFFECT_FILE) ? readFileSync(B.ERS_EFFECT_FILE, 'utf8') : '';
    const same = !only.length && old === text;
    console.log(only.length ? '(only some seasons: nothing compared)' : (same ? 'ers-effect.json up to date' : 'ers-effect.json DIFFERS'));
    if (!same && !only.length) process.exitCode = 1;
  } else if (only.length) console.log('(only some seasons: nothing written)');
  else { writeFileSync(B.ERS_EFFECT_FILE, text); console.log('wrote ' + relative(B.ROOT, B.ERS_EFFECT_FILE).replace(/\\/g, '/') + (warn ? '  (' + warn + ' warning(s))' : '')); }
  console.log('(' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
}
