// devtests/audio-test/ears.js - the second reviewer's independent analysis of the rendered scenes (node, no deps).
//   node devtests/audio-test/ears.js [backend=worklet] [--png]      (reads out/<backend>/*.wav + .json)
// Writes out/<backend>/ears-report.json and, with --png, spectrograms to out/<backend>/png/. Exit code 1 when a
// check fails. Every threshold is written next to the check; the ground truth is the scene's own timeline (the
// scene simulator's drivetrain / geometry, not what the module reports).
'use strict';
const fs = require('fs'), path = require('path');
const L = require('./dsp-lib');
const args = process.argv.slice(2);
const BACKEND = args.find(a => !a.startsWith('--')) || 'worklet';   // (worklet | nodes)
const PNG = args.includes('--png');
const DIRARG = args.find(a => a.startsWith('--dir='));
const DIR = DIRARG ? DIRARG.slice(6) : path.join(__dirname, 'out', BACKEND);          // --dir=<folder>: analyse renders elsewhere (e.g. of another build)
const C = 343;
const report = { backend: BACKEND, checks: [], data: {} };
let fails = 0;
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail });
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
function info(s) { console.log('     ' + s); }
const f1 = x => (+x).toFixed(1), f2 = x => (+x).toFixed(2), f3 = x => (+x).toFixed(3);
function have(name) { return fs.existsSync(path.join(DIR, name + '.wav')); }
function load(name) {
  const w = L.readWav(path.join(DIR, name + '.wav'));
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); } catch (e) {}
  w.mono = L.mono(w); w.meta = meta; w.name = name;
  if (meta) { const ix = {}; meta.cols.forEach((c, i) => ix[c] = i); w.col = (c, t) => { const r = meta.rows; let i = Math.round(t * meta.fps); i = Math.max(0, Math.min(r.length - 1, i)); return r[i][ix[c]]; }; w.ix = ix; }
  return w;
}
function series(w, c) { return w.meta.rows.map(r => r[w.ix[c]]); }

// ------------------------------------------------------------------ 1. integrity of every file
function integrity(w) {
  let pk = 0, clip = 0;
  const dc = [];
  for (const x of w.ch) {
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; if (a >= 32766 / 32768) clip++; }
    let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; dc.push(s / x.length);
  }
  // infrasound: energy below 20 Hz (a 2nd-order low-pass at 20 Hz, twice) as RMS dBFS after the first half second
  let lp1 = 0, lp2 = 0, lp3 = 0, lp4 = 0, e = 0, n = 0; const k = 1 - Math.exp(-2 * Math.PI * 20 / w.sr), x0 = w.mono;
  for (let i = 0; i < x0.length; i++) { lp1 += (x0[i] - lp1) * k; lp2 += (lp1 - lp2) * k; lp3 += (lp2 - lp3) * k; lp4 += (lp3 - lp4) * k; if (i > w.sr / 2) { e += lp4 * lp4; n++; } }
  const tp = Math.max(...w.ch.map(x => L.truePeak(x)));
  return { peakDb: L.db(pk), truePeakDb: L.db(tp), clipped: clip, dcDb: L.db(Math.max(...dc.map(Math.abs))), infraDb: L.db(Math.sqrt(e / Math.max(n, 1))) };
}

// clicks, method A: short-time energy of the second difference against its running median (a click is a burst of
// HF that the surrounding signal does not have). Returns [{ t, ratioDb }] of local maxima above thrDb.
function clicksA(x, sr, thrDb) {
  const WIN = 24, HOP = 12, n = Math.floor((x.length - WIN - 2) / HOP), E = new Float64Array(n);
  for (let k = 0; k < n; k++) { let s = 0; const a = k * HOP + 2; for (let i = a; i < a + WIN; i++) { const d = x[i] - 2 * x[i - 1] + x[i - 2]; s += d * d; } E[k] = s / WIN; }
  const out = [], R = 100, buf = new Float64Array(64);
  for (let k = 0; k < n; k++) {
    let m = 0;
    for (let j = k - R; j <= k + R; j += 4) { if (j < 0 || j >= n || Math.abs(j - k) < 8) continue; buf[m++] = E[j]; }
    if (!m) continue;
    const s = buf.subarray(0, m).sort(), med = s[m >> 1];
    const r = 10 * Math.log10((E[k] + 1e-24) / (med + 1e-24));
    if (r > thrDb && E[k] > 1e-11 && (k === 0 || E[k] >= E[k - 1]) && (k === n - 1 || E[k] >= E[k + 1])) out.push({ t: (k * HOP + WIN / 2) / sr, ratioDb: r });
  }
  // keep the strongest per 20 ms
  const kept = [];
  for (const c of out) { const l = kept[kept.length - 1]; if (l && c.t - l.t < 0.02) { if (c.ratioDb > l.ratioDb) kept[kept.length - 1] = c; } else kept.push(c); }
  return kept;
}
// clicks, method B: spectral splatter above 13 kHz (the synth puts nothing there on purpose) per 5.3 ms frame,
// relative to the file's median -> [{ t, riseDb, hfDb }]
function clicksB(x, sr, riseDb) {
  const N = 256, H = 128, nfft = 256, frames = Math.floor((x.length - N) / H), hf = new Float64Array(frames), k13 = Math.ceil(13000 * nfft / sr);
  const P = new Float64Array(nfft / 2 + 1), tot = new Float64Array(frames), share = [];
  for (let f = 0; f < frames; f++) { L.powerSpec(x, f * H, N, nfft, P); let s = 0, t = 0; for (let k = 1; k < P.length; k++) { t += P[k]; if (k >= k13) s += P[k]; } hf[f] = s; tot[f] = t; if (10 * Math.log10(t * 4 / (N * N) + 1e-30) > -70) share.push(s / t); }
  const med = share.length ? Math.max(L.median(share), 1e-9) : 1e-9, out = [];
  for (let f = 1; f < frames - 1; f++) {
    const r = 10 * Math.log10((hf[f] / Math.max(tot[f], 1e-30) + 1e-30) / med), abs = 10 * Math.log10(hf[f] * 4 / (N * N) + 1e-30);
    if (r > riseDb && abs > -75 && hf[f] >= hf[f - 1] && hf[f] >= hf[f + 1]) out.push({ t: (f * H + N / 2) / sr, riseDb: r, hfDb: abs });
  }
  return out;
}
// level steps: RMS over 1 ms windows; the largest change between neighbours inside [t0, t1] (dB), ignoring windows
// below floorDb
function levelSteps(x, sr, t0, t1, floorDb) {
  const W = Math.round(sr / 200), a = Math.max(W, Math.round(t0 * sr)), b = Math.min(x.length - W, Math.round(t1 * sr));
  let worst = 0, at = 0;
  for (let i = a; i < b; i += W >> 2) {
    const l = L.db(L.rms(x, i, i + W)), prev = L.db(L.rms(x, i - W, i));
    if (l > floorDb && prev > floorDb) { const d = Math.abs(l - prev); if (d > worst) { worst = d; at = i / sr; } }
  }
  return { worstDb: worst, at };
}
// typical neighbour-to-neighbour change of the 1 ms RMS in a steady stretch (the noise of the measure itself)
function stepNoise(x, sr, t0, t1) {
  const W = Math.round(sr / 200), d = [];
  for (let i = Math.round(t0 * sr) + W; i < Math.round(t1 * sr) - W; i += W >> 2) d.push(Math.abs(L.db(L.rms(x, i, i + W)) - L.db(L.rms(x, i - W, i))));
  return { p99: L.pct(d, 0.99), max: Math.max(...d) };
}

