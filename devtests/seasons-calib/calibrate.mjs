// node devtests/seasons-calib/calibrate.mjs [--profile] [--check] [years...]
//
// The DRIVEN calibration of the era physics (tools/build-cars.mjs, METHOD A): for every season the standard car is
// driven by the node autopilot (js/car.js, the racing line built for that car: F1.buildRaceLine(track, car.perf)) on
// the calibration circuits (every circuit of tracks-data.js), and its era GRIP SCALE (downforce, mechanical lateral grip and braking grip together,
// on top of the eras.json priors: tools/build-cars.mjs METHOD A) is solved so that the MEDIAN over the circuits of
//     flying lap of the season's standard car / flying lap of the 2025 standard car (= F1.REF_SPEC)
// equals the season's era pace index (tools/seasons-raw.json; within +-0.03 %, the task allows +-0.3 %).
// For the KERS (2011-2013) and 2026 seasons the ERS harvest is then solved so that the energy a flying lap could
// recover (battery kept empty: never full, no deploy) is the rules' per-lap budget in stores: KERS 0.4 MJ / 0.4 MJ = 1,
// 2026 8.5 MJ / 4 MJ = 2.125 (median over the circuits).
// Writes devtests/seasons-calib/calibration.json (read by tools/build-cars.mjs, which refuses a stale one).
//   --profile   only the profile-model solve (no driving): quick look at the numbers, writes nothing
//   --check     re-run and compare with calibration.json (exit code 1 when a number differs)
//   years       only these seasons (writes nothing)
// Deterministic: fixed 1/120 s step, no randomness, tyres off (grip 1 = a new medium set), no boost, no limiter.
// About 8..12 min (40 circuits).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import * as B from '../../tools/build-cars.mjs';
import { driveLap, buildTracks } from './driver.mjs';

const args = process.argv.slice(2);
const PROFILE = args.includes('--profile'), CHECK = args.includes('--check');
const only = args.filter(a => /^\d{4}$/.test(a)).map(Number);
const G = B.loadGame();
const { raw, eras } = B.loadInputs();
const R = G.REF_SPEC;
const YEARS = [];
for (let y = B.CFG.FIRST; y <= B.CFG.LAST; y++) if (!only.length || only.includes(y)) YEARS.push(y);
const indexOf = y => raw.seasons.find(s => s.year === y).eraIndex;
const TOL = 0.0003;                    // |driven median ratio - index| (the task: 0.3 %)
const t0 = Date.now();

// ---- profile model (quick, for the start value) ----------------------------------------------------------------------
const geos = B.geometries();
const refProfile = geos.map(g => g.refLapTime);
function profileRatio(year, df) {
  const spec = Object.assign({}, R, B.eraSpec(eras, year, df, R.ers.harvest)), p = G.carPerf(spec);
  return B.median(geos.map((g, i) => B.profileLap(g, p) / refProfile[i]));
}
function solveProfile(year) {
  const idx = indexOf(year);
  let lo = Math.log(0.2), hi = Math.log(4);
  for (let it = 0; it < 40; it++) {
    const mid = 0.5 * (lo + hi);
    if (profileRatio(year, Math.exp(mid)) > idx) lo = mid; else hi = mid;    // more grip = faster
  }
  return Math.exp(0.5 * (lo + hi));
}

if (PROFILE) {
  console.log('profile model only: grip scale for the era index (median over ' + geos.length + ' circuits)');
  for (const y of YEARS) {
    const f = B.eraFactors(eras, y), df = y === B.CFG.ANCHOR ? 1 : solveProfile(y);
    const e = B.eraSpec(eras, y, df, R.ers.harvest), p = G.carPerf(Object.assign({}, R, e));
    console.log(y + '  index ' + indexOf(y).toFixed(4) + '  power x' + f.power.toFixed(3) + ' traction x' + f.traction.toFixed(3) + ' drag x' + f.drag.toFixed(3) +
      ' top ' + (p.topSpeed * 3.6).toFixed(1) + ' mech x' + f.mech.toFixed(3) + ' latMax x' + f.latMax.toFixed(3) + ' downforce prior x' + f.downforce.toFixed(3) + '  -> grip scale x' + df.toFixed(3) + ' (downforce x' + (f.downforce*df).toFixed(3) + ', latBase x' + (f.mech*df).toFixed(3) + ')' +
      ' (ratio ' + profileRatio(y, df).toFixed(4) + ')');
  }
  process.exit(0);
}