// pitch track: strongest peak in [lo(t), hi(t)] every hop s; win samples, nfft zero padding
function track(x, sr, t0, t1, hop, win, band) {
  const nfft = Math.max(16384, win * 4), P = new Float64Array(nfft / 2 + 1), out = [];
  for (let t = t0; t <= t1; t += hop) {
    const b = band(t); if (!b) continue;
    L.powerSpec(x, Math.round(t * sr) - win / 2, win, nfft, P);
    const p = L.peakIn(P, sr, nfft, b[0], b[1]);
    if (p) out.push({ t, f: p.f, a: L.ampOfPeak(p.p, win) });
  }
  return out;
}
// amplitudes of the engine orders in a steady stretch: order m of the cycle frequency fc (rpm / 120)
function orderTable(x, sr, t0, t1, fc, maxOrder) {
  // power spectrum averaged over 8192-sample frames (5.9 Hz bins: a partial whose pitch wanders by the engine's jitter
  // stays within +-3 bins), half overlapping
  const nfft = 8192, P = new Float64Array(nfft / 2 + 1), Q = new Float64Array(nfft / 2 + 1), bin = sr / nfft, amps = [];
  for (let s0 = Math.round(t0 * sr); s0 + nfft <= Math.round(t1 * sr); s0 += nfft / 2) { L.powerSpec(x, s0, nfft, nfft, Q); for (let k = 0; k < P.length; k++) P[k] += Q[k]; }
  let tot = 0, harm = 0;
  for (let k = 1; k < P.length; k++) tot += P[k];
  const used = new Uint8Array(P.length);
  for (let m = 1; m <= maxOrder; m++) {
    const f = m * fc; if (f > sr * 0.45) break;
    const k = Math.round(f / bin); let best = 0, s = 0;
    for (let j = k - 3; j <= k + 3; j++) if (j > 0 && j < P.length) { if (P[j] > best) best = P[j]; if (!used[j]) { s += P[j]; used[j] = 1; } }
    harm += s;
    amps.push({ m, f, db: 10 * Math.log10(best + 1e-30) });
  }
  // noise: everything not within +-3 bins of an order, as power spectral density
  let noise = 0, nb = 0; for (let k = 1; k < P.length; k++) if (!used[k] && k * bin > 60 && k * bin < 12000) { noise += P[k]; nb++; }
  // spectral centroid (60 Hz .. 12 kHz) and band levels
  let cs = 0, cw = 0; const bands = [[60, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000], [8000, 16000]].map(b => ({ b, e: 0 }));
  for (let k = 1; k < P.length; k++) { const f = k * bin; if (f >= 60 && f <= 12000) { cs += f * P[k]; cw += P[k]; } for (const B of bands) if (f >= B.b[0] && f < B.b[1]) B.e += P[k]; }
  const ref = Math.max(...amps.map(a => a.db));
  return { amps: amps.map(a => ({ m: a.m, f: a.f, rel: a.db - ref })), hnrDb: 10 * Math.log10(harm / Math.max(tot - harm, 1e-30)), centroid: cs / cw,
    bandsDb: bands.map(B => ({ band: B.b.join('-'), db: 10 * Math.log10(B.e / tot + 1e-30) })) };
}
function spectrumSlope(bandsDb) {                         // dB per octave between the 500-1k and the 4-8k bands (per-Hz density)
  const g = n => bandsDb.find(b => b.band === n).db;
  return (g('4000-8000') - 10 * Math.log10(4000 / 500) - g('500-1000')) / 3;
}

// ------------------------------------------------------------------ run
const files = [];
(function walk(d, rel) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'png') walk(p, rel + f + '/'); } else if (f.endsWith('.wav')) files.push(rel + f.slice(0, -4)); } })(DIR, '');
console.log('ears.js: ' + files.length + ' files in ' + DIR + '\n');

// 1. integrity + clicks for every file
console.log('== integrity: clipping, true peak, DC, clicks (every file) ==');
const EVENT_TYPES_OK = /pop|thump|hit|beep|light|go|crack|pitgun|jack|limiter|grass|shift|wheelgun|flat|oneshot|vib/;
let worstPeak = -200, worstTP = -200, worstDC = -200, worstInfra = -200, infraFile = '', totalClip = 0;
const clickRows = [];
for (const name of files) {
  const w = load(name), it = integrity(w);
  worstPeak = Math.max(worstPeak, it.peakDb); worstTP = Math.max(worstTP, it.truePeakDb); worstDC = Math.max(worstDC, it.dcDb); totalClip += it.clipped; if (it.infraDb > worstInfra) { worstInfra = it.infraDb; infraFile = name; }
  // clicks on each channel
  const cA = [], cB = [];
  for (const x of w.ch) { cA.push(...clicksA(x, w.sr, 14)); for (const c of clicksB(x, w.sr, 20)) if (!cB.some(d => Math.abs(d.t - c.t) < 0.01)) cB.push(c); }
  cB.sort((a, b) => a.t - b.t);
  report.data['integrity:' + name] = Object.assign(it, { clicksA: cA.length, clicksB: cB.length });
  // gear changes of the truth count as events (the upshift crack is a transient on purpose)
  const evs = w.meta ? w.meta.events.slice() : [];
  if (w.meta && w.ix.gear !== undefined) { const R = w.meta.rows, gi = w.ix.gear; for (let i = 1; i < R.length; i++) if (R[i][gi] !== R[i - 1][gi] && R[i][gi] >= 1 && R[i - 1][gi] >= 1) evs.push({ type: 'shift', t0: i / w.meta.fps, t1: i / w.meta.fps }); }
  clickRows.push({ name, it, cA, cB, w: w.meta ? { rows: w.meta.rows.length, events: evs } : null });
}
info('worst sample peak ' + f2(worstPeak) + ' dBFS, worst true peak ' + f2(worstTP) + ' dBFS, clipped samples ' + totalClip + ', worst DC (whole file) ' + f1(worstDC) + ' dBFS, worst infrasound (< 20 Hz) ' + f1(worstInfra) + ' dBFS in ' + infraFile);
check('no clipping: true peak below -0.5 dBFS in every file, no full-scale samples', worstTP < -0.5 && totalClip === 0, f2(worstTP) + ' dBFS');
check('no DC: below -60 dBFS over the whole file', worstDC < -60, f1(worstDC) + ' dBFS');
check('no infrasound wasting headroom: content below 20 Hz under -45 dBFS RMS in every file', worstInfra < -45, f1(worstInfra) + ' dBFS (' + infraFile + ')');
report.data.clickCandidates = clickRows.map(r => ({ name: r.name, A: r.cA.slice(0, 12).map(c => f3(c.t) + 's/' + f1(c.ratioDb)), B: r.cB.slice(0, 12).map(c => f3(c.t) + 's/' + f1(c.riseDb)) }));