// ---- driving ------------------------------------------------------------------------------------------------------------
const tracks = buildTracks(B.trackIds());
function driveAll(spec, opts) { return tracks.map(t => driveLap(t, spec, opts)); }
const refRuns = driveAll(R);
const refLaps = refRuns.map(r => r.flying);
refRuns.forEach((r, i) => { if (r.grass || r.hits || !(r.flying > 0)) console.log('WARNING reference car off the road on ' + tracks[i].id); });
function drivenRatio(year, df, harvest) {
  const spec = Object.assign({}, R, B.eraSpec(eras, year, df, harvest));
  const runs = driveAll(spec);
  const ratios = runs.map((r, i) => r.flying / refLaps[i]);
  return { spec, runs, ratios, median: B.median(ratios), off: runs.filter(r => r.grass || r.hits || !(r.flying > 0)).length };
}

// ERS: potential harvest of a flying lap as a function of the harvest cap H (W/kg), from one probe drive per track
function ersSolve(year, df) {
  const H_PROBE = 10 * R.ers.harvest;                          // F1.sanitizeSpec's ceiling for ers.harvest
  const spec = Object.assign({}, R, B.eraSpec(eras, year, df, H_PROBE));
  const probes = driveAll(spec, { harvestProbe: true });
  const store = spec.ers.store, target = B.ersLapTarget(eras, year);
  const energyAt = (pr, H) => {
    let e = 0;
    for (let k = 0; k < pr.brakeP.length; k++) e += Math.min(H, pr.brakeP[k]) * pr.dt;
    return e + pr.liftT * B_LIFT * H;
  };
  const fracAt = H => B.median(probes.map(pr => energyAt(pr.probe, H) / store));
  // ceiling: a team multiplier (up to CFG.MAX) must keep it inside F1.sanitizeSpec's 10 x the reference, else the
  // car would silently get the reference's harvest
  const H_CAP = Math.floor(10 * R.ers.harvest / B.CFG.MAX);
  let H;
  if (fracAt(H_CAP) < target) H = H_CAP;
  else {
    let lo = 1, hi = H_CAP;
    for (let it = 0; it < 60; it++) { const mid = Math.sqrt(lo * hi); if (fracAt(mid) < target) lo = mid; else hi = mid; }
    H = B.sig(Math.sqrt(lo * hi));
  }
  // verification: drive again with that harvest, the battery kept empty
  const specH = Object.assign({}, R, B.eraSpec(eras, year, df, H));
  const ver = driveAll(specH, { harvestProbe: true });
  const clipped = probes.reduce((n, pr) => n + pr.probe.clipped, 0);
  return { harvest: H, capped: H === H_CAP, cap: H_CAP, target, predicted: fracAt(H), measured: B.median(ver.map(v => v.probe.energy / specH.ers.store)),
    perTrack: ver.map(v => B.round(v.probe.energy / specH.ers.store, 3)), clippedProbeSteps: clipped, spec: specH };
}
const B_LIFT = 0.12;                   // js/car.js ERS_LIFT: lift-off harvests this share of ers.harvest

// reference car's own potential harvest (for the documentation: what 2014-2025 recover)
const refProbe = driveAll(R, { harvestProbe: true }).map(v => v.probe.energy / R.ers.store);

const out = {
  generatedBy: 'devtests/seasons-calib/calibrate.mjs', fingerprint: B.priorsFingerprint(eras, raw),
  method: 'standard car driven by the keyboard racing-line autopilot (devtests/seasons-calib/driver.mjs, 120 Hz, flying lap = best of laps 2..3), era grip scale solved so that the median over the circuits of the lap ratio to the 2025 standard car (F1.REF_SPEC) equals the era pace index; ERS harvest of KERS / 2026 solved for the per-lap recovery budget (battery kept empty)',
  hz: 120, tracks: B.trackIds(), tolerance: TOL,
  reference: { laps: Object.fromEntries(tracks.map((t, i) => [t.id, B.round(refLaps[i], 4)])), ersLapFraction: B.round(B.median(refProbe), 4),
    ersLapFractionPerTrack: refProbe.map(v => B.round(v, 3)) },
  seasons: {}
};
console.log('reference (2025 standard = F1.REF_SPEC) flying laps: ' + tracks.map((t, i) => t.id + ' ' + refLaps[i].toFixed(3)).join(', '));
console.log('reference ERS: a flying lap could recover ' + (B.median(refProbe) * 100).toFixed(1) + ' % of the store (median; ' + refProbe.map(v => (v * 100).toFixed(0)).join(' ') + ')');
for (const year of YEARS) {
  const idx = indexOf(year);
  let rec;
  if (year === B.CFG.ANCHOR) {
    rec = { index: idx, gripScale: 1, ersHarvest: null, drivenMedian: 1, iterations: 0, profileStart: 1, off: 0, ratios: refLaps.map(() => 1), laps: refLaps };
  } else {
    // secant on log(grip scale), started from the profile model's solution
    let x0 = Math.log(B.sig(solveProfile(year))), d0 = drivenRatio(year, Math.exp(x0), R.ers.harvest);
    let best = { x: x0, d: d0 }, it = 1;
    let x1 = x0 + 0.05 * (d0.median > idx ? 1 : -1), d1 = null;
    while (Math.abs(best.d.median - idx) > TOL && it < 12) {
      d1 = drivenRatio(year, B.sig(Math.exp(x1)), R.ers.harvest); it++;
      if (Math.abs(d1.median - idx) < Math.abs(best.d.median - idx)) best = { x: x1, d: d1 };
      if (Math.abs(d1.median - idx) <= TOL) break;
      const slope = (d1.median - d0.median) / (x1 - x0);
      const xn = Math.abs(slope) > 1e-9 ? x1 - (d1.median - idx) / slope : x1 + 0.02;
      x0 = x1; d0 = d1; x1 = Math.max(Math.log(0.2), Math.min(Math.log(4), xn));
    }
    const df = B.sig(Math.exp(best.x));
    rec = { index: idx, gripScale: df, ersHarvest: null, drivenMedian: best.d.median, iterations: it, profileStart: B.round(solveProfile(year), 5),
      off: best.d.off, ratios: best.d.ratios, laps: best.d.runs.map(r => r.flying) };
    if (Math.abs(best.d.median - idx) > TOL) console.log('WARNING ' + year + ': driven median ' + best.d.median.toFixed(5) + ' misses the index ' + idx + ' by more than ' + TOL);
  }
  let ers = null;
  if (B.ersCalibrated(eras, year)) {
    const s = ersSolve(year, rec.gripScale);
    rec.ersHarvest = s.harvest;
    const p = G.carPerf(s.spec);
    ers = { store: s.spec.ers.store, power: s.spec.ers.power, harvest: s.harvest, harvestCapped: s.capped, harvestCap: s.cap,
      lapTarget: s.target, lapPredicted: B.round(s.predicted, 4),
      lapMeasured: B.round(s.measured, 4), perTrack: s.perTrack, deploySeconds: B.round(s.spec.ers.store / s.spec.ers.power, 2),
      topBoostKmh: B.round(p.topSpeedBoost * 3.6, 1), clippedProbeSteps: s.clippedProbeSteps };
  }
  const spec = Object.assign({}, R, B.eraSpec(eras, year, rec.gripScale, rec.ersHarvest === null ? R.ers.harvest : rec.ersHarvest));
  const p = G.carPerf(spec);
  out.seasons[year] = {
    index: idx, gripScale: rec.gripScale, ersHarvest: rec.ersHarvest,
    drivenMedian: B.round(rec.drivenMedian, 5), drivenMean: B.round(B.mean(rec.ratios), 5), profileStart: rec.profileStart, iterations: rec.iterations,
    offTrackRuns: rec.off,
    ratios: Object.fromEntries(tracks.map((t, i) => [t.id, B.round(rec.ratios[i], 5)])),
    laps: Object.fromEntries(tracks.map((t, i) => [t.id, B.round(rec.laps[i], 4)])),
    physics: { power: spec.power, dragK: spec.dragK, downforce: spec.downforce, latBase: spec.latBase, latMax: spec.latMax, brakeBase: spec.brakeBase,
      traction: spec.traction, topKmh: B.round(p.topSpeed * 3.6, 1), topBoostKmh: B.round(p.topSpeedBoost * 3.6, 1) },
    ers
  };
  const s = out.seasons[year];
  console.log(year + '  index ' + idx.toFixed(4) + '  driven ' + s.drivenMedian.toFixed(4) + ' (mean ' + s.drivenMean.toFixed(4) + ', ' + s.iterations + ' drives of ' + tracks.length + ')' +
    '  grip scale x' + s.gripScale.toFixed(4) + ' (profile start ' + (rec.profileStart || 1).toFixed(3) + ')  top ' + s.physics.topKmh + ' km/h' +
    (ers ? '  ERS harvest ' + ers.harvest + ' W/kg' + (ers.harvestCapped ? ' (CAP)' : '') + ': lap ' + ers.lapMeasured + ' stores (target ' + ers.lapTarget + ')' : '') + (rec.off ? '  OFF-TRACK ' + rec.off : ''));
}
const text = JSON.stringify(out, null, 1) + '\n';
if (CHECK) {
  const old = existsSync(B.CALIB_FILE) ? readFileSync(B.CALIB_FILE, 'utf8') : '';
  const same = old === text;
  console.log(same ? 'calibration.json up to date' : 'calibration.json DIFFERS');
  if (!same) process.exitCode = 1;
} else if (only.length) console.log('(only some seasons: nothing written)');
else { writeFileSync(B.CALIB_FILE, text); console.log('wrote ' + relative(B.ROOT, B.CALIB_FILE).replace(/\\/g, '/')); }
console.log('(' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