// ------------------------------------------------------------------ 2. timbre of the own engine
console.log('\n== timbre: harmonic structure of the own engine (stems) ==');
const timbre = {};
function timbreOf(name, label) {
  if (!have(name)) return null;
  const w = load(name), t0 = 1.0, t1 = Math.min(w.n / w.sr - 0.1, 3.0), rpm = w.col('rpm', 2), cyl = w.ix.cyl !== undefined ? w.col('cyl', 2) : 6;
  const T = orderTable(w.mono, w.sr, t0, t1, rpm / 120, 400), lv = L.levels(w.mono, w.sr, t0, t1);
  const fire = T.amps.filter(a => a.m % cyl === 0).slice(0, 10).map(a => Math.round(a.rel));
  const half = T.amps.filter(a => a.m % cyl === cyl / 2).slice(0, 6).map(a => Math.round(a.rel));
  const crank = T.amps.filter(a => a.m % (cyl / 2) !== 0 && a.m < 2 * cyl).map(a => Math.round(a.rel));
  // how many firing harmonics lie within 30 dB of the strongest
  const rich = T.amps.filter(a => a.m % cyl === 0 && a.rel > -30).length;
  // crest factor and firing-rate amplitude fluctuation (roughness)
  let pk = 0; for (let i = Math.round(t0 * w.sr); i < Math.round(t1 * w.sr); i++) pk = Math.max(pk, Math.abs(w.mono[i]));
  const r = { label, rpm: Math.round(rpm), fireHz: f1(rpm * cyl / 120), dB: f1(lv.dB), dBA: f1(lv.dBA), centroidHz: Math.round(T.centroid), hnrDb: rpm / 120 > 60 ? f1(T.hnrDb) : 'n/a (orders too dense)',
    fireHarmonicsDb: fire, halfOrdersDb: half, crankOrdersDb: crank, richness: rich, slopeDbPerOct: f1(spectrumSlope(T.bandsDb)), crestDb: f1(L.db(pk / lv.rms)),
    bands: T.bandsDb.map(b => b.band + ':' + f1(b.db)).join(' ') };
  timbre[name] = r;
  info(label.padEnd(34) + JSON.stringify(r));
  return r;
}
const tTop = timbreOf('stems/g_top.engine', '330 km/h flat out (V6)'), tMid = timbreOf('stems/g_mid.engine', '150 km/h flat out (V6)'),
  tOver = timbreOf('stems/g_overrun.engine', '250 km/h throttle closed (V6)'), tIdle = timbreOf('stems/g_idle.engine', 'idle (V6)');
const tV8 = timbreOf('stems/g_v8.engine', '300 km/h flat out (V8, 2012 spec)'), tV8o = timbreOf('stems/g_v8over.engine', '250 km/h closed (V8)');
report.data.timbre = timbre;
if (tMid && tOver) {
  check('on throttle is harmonically rich: at least 8 firing harmonics within 30 dB of the strongest (150 km/h)', tMid.richness >= 8, tMid.richness);
  check('on throttle vs overrun: brighter (centroid ' + tMid.centroidHz + ' vs ' + tOver.centroidHz + ' Hz) and louder (' + tMid.dB + ' vs ' + tOver.dB + ' dBFS)', tMid.centroidHz > tOver.centroidHz * 1.3 && tMid.dB - tOver.dB > 6);
  check('not a toy oscillator: half orders present (strongest half order within 20 dB of the strongest partial)', Math.max(...tMid.halfOrdersDb) > -20, tMid.halfOrdersDb);
  check('the harmonics dominate the noise bed on throttle (harmonic / rest > 3 dB) but it is not a pure tone (< 25 dB)', +tMid.hnrDb > 3 && +tMid.hnrDb < 25, tMid.hnrDb + ' dB');
  check('the spectrum falls towards the top (4-8 kHz density at least 3 dB / octave below 0.5-1 kHz)', +tMid.slopeDbPerOct < -3, tMid.slopeDbPerOct + ' dB/oct');
}
if (tIdle) {
  check('idle audible: engine stem at idle above -45 dBFS', +tIdle.dB > -45, tIdle.dB + ' dBFS');
  // steady: level of 50 ms windows and the firing pitch of 85 ms frames over 2 s
  const w = load('stems/g_idle.engine'), sr = w.sr, lv = [], pc = [];
  for (let t = 1; t < 3; t += 0.05) lv.push(L.db(L.rms(w.mono, Math.round(t * sr), Math.round((t + 0.05) * sr))));
  const tr = track(w.mono, sr, 1, 3, 0.05, 4096, () => [180, 220]);
  for (const p of tr) pc.push(1200 * Math.log2(p.f / 200));
  const sd = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); };
  report.data.idle = { levelSdDb: f2(sd(lv)), pitchSdCents: f1(sd(pc)), meanPitchHz: f2(200 * Math.pow(2, pc.reduce((s, x) => s + x, 0) / pc.length / 1200)) };
  info('idle: ' + JSON.stringify(report.data.idle));
  check('idle is steady (50 ms level s.d. under 1.5 dB, pitch s.d. under 15 cents) and at 4000 rpm / 20 = 200 Hz', sd(lv) < 1.5 && sd(pc) < 15 && Math.abs(+report.data.idle.meanPitchHz - 200) < 1);
}

// ------------------------------------------------------------------ 3. pitch tracking, gear changes (a_launch)
console.log('\n== pitch tracking through the gears (a_launch, full mix) ==');
function pitchScene(name) {
  if (!have(name)) return null;
  const w = load(name), sr = w.sr, cyl = w.ix.cyl !== undefined ? w.col('cyl', 1) : 6, dur = w.n / sr;
  const fire = t => w.col('rpm', t) * cyl / 120, gear = t => w.col('gear', t);
  // exclude 120 ms around every gear change of the truth, and the idle / standing parts (throttle 0)
  const shifts = []; const R = w.meta.rows, gi = w.ix.gear;
  for (let i = 1; i < R.length; i++) if (R[i][gi] !== R[i - 1][gi] && R[i - 1][gi] >= 1 && R[i][gi] >= 1) shifts.push({ t: i / w.meta.fps, from: R[i - 1][gi], to: R[i][gi] });
  const near = t => shifts.some(s => Math.abs(t - s.t) < 0.12);
  // lag: the synthesiser smooths the rpm (~20 ms); find the lag that fits best, report errors with it and without
  const tr = track(w.mono, sr, 0.5, dur - 0.5, 0.01, 2048, t => { const f = fire(t); return f > 0 ? [f * 0.85, f * 1.15] : null; });
  const best = { lag: 0, med: 1 };
  for (let lag = 0; lag <= 0.06; lag += 0.005) {
    const e = tr.filter(p => !near(p.t) && w.col('thr', p.t) > 0.5).map(p => Math.abs(p.f / fire(p.t - lag) - 1));
    const m = L.median(e); if (m < best.med) { best.med = m; best.lag = lag; }
  }
  const errs = tr.filter(p => !near(p.t) && w.col('thr', p.t) > 0.5).map(p => Math.abs(p.f / fire(p.t - best.lag) - 1));
  const errs0 = tr.filter(p => !near(p.t) && w.col('thr', p.t) > 0.5).map(p => Math.abs(p.f / fire(p.t) - 1));
  // is the firing partial the strongest thing between 100 Hz and 2 kHz? (so the ear hears that pitch)
  const P = new Float64Array(8193); let strongest = 0, tot = 0;
  for (const p of tr) {
    if (near(p.t) || w.col('thr', p.t) < 0.5) continue;
    L.powerSpec(w.mono, Math.round(p.t * sr) - 1024, 2048, 16384, P);
    const q = L.peakIn(P, sr, 16384, 100, 2000); tot++;
    if (q && Math.abs(q.f / p.f - 1) < 0.03) strongest++;
  }
  // every upshift: pitch just before vs just after, expected ratio from the truth; level dip during the cut
  const sh = shifts.map(s => {
    const before = track(w.mono, sr, s.t - 0.09, s.t - 0.05, 0.01, 2048, t => [fire(t) * 0.85, fire(t) * 1.15]);
    const after = track(w.mono, sr, s.t + 0.10, s.t + 0.14, 0.01, 2048, t => [fire(t) * 0.85, fire(t) * 1.15]);
    const fb = L.median(before.map(p => p.f)), fa = L.median(after.map(p => p.f));
    const want = fire(s.t + 0.12) / fire(s.t - 0.07);
    // envelope: 5 ms RMS minimum in the 80 ms after the change vs the 40 ms before
    const ref = L.rms(w.mono, Math.round((s.t - 0.06) * sr), Math.round((s.t - 0.02) * sr));
    let mn = 1e9; for (let t = s.t; t < s.t + 0.08; t += 0.0025) mn = Math.min(mn, L.rms(w.mono, Math.round(t * sr), Math.round((t + 0.005) * sr)));
    return { t: f2(s.t), gears: s.from + '>' + s.to, pitchRatio: f3(fa / fb), want: f3(want), dipDb: f1(L.db(mn / ref)) };
  });
  return { name, cyl, frames: errs.length, lagMs: Math.round(best.lag * 1000), medPct: L.median(errs) * 100, p95Pct: L.pct(errs, 0.95) * 100, maxPct: Math.max(...errs) * 100,
    med0Pct: L.median(errs0) * 100, p950Pct: L.pct(errs0, 0.95) * 100, strongestShare: strongest / Math.max(tot, 1), shifts: sh };
}
for (const nm of ['a_launch', 'a_minimal', 'fps/a_launch.30fps', 'fps/a_launch.144fps', 'a_v8launch']) {
  const r = pitchScene(nm); if (!r) continue;
  report.data['pitch:' + nm] = r;
  info(nm + ': ' + r.frames + ' frames, best lag ' + r.lagMs + ' ms: median ' + f2(r.medPct) + ' %, 95 % ' + f2(r.p95Pct) + ' %, worst ' + f2(r.maxPct) + ' % (no lag: ' + f2(r.med0Pct) + ' / ' + f2(r.p950Pct) + ' %); firing partial strongest 100 Hz-2 kHz in ' + f1(r.strongestShare * 100) + ' % of frames');
  const ups = r.shifts.filter(s => +s.pitchRatio < 1 || +s.want < 1);
  for (const s of r.shifts) info('   shift ' + s.gears.padEnd(5) + ' at ' + s.t + ' s: pitch x' + s.pitchRatio + ' (truth x' + s.want + '), level dip ' + s.dipDb + ' dB');
  check(nm + ': pitch tracks the firing frequency (median < 0.5 %, 95 % < 2 %)', r.medPct < 0.5 && r.p95Pct < 2);
  const upsh = r.shifts.filter(s => +s.want < 0.98);
  check(nm + ': every upshift drops the pitch as the gearbox says (within 3 %) and dips the level by at least 4 dB', upsh.length > 0 && upsh.every(s => Math.abs(+s.pitchRatio / +s.want - 1) < 0.03 && +s.dipDb < -4),
    upsh.map(s => s.gears + ':' + s.pitchRatio + '/' + s.want + '/' + s.dipDb).join(' '));
}

// ------------------------------------------------------------------ 4. remote cars
console.log('\n== remote cars ==');
// 4a. pass-by: Doppler against theory, smoothness, panning
(function () {
  const nm = have('stems/c_passby.remote') ? 'stems/c_passby.remote' : null; if (!nm) return;
  const w = load(nm), sr = w.sr, V = 300 / 3.6;
  const want = t => w.col('f0', t) * w.col('dop', t);
  const tr = track(w.mono, sr, 0.3, 5.7, 0.005, 2048, t => [want(t) * 0.8, want(t) * 1.25]);
  const e = tr.map(p => p.f / want(p.t) - 1);
  const far = tr.filter(p => Math.abs(w.col('rz', p.t)) > 80);
  const eFar = far.map(p => Math.abs(p.f / want(p.t) - 1));
  const app = L.median(tr.filter(p => p.t < 1.2).map(p => p.f)), rec = L.median(tr.filter(p => p.t > 4.8).map(p => p.f));
  const theory = (C + V) / (C - V);
  // monotonic fall through the pass, and roughness: second difference of the pitch trace (Hz per 5 ms step^2)
  const sm5 = tr.map((p, i) => L.median(tr.slice(Math.max(0, i - 4), i + 5).map(q => q.f)));
  let rises = 0; for (let i = 8; i < sm5.length; i += 8) if (Math.abs(w.col('rz', tr[i].t)) < 100 && sm5[i] > sm5[i - 8] * 1.003) rises++;
  // pan: L-R level per 20 ms
  const pan = []; for (let t = 0.3; t < 5.7; t += 0.02) { const a = Math.round(t * sr), b = a + Math.round(0.02 * sr); pan.push({ t, d: L.db(L.rms(w.ch[0], a, b)) - L.db(L.rms(w.ch[1], a, b)) }); }
  let maxJump = 0; for (let i = 1; i < pan.length - 1; i++) maxJump = Math.max(maxJump, Math.abs(pan[i].d - 0.5 * (pan[i - 1].d + pan[i + 1].d)));
  const cross = pan.find(p => p.d < 0);
  const tClosest = 250 / V;
  const r = { approachHz: f1(app), recedeHz: f1(rec), ratio: f3(app / rec), theory: f3(theory), farErrMaxPct: f2(Math.max(...eFar) * 100), rises, panStartDb: f1(pan[0].d), panEndDb: f1(pan[pan.length - 1].d),
    panCrossMsAfterClosest: cross ? Math.round((cross.t - tClosest) * 1000) : null, panMaxStepDb: f1(maxJump) };
  report.data.passby = r; info('pass-by 300 km/h at 5 m: ' + JSON.stringify(r));
  check('Doppler: approach / recede ratio within 1 % of (c + v) / (c - v) = ' + f3(theory), Math.abs(app / rec / theory - 1) < 0.01, f3(app / rec));
  check('Doppler: pitch within 1 % of theory while the car is more than 80 m away', Math.max(...eFar) < 0.01, f2(Math.max(...eFar) * 100) + ' %');
  check('Doppler: pitch never rises during the pass (monotonic within 100 m, 5-point median)', rises === 0, rises);
  check('pan: left before, right after (or the reverse), smooth (no 20 ms value more than 2 dB off the line through its neighbours)', Math.abs(pan[0].d) > 10 && Math.abs(pan[pan.length - 1].d) > 10 && Math.sign(pan[0].d) !== Math.sign(pan[pan.length - 1].d) && maxJump < 2, f1(maxJump) + ' dB');
})();
// 4b. network-rate pass: speed / heading from 20 Hz snapshots, position interpolated per frame
(function () {
  let control = null;
  for (const nm of ['stems/l_netexact.remote', 'stems/l_net20.remote', 'stems/l_netlin.remote']) {
    if (!have(nm)) continue;
    const w = load(nm), sr = w.sr, want = t => w.col('f0', t) * w.col('dop', t);
    const tr = track(w.mono, sr, 0.5, w.n / sr - 0.5, 0.0025, 1536, t => [want(t) * 0.85, want(t) * 1.18]);
    // pitch trace in cents, detrended with a 150 ms moving average; flutter = RMS of what is left (cents), and
    // the share of that flutter's energy near 20 Hz
    const R = w.meta.rows, gi = w.ix.rgear, gch = [];
    for (let i = 1; i < R.length; i++) if (R[i][gi] !== R[i - 1][gi]) gch.push(i / w.meta.fps);
    const dop = t => w.col('dop', t), sweep = t => Math.abs(dop(t + 0.05) - dop(t - 0.05)) > 0.01;
    const keep = p => !gch.some(g => p.t > g - 0.1 && p.t < g + 0.45) && !sweep(p.t);           // (the audio follows the reported speed 0.1 .. 0.3 s late)
    const c = tr.map(p => 1200 * Math.log2(p.f));
    const sm = c.map((_, i) => { let s = 0, n = 0; for (let j = i - 30; j <= i + 30; j++) if (j >= 0 && j < c.length) { s += c[j]; n++; } return s / n; });
    const res = c.map((x, i) => x - sm[i]).filter((x, i) => i >= 40 && i < c.length - 40 && keep(tr[i]) && keep(tr[Math.max(0, i - 30)]) && keep(tr[Math.min(tr.length - 1, i + 30)]));
    const fl = Math.sqrt(res.reduce((s, x) => s + x * x, 0) / res.length);
    let nfft = 1; while (nfft < res.length) nfft <<= 1;
    const re = new Float64Array(nfft), im = new Float64Array(nfft); res.forEach((x, i) => re[i] = x); L.fft(re, im);
    const fs_ = 1 / 0.0025; let e20 = 0, eAll = 0;
    for (let k = 1; k < nfft / 2; k++) { const f = k * fs_ / nfft, p = re[k] * re[k] + im[k] * im[k]; if (f > 5) { eAll += p; if (Math.abs(f - 20) < 3 || Math.abs(f - 40) < 3 || Math.abs(f - 60) < 3) e20 += p; } }
    const r = { flutterCents: f2(fl), share20HzPct: f1(100 * e20 / eAll) };
    const z20 = fl * Math.sqrt(e20 / eAll);                      // the part of the flutter at the snapshot rate and its multiples
    r.at20HzCents = f2(z20);
    report.data['net:' + nm] = r; info(nm + ': ' + JSON.stringify(r));
    if (nm.indexOf('exact') >= 0) { control = { fl, z20 }; continue; }
    const extra = Math.sqrt(Math.max(0, z20 * z20 - (control ? control.z20 * control.z20 : 0)));
    check(nm + ': no zipper from 20 Hz snapshots (flutter at 20 / 40 / 60 Hz beyond the exact-every-frame control: ' + f2(extra) + ' cents RMS, limit 2; total flutter ' + f2(fl) + ' vs control ' + (control ? f2(control.fl) : '?') + ' cents)', extra < 2);
  }
})();
// 4c. teleport: no glide between the pitches before and after
(function () {
  const nm = 'stems/d_teleport.remote'; if (!have(nm)) return;
  const w = load(nm), sr = w.sr, want = t => w.col('f0', t) * w.col('dop', t), ev = w.meta.events.filter(e => e.type === 'teleport');
  let bad = 0, audible = 0;
  for (const e of ev) {
    const fb = want(e.t0 - 0.02), fa = want(e.t0 + 0.02), lvlRef = L.rms(w.mono, Math.round((e.t0 - 0.1) * sr), Math.round(e.t0 * sr));
    const tr = track(w.mono, sr, e.t0 - 0.05, e.t0 + 0.6, 0.005, 1024, () => [Math.min(fa, fb) * 0.5, Math.max(fa, fb) * 1.5]);
    for (const p of tr) {
      const l = L.rms(w.mono, Math.round(p.t * sr) - 512, Math.round(p.t * sr) + 512);
      if (l < lvlRef * 0.1) continue;                         // 20 dB down: inaudible under the rest
      audible++;
      if (Math.abs(p.f / fb - 1) > 0.03 && Math.abs(p.f / fa - 1) > 0.03 && Math.abs(p.f / (fa / 2) - 1) > 0.03 && Math.abs(p.f / (fb / 2) - 1) > 0.03 && Math.abs(p.f / (fa * 1.5) - 1) > 0.03 && Math.abs(p.f / (fb * 1.5) - 1) > 0.03) bad++;
    }
  }
  report.data.teleport = { audible, offPitch: bad };
  check('teleport: no screech (audible frames off both the old and new pitch: ' + bad + ' of ' + audible + ')', bad <= Math.max(1, audible * 0.03));
})();
// 4d. packs: voices never above MAX_VOICES; clicks / level steps at voice changes
for (const nm of ['d_pack', 'd_pack16']) {
  if (!have('stems/' + nm + '.remote')) continue;
  const w = load('stems/' + nm + '.remote'), sr = w.sr, v = series(w, 'm_voices'), maxV = Math.max(...v), MAXV = w.meta.info.MAX_VOICES;
  // voice-change instants: m_voices changes or a new id in the voice table (not logged) -> use changes of the count
  const changes = [], ss = series(w, 'm_starts'); for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1] || ss[i] !== ss[i - 1]) changes.push(i / w.meta.fps);
  const cl = clickRows.find(r => r.name === 'stems/' + nm + '.remote');
  const noise = stepNoise(w.mono, sr, 1, w.n / sr - 1);
  let worst = 0; for (const t of changes) worst = Math.max(worst, levelSteps(w.mono, sr, t - 0.05, t + 0.4, -70).worstDb);
  const st = series(w, 'm_starts'), sl = series(w, 'm_steals');
  report.data['pack:' + nm] = { maxVoices: maxV, voiceStarts: st[st.length - 1], steals: sl[sl.length - 1], changes: changes.length, worstStepDb: f1(worst), stepNoiseP99: f1(noise.p99), clicksA: cl.cA.length, clicksB: cl.cB.length };
  info(nm + ': ' + JSON.stringify(report.data['pack:' + nm]));
  check(nm + ': at most MAX_VOICES (' + MAXV + ') voices at once', maxV <= MAXV, maxV);
  check(nm + ': voice changes are smooth (largest 1 ms level step near a change ' + f1(worst) + ' dB, steady-state 99 % ' + f1(noise.p99) + ' dB; click candidates ' + cl.cA.length + ' / ' + cl.cB.length + ')',
    worst < Math.max(6, noise.max + 1) && cl.cB.length === 0);
}
// 4e. level against distance
(function () {
  const nm = 'stems/h_distance.remote'; if (!have(nm)) return;
  const w = load(nm), sr = w.sr, out = [];
  let ref = null;
  for (const d of [10, 20, 40, 60, 100, 150, 200, 250, 290, 310]) {
    const rs = series(w, 'dist'); let i = rs.findIndex(x => x >= d); if (i < 0) continue;
    const t = i / w.meta.fps, l = L.levels(w.mono, sr, t - 0.15, t + 0.15);
    if (d === 10) ref = l.dB;
    out.push({ d, dB: l.dB });
  }
  report.data.distance = out.map(o => ({ d: o.d, dB: f1(o.dB), rel10: ref !== null ? f1(o.dB - ref) : null }));
  info('level vs distance: ' + report.data.distance.map(o => o.d + 'm:' + o.dB).join('  '));
  const d310 = out.find(o => o.d === 310);
  check('a car beyond D_MAX is silent', !d310 || d310.dB < -90, d310 && f1(d310.dB));
  let mono = true; for (let i = 1; i < out.length; i++) if (out[i].dB > out[i - 1].dB + 0.5) mono = false;
  check('level falls monotonically with distance', mono);
})();

// ------------------------------------------------------------------ 5. level balance
console.log('\n== level balance (k_balance stems) ==');
(function () {
  if (!have('stems/k_balance.engine')) return;
  const E = load('stems/k_balance.engine'), A = load('stems/k_balance.aero'), R = load('stems/k_balance.remote'), sr = E.sr;
  const segs = E.meta.events.filter(e => e.type === 'segment'), rows = [];
  for (const s of segs) {
    const t0 = s.t0 + 0.8, t1 = s.t1 - 0.1;
    const e = L.levels(E.mono, sr, t0, t1), a = L.levels(A.mono, sr, t0, t1), r = L.levels(R.mono, sr, t0, t1);
    rows.push({ kmh: s.kmh, dist: s.dist, engine: f1(e.dB) + '/' + f1(e.dBA), wind: f1(a.dB) + '/' + f1(a.dBA), remote: f1(r.dB) + '/' + f1(r.dBA), windVsEngA: f1(a.dBA - e.dBA), remoteVsEngA: f1(r.dBA - e.dBA) });
  }
  report.data.balance = rows;
  for (const r of rows) info(JSON.stringify(r));
  const at = (k, d) => rows.find(r => r.kmh === k && r.dist === d);
  const w100 = at(100, 5), w330 = at(330, 5);
  if (w100 && w330) {
    check('wind well under the engine at 100 km/h (at least 10 dB(A))', +w100.windVsEngA < -10, w100.windVsEngA);
    check('engine still the loudest thing at 330 km/h (wind at least 1 dB(A) under it) but wind clearly there (within 12 dB(A))', +w330.windVsEngA < -1 && +w330.windVsEngA > -12, w330.windVsEngA);
  }
  const r5 = at(330, 5), r150 = at(200, 150);
  if (r5 && r150) {
    check('a remote car 5 m away flat out (330 km/h) is clearly there but under the own engine (-12 .. 0 dB(A))', +r5.remoteVsEngA < 0 && +r5.remoteVsEngA > -12, r5.remoteVsEngA);
    check('a remote car 150 m away is faint (at least 20 dB(A) under the own engine)', +r150.remoteVsEngA < -20, r150.remoteVsEngA);
  }
})();

// ------------------------------------------------------------------ 6. effects: limiter, beeps, fades, one-shots
console.log('\n== effects ==');
(function () {                                               // rev limiter stutter
  const nm = 'stems/b_lap.engine'; if (!have(nm)) return;
  const w = load(nm), sr = w.sr, ev = w.meta.events.find(e => e.type === 'limiter');
  const env = []; for (let t = ev.t0 + 0.2; t < ev.t1 - 0.05; t += 0.001) env.push(L.rms(w.mono, Math.round(t * sr), Math.round(t * sr) + 48));
  let nfft = 1; while (nfft < env.length * 4) nfft <<= 1;
  const re = new Float64Array(nfft), im = new Float64Array(nfft), m = env.reduce((s, x) => s + x, 0) / env.length;
  env.forEach((x, i) => re[i] = x - m); L.fft(re, im);
  let bk = 0, bp = 0; for (let k = 2; k < nfft / 2; k++) { const f = k * 1000 / nfft; if (f > 5 && f < 60) { const p = re[k] * re[k] + im[k] * im[k]; if (p > bp) { bp = p; bk = k; } } }
  const sorted = Float64Array.from(env).sort(), depth = L.db(sorted[Math.floor(env.length * 0.1)] / sorted[Math.floor(env.length * 0.9)]);
  report.data.limiter = { rateHz: f1(bk * 1000 / nfft), depthDb: f1(depth) };
  info('rev limiter: ' + JSON.stringify(report.data.limiter));
  check('rev limiter stutters (15-35 Hz, at least 8 dB deep)', bk * 1000 / nfft > 15 && bk * 1000 / nfft < 35 && depth < -8);
})();
(function () {                                               // pit limiter stutter
  const nm = 'stems/m_pit.engine'; if (!have(nm)) return;
  const w = load(nm), sr = w.sr, ev = w.meta.events.find(e => e.type === 'pitlimiter'); if (!ev) return;
  const env = []; for (let t = ev.t0 + 0.3; t < ev.t1 - 0.05; t += 0.001) env.push(L.rms(w.mono, Math.round(t * sr), Math.round(t * sr) + 48));
  let nfft = 1; while (nfft < env.length * 4) nfft <<= 1;
  const re = new Float64Array(nfft), im = new Float64Array(nfft), m = env.reduce((s, x) => s + x, 0) / env.length;
  env.forEach((x, i) => re[i] = x - m); L.fft(re, im);
  let bk = 0, bp = 0; for (let k = 2; k < nfft / 2; k++) { const f = k * 1000 / nfft; if (f > 3 && f < 60) { const p = re[k] * re[k] + im[k] * im[k]; if (p > bp) { bp = p; bk = k; } } }
  const sorted = Float64Array.from(env).sort(), depth = L.db(sorted[Math.floor(env.length * 0.1)] / sorted[Math.floor(env.length * 0.9)]);
  report.data.pitLimiter = { rateHz: f1(bk * 1000 / nfft), depthDb: f1(depth) };
  info('pit limiter: ' + JSON.stringify(report.data.pitLimiter));
  check('pit limiter stutters (slower than the rev limiter: 5-18 Hz, at least 6 dB deep)', bk * 1000 / nfft > 5 && bk * 1000 / nfft < 18 && depth < -6);
})();
(function () {                                               // beeps
  const nm = 'e_lights'; if (!have(nm)) return;
  const w = load(nm), sr = w.sr, ev = w.meta.events.filter(e => e.type === 'light' || e.type === 'go'), out = [];
  const nfft = 8192, P = new Float64Array(nfft / 2 + 1), Q = new Float64Array(nfft / 2 + 1);
  for (const e of ev) {
    const f = e.type === 'go' ? 1480 : 740;
    L.powerSpec(w.mono, Math.round((e.t0 + 0.03) * sr), 4096, nfft, P); L.powerSpec(w.mono, Math.round((e.t0 - 0.2) * sr), 4096, nfft, Q);
    const k = Math.round(f * nfft / sr); let a = 0, b = 0; for (let j = k - 3; j <= k + 3; j++) { a += P[j]; b += Q[j]; }
    // the beep against everything else in the frame (the whole mix, 200 Hz .. 5 kHz)
    let rest = 0; for (let j = Math.round(200 * nfft / sr); j < Math.round(5000 * nfft / sr); j++) if (Math.abs(j - k) > 3 && Math.abs(j - 2 * k) > 3) rest += P[j];
    // duration: 740 / 1480 Hz band level above -20 dB of its peak
    const tr = []; for (let t = e.t0 - 0.05; t < e.t0 + 0.8; t += 0.005) { L.powerSpec(w.mono, Math.round(t * sr), 512, 4096, Q); const kk = Math.round(f * 4096 / sr); tr.push({ t, p: Q[kk - 1] + Q[kk] + Q[kk + 1] }); }
    const pk = Math.max(...tr.map(x => x.p)), on = tr.filter(x => x.p > pk * 0.01);
    out.push({ type: e.type, t: e.t0, vsBeforeDb: f1(10 * Math.log10(a / Math.max(b, 1e-30))), vsRestDb: f1(10 * Math.log10(a / Math.max(rest, 1e-30))), onsetMs: Math.round((on[0].t - e.t0) * 1000), lenMs: Math.round((on[on.length - 1].t - on[0].t) * 1000) });
  }
  report.data.beeps = out; for (const o of out) info('beep ' + JSON.stringify(o));
  check('beeps cut through: each beep band rises at least 20 dB and holds at least -6 dB against the rest of the mix', out.length === 6 && out.every(o => +o.vsBeforeDb > 20 && +o.vsRestDb > -6), out.map(o => o.vsBeforeDb + '/' + o.vsRestDb).join(' '));
})();
(function () {                                               // mute / volume / setActive
  const nm = 'f_fades'; if (!have(nm)) return;
  const w = load(nm), sr = w.sr, ev = w.meta.events, noise = stepNoise(w.mono, sr, 0.3, 0.95), res = [];
  for (const e of ev) {
    if (e.type === 'unmute' || e.type === 'active') {             // from silence: 10 % -> 90 % of the level 0.4 s later must take >= 8 ms
      const fin = L.rms(w.mono, Math.round((e.t0 + 0.4) * sr), Math.round((e.t0 + 0.5) * sr)); let t10 = null, t90 = null;
      for (let t = e.t0; t < e.t0 + 0.5; t += 0.0005) { const l = L.rms(w.mono, Math.round(t * sr), Math.round((t + 0.005) * sr)); if (t10 === null && l > 0.1 * fin) t10 = t; if (t90 === null && l > 0.9 * fin) { t90 = t; break; } }
      res.push(e.type + ':rise' + Math.round(((t90 || 0) - (t10 || 0)) * 1000) + 'ms');
    } else { const s = levelSteps(w.mono, sr, e.t0 - 0.02, e.t0 + 0.4, -40); res.push(e.type + ':' + f1(s.worstDb)); }
  }
  const lv = t => L.db(L.rms(w.mono, Math.round(t * sr), Math.round((t + 0.05) * sr)));
  const r = { steady99: f1(noise.p99), steps: res, mute100ms: f1(lv(1.1) - lv(0.9)), muted: f1(lv(1.6)), vol05: f1(lv(3.5) - lv(2.7)), inactive: f1(lv(5.6)), reactive: f1(lv(7.5) - lv(2.7)) };
  report.data.fades = r; info('fades: ' + JSON.stringify(r));
  check('mute / volume / setActive glide (no 5 ms level step beyond the steady-state 99 % + 4 dB, fade-ins take >= 8 ms) and reach their targets', res.every(s => s.indexOf('rise') > 0 ? +s.split('rise')[1].replace('ms', '') >= 8 : +s.split(':')[1] < +noise.p99 + 4) && +r.muted < -90 && Math.abs(+r.vol05 + 12) < 1 && +r.inactive < -90 && Math.abs(+r.reactive) < 1, r);
})();
(function () {                                               // own-car one-shots and vibration (play(), state.vib)
  const nm = 'n_oneshots'; if (!have(nm)) return;
  const w = load(nm), sr = w.sr, ev = w.meta.events.filter(e => e.type.indexOf('play:') === 0), out = [];
  for (const e of ev) {
    const before = L.rms(w.mono, Math.round((e.t0 - 0.15) * sr), Math.round((e.t0 - 0.02) * sr));
    let pk = 0; for (let t = e.t0; t < e.t0 + 0.6; t += 0.01) pk = Math.max(pk, L.rms(w.mono, Math.round(t * sr), Math.round((t + 0.02) * sr)));
    out.push({ kind: e.type.slice(5), riseDb: f1(L.db(pk / Math.max(before, 1e-9))) });
  }
  report.data.oneshots = out; info('one-shots: ' + JSON.stringify(out));
  check('play() one-shots are heard (each at least 6 dB over what was there)', out.length >= 4 && out.every(o => +o.riseDb > 6), out.map(o => o.kind + ':' + o.riseDb).join(' '));
  const vib = w.meta.events.find(e => e.type === 'vib');
  if (vib) {
    // wheel-rate modulation of the low band
    const env = []; for (let t = vib.t0 + 0.3; t < vib.t1 - 0.05; t += 0.001) { const a = Math.round(t * sr); env.push(L.rms(w.mono, a, a + 48)); }
    let nfft = 1; while (nfft < env.length * 4) nfft <<= 1;
    const re = new Float64Array(nfft), im = new Float64Array(nfft), m = env.reduce((s, x) => s + x, 0) / env.length; env.forEach((x, i) => re[i] = x - m); L.fft(re, im);
    let bk = 0, bp = 0; for (let k = 2; k < nfft / 2; k++) { const f = k * 1000 / nfft; if (f > 5 && f < 60) { const p = re[k] * re[k] + im[k] * im[k]; if (p > bp) { bp = p; bk = k; } } }
    const want = vib.kmh / 3.6 / (Math.PI * 0.72);
    report.data.vib = { rateHz: f1(bk * 1000 / nfft), wheelHz: f1(want) };
    info('flat-spot vibration: ' + JSON.stringify(report.data.vib));
    check('flat-spot thump at the wheel frequency (within 15 %)', Math.abs(bk * 1000 / nfft / want - 1) < 0.15);
  }
})();

// ------------------------------------------------------------------ pumping: the master compressor's gain reduction
(function () {
  const rows = [];
  for (const name of files) {
    if (name.indexOf('stems/') === 0) continue;
    const w = load(name); if (!w.meta || w.ix.m_red === undefined) continue;
    const red = w.meta.rows.filter((r, i) => i / w.meta.fps > 1.5).map(r => r[w.ix.m_red]);
    if (!red.length) continue;
    rows.push({ name, maxDb: Math.min(...red), p5: L.pct(red, 0.05), p95: L.pct(red, 0.95) });
  }
  const worst = rows.reduce((a, r) => (r.maxDb < a.maxDb ? r : a), { maxDb: 0 });
  report.data.compressor = rows.map(r => r.name + ':' + f1(r.maxDb) + '(' + f1(r.p5) + '..' + f1(r.p95) + ')');
  info('compressor gain reduction after 1.5 s (dB, most / 5 % .. 95 %): ' + report.data.compressor.join('  '));
  check('no pumping: the master compressor never takes more than 3 dB (worst ' + worst.name + ' ' + f1(worst.maxDb) + ' dB)', worst.maxDb > -3);
})();

// ------------------------------------------------------------------ 7. click candidates (all files), with what happens there
console.log('\n== click candidates ==');
let unexplained = 0;
for (const r of clickRows) {
  if (!r.cB.length) continue;
  const w = r.w, evs = (w && w.events) || [];
  for (const c of r.cB) {
    const why = evs.find(e => c.t >= e.t0 - 0.03 && c.t <= (e.t1 || e.t0) + (e.type === 'shift' ? 0.08 : 0.6) && EVENT_TYPES_OK.test(e.type));
    if (!why) unexplained++;
    info(r.name.padEnd(34) + ' t=' + f3(c.t) + ' s  HF +' + f1(c.riseDb) + ' dB (' + f1(c.hfDb) + ' dBFS)  ' + (why ? '[' + why.type + ']' : 'UNEXPLAINED'));
  }
}
check('no unexplained broadband clicks in any file (energy above 13 kHz louder than -75 dBFS and 20 dB over the usual share of the file, away from one-shots / impacts / gear changes)', unexplained === 0, unexplained);

// ------------------------------------------------------------------ spectrograms
if (PNG) {
  const pdir = path.join(DIR, 'png'); fs.mkdirSync(pdir, { recursive: true });
  const jobs = [['a_launch', { fLo: 60, fHi: 12000, log: true }], ['a_launch', { fLo: 0, fHi: 6000, log: false, t0: 0, t1: 14, tag: '.lin' }], ['c_passby', { fLo: 60, fHi: 12000, log: true }],
    ['stems/c_passby.remote', { fLo: 60, fHi: 12000, log: true }], ['stems/g_mid.engine', { fLo: 0, fHi: 12000, log: false, win: 4096 }], ['stems/g_overrun.engine', { fLo: 0, fHi: 12000, log: false, win: 4096 }],
    ['a_v8launch', { fLo: 60, fHi: 12000, log: true }], ['b_lap', { fLo: 60, fHi: 12000, log: true }], ['stems/l_net20.remote', { fLo: 200, fHi: 2000, log: true }], ['m_pit', { fLo: 40, fHi: 8000, log: true }]];
  for (const [nm, o] of jobs) {
    if (!have(nm)) continue;
    const w = load(nm);
    fs.writeFileSync(path.join(pdir, nm.replace(/\//g, '_') + (o.tag || '') + '.png'), L.spectrogram(w.mono, w.sr, Object.assign({ W: 1400, H: 560 }, o)));
  }
  info('spectrograms -> ' + pdir);
}

fs.writeFileSync(path.join(DIR, 'ears-report.json'), JSON.stringify(report, null, 1));
console.log('\n' + (report.checks.length - fails) + ' / ' + report.checks.length + ' checks passed' + (fails ? '  (' + fails + ' FAILED)' : ''));
process.exit(fails ? 1 : 0);
