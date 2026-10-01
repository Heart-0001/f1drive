// NOTE (second review): this is the first author's analysis. The independent suite is ears.js (+ dsp-lib.js); this
// one is kept as a second opinion. Its gear-change rules predate the upshift crack of the v6 contract.
// Measures the WAV files written by render.js (own FFT, no dependencies) and fails on anything that would be heard
// as a fault.   node devtests/audio-test/analyze.js [worklet] [nodes] [--selftest] [--quiet]
//   exit code 1 when a check fails. --selftest: damages copies of the data (a click, a wrong pitch, clipping, DC) and
//   requires the checks to notice.
// What is measured:
//   pitch      strongest partial within +-10 % of the firing frequency rpm / 20 (rpm from the scene's own drivetrain
//              formula, not from the module) -> relative error; and whether that partial is the strongest one below 700 Hz
//   clicks     Everything the synthesiser makes on purpose stays below 12 kHz (partials) / 11 kHz (noise), so the band
//              above 17 kHz is empty unless a waveform or a gain jumps: its peak against the local level of the
//              signal is the size of the largest discontinuity ("hf"; the pass / fail criterion).
//              Also printed, not judged: the linear-prediction residual (order 24) against its own local RMS
//              ("lpc"). It reads 9..13 on the overrun pops, which are meant to be impulsive, and 13..15 on real
//              discontinuities (--selftest), so it cannot tell the two apart; the high band can (0.006 against > 0.1).
//   zipper     share of that high-band energy that repeats at the 60 Hz update rate (stepped parameters)
//   fades      largest change of level between neighbouring 2 ms windows around every transition
//   peaks      sample peak, 4x oversampled true peak, DC offset
//   Doppler    pitch of the remote car before / after the pass against c / (c -+ v); left / right balance
//   levels     RMS and A-weighted RMS of the stems (own engine, wind + road, remote car), level against distance
//   events     gear-change cut, limiter stutter, impact thumps, start beeps, ERS whine, tyre / grass noise, fades, silence
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, 'out');
const args = process.argv.slice(2), SELFTEST = args.indexOf('--selftest') >= 0, QUIET = args.indexOf('--quiet') >= 0;
const BACKENDS = args.filter(a => a[0] !== '-');
const results = [];
let prefix = '';
function check(name, ok, detail) {
  results.push({ name: prefix + name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + prefix + name + (detail !== undefined ? '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
function note(s) { if (!QUIET) console.log('     ' + s); }
const dB = x => 20 * Math.log10(Math.max(x, 1e-12));
const f1 = x => x.toFixed(1), f2 = x => x.toFixed(2), f3 = x => x.toFixed(3);

/* ---------------- files ---------------- */
function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), len = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + len);
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('not a 16-bit WAV: ' + file);
  const n = Math.floor(data.length / (2 * fmt.ch)), ch = [];
  for (let c = 0; c < fmt.ch; c++) {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = data.readInt16LE((i * fmt.ch + c) * 2) / 32767;
    ch.push(a);
  }
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) mono[i] = fmt.ch > 1 ? 0.5 * (ch[0][i] + ch[1][i]) : ch[0][i];
  return { sr: fmt.sr, ch, n, mono, L: ch[0], R: ch[fmt.ch > 1 ? 1 : 0] };
}
function load(dir, name) {
  const wavFile = path.join(dir, name + '.wav'), metaFile = path.join(dir, name + '.json');
  if (!fs.existsSync(wavFile) || !fs.existsSync(metaFile)) return null;
  const w = readWav(wavFile), m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  w.meta = m; w.name = name;
  w.col = c => m.cols.indexOf(c);
  // value of a timeline column at time t (linear between frames)
  w.at = (c, t) => {
    const rows = m.rows, k = typeof c === 'number' ? c : m.cols.indexOf(c);
    if (t <= rows[0][0]) return rows[0][k];
    let lo = 0, hi = rows.length - 1;
    if (t >= rows[hi][0]) return rows[hi][k];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid][0] <= t) lo = mid; else hi = mid; }
    const a = rows[lo], b = rows[hi];
    return a[k] + (b[k] - a[k]) * (t - a[0]) / (b[0] - a[0]);
  };
  // ... the value in force at time t (what the last update() before t was given)
  w.held = (c, t) => {
    const rows = m.rows, k = typeof c === 'number' ? c : m.cols.indexOf(c);
    let lo = 0, hi = rows.length - 1;
    if (t >= rows[hi][0]) return rows[hi][k];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid][0] <= t) lo = mid; else hi = mid; }
    return rows[lo][k];
  };
  return w;
}

/* ---------------- DSP ---------------- */
function makeFFT(N) {
  const rev = new Uint32Array(N), cs = new Float64Array(N / 2), sn = new Float64Array(N / 2), bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / N); sn[i] = -Math.sin(2 * Math.PI * i / N); }
  return function (re, im) {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let s = 0; s < N; s += size) for (let k = 0; k < half; k++) {
        const wr = cs[k * step], wi = sn[k * step], a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  };
}
const ffts = {}, hanns = {};
function hann(N) { if (!hanns[N]) { const h = new Float64Array(N); for (let i = 0; i < N; i++) h[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); hanns[N] = h; } return hanns[N]; }
// magnitude spectrum of N samples centred on sample c (amplitude of a sine reads as its amplitude)
function spectrum(x, c, N) {
  const fft = ffts[N] || (ffts[N] = makeFFT(N)), h = hann(N), re = new Float64Array(N), im = new Float64Array(N), s = Math.round(c - N / 2);
  for (let i = 0; i < N; i++) { const j = s + i; re[i] = j >= 0 && j < x.length ? x[j] * h[i] : 0; }
  fft(re, im);
  const mag = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * 4 / N;
  return mag;
}
// strongest spectral peak between fa and fb: frequency refined on the log-magnitude parabola
function peakIn(mag, sr, fa, fb) {
  const N = mag.length * 2, a = Math.max(2, Math.ceil(fa * N / sr)), b = Math.min(mag.length - 2, Math.floor(fb * N / sr));
  let k = -1, best = 0;
  for (let i = a; i <= b; i++) if (mag[i] > best && mag[i] >= mag[i - 1] && mag[i] >= mag[i + 1]) { best = mag[i]; k = i; }
  if (k < 0) return { f: 0, a: 0 };
  const l = Math.log(mag[k - 1] + 1e-15), c = Math.log(mag[k] + 1e-15), r = Math.log(mag[k + 1] + 1e-15), den = l - 2 * c + r;
  const d = den < 0 ? 0.5 * (l - r) / den : 0;
  return { f: (k + d) * sr / N, a: Math.exp(c - 0.25 * (l - r) * d) };
}
function rms(x, a, b) { a = Math.max(0, Math.round(a)); b = Math.min(x.length, Math.round(b)); let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }
function rmsT(w, x, t0, t1) { return rms(x, t0 * w.sr, t1 * w.sr); }
// power of both channels together (what equal-power panning keeps constant)
function rmsLR(w, t0, t1) { const a = rmsT(w, w.L, t0, t1), b = rmsT(w, w.R, t0, t1); return Math.sqrt((a * a + b * b) / 2); }
function peakAbs(x, a, b) { let p = 0, at = 0; a = Math.max(0, a | 0); b = Math.min(x.length, b === undefined ? x.length : b | 0); for (let i = a; i < b; i++) { const v = x[i] < 0 ? -x[i] : x[i]; if (v > p) { p = v; at = i; } } return { p, at }; }
function mean(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / Math.max(1, x.length); }
function quantile(a, q) { if (!a.length) return NaN; const s = Array.from(a).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
// A-weighted RMS of a stretch (through the spectrum of 16384-sample frames)
function aWeight(f) { const f2_ = f * f; const ra = (12194 * 12194 * f2_ * f2_) / ((f2_ + 20.6 * 20.6) * Math.sqrt((f2_ + 107.7 * 107.7) * (f2_ + 737.9 * 737.9)) * (f2_ + 12194 * 12194)); return ra * 1.2589; }
function rmsA(w, x, t0, t1) {
  const N = 16384, fft = ffts[N] || (ffts[N] = makeFFT(N)), h = hann(N);
  let acc = 0, cnt = 0;
  for (let s = Math.round(t0 * w.sr); s + N <= Math.round(t1 * w.sr); s += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * h[i];
    fft(re, im);
    let p = 0;
    for (let i = 1; i < N / 2; i++) { const a = aWeight(i * w.sr / N); p += (re[i] * re[i] + im[i] * im[i]) * a * a; }
    acc += p * 2 / (N * N * 0.375); cnt++;          // 0.375 = mean of hann^2
  }
  return cnt ? Math.sqrt(acc / cnt) : 0;
}
function rmsALR(w, t0, t1) { const a = rmsA(w, w.L, t0, t1), b = rmsA(w, w.R, t0, t1); return Math.sqrt((a * a + b * b) / 2); }
// true peak: 4x oversampling (windowed sinc, 32 taps) around the largest samples
function truePeak(x) {
  const n = x.length, top = [];
  let thr = 0;
  const pk = peakAbs(x).p;
  thr = pk * 0.85;
  for (let i = 0; i < n; i++) if (Math.abs(x[i]) >= thr) top.push(i);
  let best = pk;
  const step = Math.max(1, Math.floor(top.length / 4000));
  for (let q = 0; q < top.length; q += step) {
    const i = top[q];
    for (let sub = 1; sub < 4; sub++) {
      const t = i + sub / 4;
      let s = 0;
      for (let k = -15; k <= 16; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        const d = t - j, wdw = 0.5 + 0.5 * Math.cos(Math.PI * d / 16.5);
        s += x[j] * (d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d)) * wdw;
      }
      if (Math.abs(s) > best) best = Math.abs(s);
    }
  }
  return best;
}
// Click detector: AR(24) model per 2048-sample block -> prediction residual; a click is a residual sample far above
// the residual's RMS in the 512 samples around it. -> { ratio, t, list: [{t, ratio}] } (largest per 50 ms)
function clickScan(x, sr, floor) {
  const n = x.length, B = 2048, H = 1024, P = 24, e = new Float64Array(n), h = hann(B);
  const r = new Float64Array(P + 1), a = new Float64Array(P + 1), tmp = new Float64Array(P + 1), xw = new Float64Array(B);
  for (let s = 0; s + B <= n; s += H) {
    let en = 0;
    for (let i = 0; i < B; i++) { xw[i] = x[s + i] * h[i]; en += xw[i] * xw[i]; }
    if (en < 1e-9) continue;
    for (let k = 0; k <= P; k++) { let acc = 0; for (let i = k; i < B; i++) acc += xw[i] * xw[i - k]; r[k] = acc; }
    r[0] *= 1 + 1e-7;
    // Levinson-Durbin
    a.fill(0); a[0] = 1;
    let err = r[0];
    for (let i = 1; i <= P; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / err;
      for (let j = 1; j < i; j++) tmp[j] = a[j] + k * a[i - j];
      for (let j = 1; j < i; j++) a[j] = tmp[j];
      a[i] = k; err *= 1 - k * k;
      if (err <= 0) break;
    }
    const from = s === 0 ? P : s + H / 2, to = s + B >= n - H ? s + B : s + H / 2 + H;
    for (let i = from; i < to && i < n; i++) { let acc = x[i]; for (let j = 1; j <= P; j++) acc += a[j] * x[i - j]; e[i] = acc; }
  }
  const W = 256, pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + e[i] * e[i];
  floor = floor || 1e-4;
  let best = 0, at = 0;
  const list = [];
  let curBin = -1, curBest = 0, curAt = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(n, i + W), loc = Math.sqrt((pre[hi] - pre[lo]) / (hi - lo));
    const ratio = Math.abs(e[i]) / Math.max(loc, floor);
    if (ratio > best) { best = ratio; at = i; }
    const bin = Math.floor(i / (0.05 * sr));
    if (bin !== curBin) { if (curBest > 6) list.push({ t: curAt / sr, ratio: curBest }); curBin = bin; curBest = 0; }
    if (ratio > curBest) { curBest = ratio; curAt = i; }
  }
  if (curBest > 6) list.push({ t: curAt / sr, ratio: curBest });
  return { ratio: best, t: at / sr, list };
}
// High band: FIR high-pass (63 taps, stop band below 14.9 kHz, pass band above 19.1 kHz) -> peak of the high band
// against the RMS of the whole signal in the 512 samples around it (floor -60 dBFS), and how much of the high-band
// energy is locked to the update rate. -> { ratio, t, list, zip(t0, t1, hz), level }
let hpTaps = null;
function hfScan(x, sr, floor) {
  if (!hpTaps) {
    const taps = 63, c = (taps - 1) / 2, fc = 17000 / sr;
    hpTaps = new Float64Array(taps);
    let sum = 0;
    for (let n = 0; n < taps; n++) { const d = n - c, wdw = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (taps - 1)); hpTaps[n] = (d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d)) * wdw; sum += hpTaps[n]; }
    for (let n = 0; n < taps; n++) hpTaps[n] = -hpTaps[n] / sum;
    hpTaps[c] += 1;
  }
  const n = x.length, T = hpTaps.length, c = (T - 1) / 2, hp = new Float64Array(n), W = 256, pre = new Float64Array(n + 1);
  for (let i = c; i < n - c; i++) { let acc = 0; for (let k = 0; k < T; k++) acc += x[i - c + k] * hpTaps[k]; hp[i] = acc; }
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i] * x[i];
  floor = floor || 2e-3;
  let best = 0, at = 0, curBin = -1, curBest = 0, curAt = 0, e2 = 0;
  const list = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(n, i + W), loc = Math.sqrt((pre[hi] - pre[lo]) / (hi - lo)), ratio = Math.abs(hp[i]) / Math.max(loc, floor);
    e2 += hp[i] * hp[i];
    if (ratio > best) { best = ratio; at = i; }
    const bin = Math.floor(i / (0.05 * sr));
    if (bin !== curBin) { if (curBest > HF_MAX / 3) list.push({ t: curAt / sr, ratio: curBest }); curBin = bin; curBest = 0; }
    if (ratio > curBest) { curBest = ratio; curAt = i; }
  }
  if (curBest > HF_MAX / 3) list.push({ t: curAt / sr, ratio: curBest });
  return {
    ratio: best, t: at / sr, list, level: Math.sqrt(e2 / n), hp,
    zip: (t0, t1, hz) => { let a = 0, b = 0, p = 0; for (let i = Math.round(t0 * sr); i < t1 * sr && i < n; i++) { const v = hp[i] * hp[i], ph = 2 * Math.PI * hz * i / sr; a += v * Math.cos(ph); b += v * Math.sin(ph); p += v; } return p > 0 ? Math.hypot(a, b) / p : 0; }
  };
}
// Largest change of level (dB) between neighbouring 2 ms windows in t0..t1. Levels are floored at -26 dB re ref and
// a pair counts when one of the two is above -20 dB re ref: a gain switched on or off without a ramp reads 20..26 dB,
// a fade from or to silence reads what it does around -20 dB.
function maxStep(w, t0, t1, ref) {
  const W = Math.round(w.sr * 0.002), lo = ref * 0.05, need = ref * 0.1;
  let prev = -1, worst = 0, at = 0;
  for (let s0 = Math.round(t0 * w.sr); s0 + W <= t1 * w.sr && s0 + W <= w.n; s0 += W) {
    const a = rms(w.L, s0, s0 + W), b = rms(w.R, s0, s0 + W), v = Math.max(Math.sqrt((a * a + b * b) / 2), lo);
    if (prev >= 0 && Math.max(v, prev) > need) { const d = Math.abs(dB(v) - dB(prev)); if (d > worst) { worst = d; at = s0 / w.sr; } }
    prev = v;
  }
  return { step: worst, t: at };
}
const HF_MAX = 0.03;          // high-band peak / local signal RMS (--selftest: clean 0.006, a 1 dB gain step 0.024, a 6 dB step / phase jump / drop-out 0.12 .. 0.27)
const ZIP_MAX = 0.2;          // share of the high-band energy locked to 60 Hz
const STEP_MAX = 14;          // dB between neighbouring 2 ms windows (a gain switched without a ramp: > 30)

const PEAK_MAX = 0.95;        // sample peak (the soft clip's ceiling is 0.881)
const TRUE_PEAK_MAX = 0.99;
const DC_MAX = 0.002;

// the checks every file gets
function common(w, opts) {
  opts = opts || {};
  const pk = Math.max(peakAbs(w.L).p, peakAbs(w.R).p), tp = Math.max(truePeak(w.L), truePeak(w.R)), dc = Math.max(Math.abs(mean(w.L)), Math.abs(mean(w.R)));
  let run = 0, maxRun = 0;
  for (let i = 0; i < w.n; i++) { if (Math.abs(w.L[i]) >= 0.999 || Math.abs(w.R[i]) >= 0.999) { run++; if (run > maxRun) maxRun = run; } else run = 0; }
  check(w.name + ': no clipping (sample peak ' + f2(dB(pk)) + ' dBFS, true peak ' + f2(dB(tp)) + ' dBFS, samples at full scale ' + maxRun + ')', pk < PEAK_MAX && tp < TRUE_PEAK_MAX && maxRun === 0);
  check(w.name + ': no DC offset (' + dB(dc).toFixed(1) + ' dBFS)', dc < DC_MAX);
  const cl = [clickScan(w.L, w.sr), clickScan(w.R, w.sr)], worst = cl[0].ratio > cl[1].ratio ? cl[0] : cl[1];
  const hf = [hfScan(w.L, w.sr), hfScan(w.R, w.sr)], hw = hf[0].ratio > hf[1].ratio ? hf[0] : hf[1];
  w.hf = hf; w.lpc = cl;
  check(w.name + ': no clicks (hf: largest discontinuity ' + hw.ratio.toFixed(4) + ' x local RMS at ' + f3(hw.t) + ' s, limit ' + HF_MAX + '; band above 17 kHz at ' + f1(dB(Math.max(hf[0].level, hf[1].level))) +
    ' dBFS; lpc, not judged: ' + f2(worst.ratio) + ' at ' + f3(worst.t) + ' s)', hw.ratio < HF_MAX,
    hw.list.filter(c => c.ratio >= HF_MAX).slice(0, 8).map(c => f3(c.t) + 's:' + c.ratio.toFixed(3)).join(' ') || undefined);
  check(w.name + ': update() never threw, no NaN samples', w.meta.errors === 0 && w.meta.nan === 0, w.meta.lastError || undefined);
  return { peak: pk, truePeak: tp, dc, click: worst, hf: hw };
}

/* ---------------- pitch ---------------- */
// s: the synthesiser's pitch glide (2 x 10 ms) + half an update interval of hold (8 ms at 60 Hz)
const lagOf = w => 0.02 + 0.5 / (w.meta.fps || 60);
// -> { n, med, p95, max (relative errors against rpm(t - LAG) / 20), rawMed, rawP95 (against rpm(t) / 20), dominant }
function pitchTrack(w, x, t0, t1, opts) {
  opts = opts || {};
  const N = 4096, hop = Math.round(w.sr / 60), ci = w.col('rpm'), gi = w.col('gear'), rows = w.meta.rows, scale = opts.scale || 1, LAG = lagOf(w);
  const shifts = [];
  for (let i = 1; i < rows.length; i++) if (rows[i][gi] !== rows[i - 1][gi] || Math.abs(rows[i][ci] - rows[i - 1][ci]) > 600) shifts.push(rows[i][0]);
  const errs = [], raws = [], worst = [];
  let dom = 0, tot = 0;
  for (let c = Math.round(t0 * w.sr); c < t1 * w.sr; c += hop) {
    const t = c / w.sr;
    if (shifts.some(s => t > s - 0.06 && t < s + 0.11)) continue;
    const fe = w.at(ci, t - LAG) / 20 * scale, fr = w.at(ci, t) / 20 * scale;
    const mag = spectrum(x, c, N), p = peakIn(mag, w.sr, fe * 0.9, fe * 1.1);
    tot++;
    if (!(p.a > 1e-4)) { errs.push(1); raws.push(1); continue; }
    const err = Math.abs(p.f - fe) / fe;
    errs.push(err); raws.push(Math.abs(p.f - fr) / fr);
    if (err > 0.01) worst.push({ t: +t.toFixed(3), want: +fe.toFixed(1), got: +p.f.toFixed(1) });
    const d = peakIn(mag, w.sr, 150, 700);
    if (Math.abs(d.f - p.f) < 0.5 * w.sr / N * 2) dom++;
  }
  return { n: errs.length, med: quantile(errs, 0.5), p95: quantile(errs, 0.95), max: quantile(errs, 1), rawMed: quantile(raws, 0.5), rawP95: quantile(raws, 0.95), dominant: dom / Math.max(1, tot), worst: worst.slice(0, 6), shifts };
}
function pitchChecks(w, x, t0, t1, label, lim) {
  const p = pitchTrack(w, x, t0, t1);
  lim = lim || { med: 0.004, p95: 0.015 };
  check(w.name + ': ' + label + ' - fundamental tracks rpm / 20 (' + p.n + ' frames: median error ' + (p.med * 100).toFixed(3) + ' %, 95 % ' + (p.p95 * 100).toFixed(2) + ' %, worst ' + (p.max * 100).toFixed(2) +
    ' %; without the ' + Math.round(lagOf(w) * 1000) + ' ms lag allowance: median ' + (p.rawMed * 100).toFixed(2) + ' %, 95 % ' + (p.rawP95 * 100).toFixed(2) + ' %)', p.med < lim.med && p.p95 < lim.p95, p.p95 >= lim.p95 ? p.worst : undefined);
  check(w.name + ': ' + label + ' - the firing frequency is the strongest partial below 700 Hz in ' + (p.dominant * 100).toFixed(1) + ' % of the frames', p.dominant > 0.9);
  return p;
}
// level (dBFS, both channels) in short windows around a time: before / lowest after
function dipAt(w, t, span) {
  const before = rmsLR(w, t - 0.06, t - 0.01);
  let low = Infinity;
  for (let k = 0; k < span / 0.005; k++) { const v = rmsLR(w, t + k * 0.005, t + k * 0.005 + 0.012); if (v < low) low = v; }
  return dB(low) - dB(before);
}

/* ---------------- scenes ---------------- */
function sceneLaunch(dir, name, derived) {
  const w = load(dir, name); if (!w) return check(name + ': rendered', false);
  common(w);
  const p = pitchChecks(w, w.mono, 0.4, w.meta.dur - 0.3, derived ? 'pitch from the speed alone' : 'pitch');
  const gi = w.col('gear'), rows = w.meta.rows, ups = [], downs = [];
  for (let i = 1; i < rows.length; i++) { const a = rows[i - 1][gi], b = rows[i][gi]; if (a >= 1 && b > a) ups.push(rows[i][0]); if (b >= 1 && b < a) downs.push(rows[i][0]); }
  check(name + ': all eight gears used (' + ups.length + ' upshifts, ' + downs.length + ' downshifts, top speed ' + f1(Math.max.apply(null, rows.map(r => r[w.col('speed')])) * 3.6) + ' km/h)', ups.length === 7 && downs.length === 7);
  const dips = ups.map(t => dipAt(w, t, 0.09));
  check(name + ': every upshift has the ignition cut (level dip ' + dips.map(d => f1(d)).join(', ') + ' dB)', dips.every(d => d < -4));
  const shifts = ups.concat(downs), hfAt = (t0, t1) => { let m = 0; w.hf.forEach(h => { for (let i = Math.round(t0 * w.sr); i < t1 * w.sr; i++) { const v = Math.abs(h.hp[i]); if (v > m) m = v; } }); return m; };
  const worstHf = shifts.reduce((m, t) => Math.max(m, hfAt(t - 0.02, t + 0.15) / Math.max(rmsLR(w, t - 0.02, t + 0.15), 1e-3)), 0);
  const worstLpc = w.lpc[0].list.concat(w.lpc[1].list).filter(c => shifts.some(t => c.t > t - 0.02 && c.t < t + 0.15)).reduce((m, c) => Math.max(m, c.ratio), 0);
  const steps = shifts.map(t => maxStep(w, t - 0.02, t + 0.15, rmsLR(w, t - 0.1, t - 0.02)).step);
  check(name + ': no click at any of the ' + shifts.length + ' gear changes (hf: largest discontinuity there ' + worstHf.toFixed(4) + ' x the level, limit ' + HF_MAX + '; lpc: ' + (worstLpc ? f2(worstLpc) : 'nothing above 6') +
    '; largest level change in 2 ms ' + f1(Math.max.apply(null, steps)) + ' dB)', worstHf < HF_MAX && steps.every(x => x < STEP_MAX));
  const fps = w.meta.fps || 60, zipA = Math.max(w.hf[0].zip(1.2, 8, fps), w.hf[1].zip(1.2, 8, fps)), zipB = Math.max(w.hf[0].zip(1.2, 8, 47), w.hf[1].zip(1.2, 8, 47));
  check(name + ': pitch glides without zipper noise (1.2 .. 8 s, gears 1 to 4: ' + (zipA * 100).toFixed(1) + ' % of the energy above 17 kHz repeats at the ' + fps + ' Hz update rate; at 47 Hz, for comparison, ' + (zipB * 100).toFixed(1) + ' %)', zipA < ZIP_MAX);
  const idle = rmsLR(w, 0.4, 0.95), full = rmsLR(w, 20, 24), end = rmsLR(w, w.meta.dur - 1, w.meta.dur - 0.1);
  note('levels: idle ' + f1(dB(idle)) + ' dBFS, flat out at top speed ' + f1(dB(full)) + ' dBFS, idle after the stop ' + f1(dB(end)) + ' dBFS');
  check(name + ': idles when standing (level ' + f1(dB(idle)) + ' dBFS, pitch ' + f1(peakIn(spectrum(w.mono, 0.7 * w.sr, 8192), w.sr, 150, 700).f) + ' Hz = 4000 rpm / 20)',
    idle > 0.004 && idle < full * 0.5 && Math.abs(peakIn(spectrum(w.mono, 0.7 * w.sr, 8192), w.sr, 150, 700).f - 200) < 3);
  if (derived) {
    const ti = w.col('thr'), mi = w.col('m_thr'), g2 = w.col('m_gear'), r2 = w.col('m_rpm'), ri = w.col('rpm');
    let se = 0, gearBad = 0, rpmBad = 0;
    rows.forEach(r => { se += Math.abs(r[ti] - r[mi]); if (r[gi] !== r[g2]) gearBad++; if (Math.abs(r[ri] - r[r2]) > 1) rpmBad++; });
    check(name + ': gear and rpm derived from the speed equal the contract formula in every frame (gear differs in ' + gearBad + ', rpm in ' + rpmBad + ' of ' + rows.length + ')', gearBad === 0 && rpmBad === 0);
    check(name + ': throttle guessed from the acceleration (mean error ' + f3(se / rows.length) + ')', se / rows.length < 0.06);
  }
  return { w, p, ups, downs };
}

function sceneLap(dir) {
  const w = load(dir, 'b_lap'); if (!w) return check('b_lap: rendered', false);
  common(w);
  const ev = w.meta.events, T = w.meta.info.tuning;
  const eng = load(path.join(dir, 'stems'), 'b_lap.engine'), ers = load(path.join(dir, 'stems'), 'b_lap.ers'), sur = load(path.join(dir, 'stems'), 'b_lap.surface'), fx = load(path.join(dir, 'stems'), 'b_lap.fx');
  if (!eng || !ers || !sur || !fx) return check('b_lap: stems rendered', false);
  [eng, ers, sur, fx].forEach(s => { s.name = 'stems/' + s.name; });
  common(eng);
  // pitch on the engine stem, outside the limiter stretch (forced rpm) and the second impact (speed step)
  const lm = ev.filter(e => e.type === 'limiter')[0];
  const pa = pitchTrack(eng, eng.mono, 0.6, lm.t0 - 0.1), pb = pitchTrack(eng, eng.mono, lm.t1 + 0.2, w.meta.dur - 0.3);
  check(eng.name + ': pitch through the lap (median error ' + (Math.max(pa.med, pb.med) * 100).toFixed(3) + ' %, 95 % ' + (Math.max(pa.p95, pb.p95) * 100).toFixed(2) + ' %)', pa.med < 0.004 && pb.med < 0.004 && pa.p95 < 0.02 && pb.p95 < 0.02, pa.worst.concat(pb.worst).slice(0, 4));
  // limiter: the level is chopped at limHz
  {
    const sr = eng.sr, hopS = Math.round(sr * 0.002), env = [];
    for (let s = Math.round((lm.t0 + 0.15) * sr); s < (lm.t1 - 0.05) * sr; s += hopS) env.push(rms(eng.mono, s, s + hopS * 2));
    const N = 1024, re = new Float64Array(N), im = new Float64Array(N), m = mean(env);
    for (let i = 0; i < N && i < env.length; i++) re[i] = (env[i] - m) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.min(N, env.length)));
    (ffts[N] || (ffts[N] = makeFFT(N)))(re, im);
    let bk = 0, bv = 0;
    for (let i = 2; i < 100; i++) { const v = Math.hypot(re[i], im[i]); if (v > bv) { bv = v; bk = i; } }
    const hz = bk * (1 / 0.002) / N, lo = quantile(env, 0.1), hi = quantile(env, 0.9), pitch = peakIn(spectrum(eng.mono, (lm.t0 + 0.6) * sr, 8192), sr, 500, 700).f;
    check(eng.name + ': rev limiter stutters (level chopped at ' + f1(hz) + ' Hz, tuning ' + T.limHz + ' Hz; ' + f1(dB(lo) - dB(hi)) + ' dB between cut and firing; pitch ' + f1(pitch) + ' Hz = 12500 / 20)',
      Math.abs(hz - T.limHz) < 1.5 && dB(lo) - dB(hi) < -8 && Math.abs(pitch - 625) < 4);
    const calm = [];
    for (let s = Math.round(21 * sr); s < 23 * sr; s += hopS) calm.push(rms(eng.mono, s, s + hopS * 2));
    note('for comparison, flat out without the limiter: ' + f1(dB(quantile(calm, 0.1)) - dB(quantile(calm, 0.9))) + ' dB between the 10 % and 90 % level');
  }
  // overrun: darker and quieter than on the throttle
  {
    const lift = ev.filter(e => e.type === 'lift')[0], on = [lift.t0 - 1, lift.t0 - 0.1], off = [lift.t0 + 0.25, lift.t1 - 0.05];
    const cen = (t0, t1) => { const mag = spectrum(eng.mono, (t0 + t1) / 2 * eng.sr, 16384); let a = 0, b = 0; for (let i = 1; i < mag.length; i++) { const p = mag[i] * mag[i]; a += p * i * eng.sr / 32768; b += p; } return a / b; };
    const lOn = rmsLR(eng, on[0], on[1]), lOff = rmsLR(eng, off[0], off[1]), cOn = cen(on[0], on[1]), cOff = cen(off[0], off[1]);
    check(eng.name + ': lifting off makes the engine quieter and darker (level ' + f1(dB(lOn)) + ' -> ' + f1(dB(lOff)) + ' dBFS, spectral centroid ' + Math.round(cOn) + ' -> ' + Math.round(cOff) + ' Hz)', dB(lOff) < dB(lOn) - 5 && cOff < cOn * 0.75);
  }
  // ERS stem
  {
    common(ers);
    const sp = ers.col('speed'), res = [], hres = [];
    ev.filter(e => e.type === 'deploy').forEach(e => { for (let t = e.t0 + 0.4; t < e.t1 - 0.2; t += 0.5) {
      const want = T.depF0 + T.depF1 * ers.at(sp, t - 0.05), p = peakIn(spectrum(ers.mono, t * ers.sr, 4096), ers.sr, 300, 8000); res.push({ t, want, got: p.f, a: p.a, kmh: ers.at(sp, t) * 3.6 }); } });
    ev.filter(e => e.type === 'brake' || e.type === 'lift').forEach(e => { for (let t = e.t0 + 0.35; t < e.t1 - 0.15; t += 0.3) {
      if (!(ers.at('har', t) > 0.05)) continue;
      const want = T.harF0 + T.harF1 * ers.at(sp, t - 0.05), p = peakIn(spectrum(ers.mono, t * ers.sr, 4096), ers.sr, 200, 8000); hres.push({ t, want, got: p.f, a: p.a, har: ers.at('har', t) }); } });
    const worstD = res.reduce((m, r) => Math.max(m, Math.abs(r.got - r.want) / r.want), 0), worstH = hres.reduce((m, r) => Math.max(m, Math.abs(r.got - r.want) / r.want), 0);
    const first = res[0], lastD = res.filter(r => r.t < 7).pop();
    check(ers.name + ': deploy whine present and rising with speed (' + Math.round(first.got) + ' Hz at ' + Math.round(first.kmh) + ' km/h -> ' + Math.round(lastD.got) + ' Hz at ' + Math.round(lastD.kmh) + ' km/h; worst deviation from ' +
      T.depF0 + ' + ' + T.depF1 + ' v: ' + (worstD * 100).toFixed(2) + ' %, ' + res.length + ' points)', res.length > 10 && worstD < 0.02 && lastD.got > first.got * 1.5 && res.every(r => r.a > 0.003));
    check(ers.name + ': harvest whine is a different, lower tone (worst deviation from ' + T.harF0 + ' + ' + T.harF1 + ' v: ' + (worstH * 100).toFixed(2) + ' %, ' + hres.length + ' points)', hres.length > 5 && worstH < 0.03);
    const dl = rmsLR(ers, 3, 6.5), hl = rmsLR(ers, 8.4, 9.4), quiet = rmsLR(ers, 13.5, 16.5), engAt = rmsLR(eng, 3, 6.5);
    check(ers.name + ': faint, harvest softer than deploy, silent otherwise (deploy ' + f1(dB(dl)) + ' dBFS = ' + f1(dB(dl) - dB(engAt)) + ' dB re the engine; harvest at full braking ' + f1(dB(hl)) + ' dBFS; neither ' + f1(dB(quiet)) + ' dBFS)',
      dB(dl) - dB(engAt) < -12 && dB(dl) - dB(engAt) > -30 && hl < dl * 0.8 && hl > 0.0005 && quiet < 1e-4);
  }
  // surface stem
  {
    common(sur);
    const sl = ev.filter(e => e.type === 'slip')[0], gr = ev.filter(e => e.type === 'grass')[0], mid = (sl.t0 + sl.t1) / 2;
    const lSlip = rmsLR(sur, mid - 0.4, mid + 0.4), lEdge = rmsLR(sur, sl.t0 + 0.1, sl.t0 + 0.4), lNone = rmsLR(sur, 13.5, 16.5), lGrass = rmsLR(sur, gr.t0 + 0.4, gr.t1 - 0.2);
    const magS = spectrum(sur.L, mid * sur.sr, 16384), magG = spectrum(sur.L, (gr.t0 + gr.t1) / 2 * sur.sr, 16384);
    const band = (mag, a, b) => { let s = 0; for (let i = Math.round(a * 16384 / sur.sr); i < b * 16384 / sur.sr; i++) s += mag[i] * mag[i]; return Math.sqrt(s); };
    check(sur.name + ': tyre scrub follows slip (slip 0.75: ' + f1(dB(lSlip)) + ' dBFS, slip ~0.05: ' + f1(dB(lEdge)) + ' dBFS, no slip: ' + f1(dB(lNone)) + ' dBFS; ' + f1(dB(band(magS, 300, 1500)) - dB(band(magS, 20, 200))) + ' dB more energy at 300..1500 Hz than below 200 Hz)',
      lSlip > 0.01 && lEdge < lSlip * 0.4 && lNone < 1e-4 && band(magS, 300, 1500) > 3 * band(magS, 20, 200));
    check(sur.name + ': grass is a low rumble (' + f1(dB(lGrass)) + ' dBFS; ' + f1(dB(band(magG, 20, 200)) - dB(band(magG, 300, 3000))) + ' dB more energy below 200 Hz than at 300..3000 Hz)', lGrass > 0.02 && band(magG, 20, 200) > 2 * band(magG, 300, 3000));
  }
  // impacts
  {
    common(fx);
    const hits = ev.filter(e => e.type === 'hit'), sr = fx.sr, bursts = [];
    let on = false, start = 0, pk = 0;
    for (let s = 0; s + 480 <= fx.n; s += 240) {
      const v = peakAbs(fx.mono, s, s + 480).p;
      if (v > 0.003) { if (!on) { on = true; start = s / sr; pk = 0; } if (v > pk) pk = v; }
      else if (on && v < 0.0015) { on = false; bursts.push({ t0: start, t1: s / sr, peak: pk }); }          // (hysteresis: a tail wobbling around the threshold is one burst)
    }
    const ok = bursts.length === hits.length && bursts.every((b, i) => b.t0 - hits[i].t0 > -0.005 && b.t0 - hits[i].t0 < 0.04);
    check(fx.name + ': one thump per impact, not one per frame (' + hits.length + ' impacts, the first with hit > 0 for 5 frames: ' + bursts.length + ' thumps at ' + bursts.map(b => f3(b.t0)).join(', ') + ' s; module counted ' + fx.meta.thumps + ')', ok && fx.meta.thumps === hits.length);
    if (bursts.length === 2) {
      const want = dB((0.3 + 0.7 * hits[1].strength) / (0.3 + 0.7 * hits[0].strength)), got = dB(bursts[1].peak / bursts[0].peak);
      check(fx.name + ': thump scaled by hit (hit ' + hits[0].strength + ': peak ' + f1(dB(bursts[0].peak)) + ' dBFS, ' + f2(bursts[0].t1 - bursts[0].t0) + ' s; hit ' + hits[1].strength + ': ' + f1(dB(bursts[1].peak)) + ' dBFS; ' + f1(got) + ' dB apart, tuning ' + f1(want) + ' dB)',
        Math.abs(got - want) < 2.5 && bursts[0].peak > 0.05);
      const mag = spectrum(fx.mono, (bursts[1].t0 + 0.06) * sr, 8192);
      note('thump spectrum: strongest partial ' + f1(peakIn(mag, sr, 20, 2000).f) + ' Hz');
    }
  }
}

function scenePassby(dir) {
  const w = load(dir, 'c_passby'); if (!w) return check('c_passby: rendered', false);
  common(w);
  const r = load(path.join(dir, 'stems'), 'c_passby.remote'); if (!r) return check('c_passby: stem rendered', false);
  r.name = 'stems/' + r.name;
  common(r);
  const C = r.meta.info.C_SOUND, fi = r.col('f0'), di = r.col('dop'), zi = r.col('rz'), V = 300 / 3.6, f0 = r.meta.rows[0][fi];
  // pitch of the strongest partial against f0 * c / (c + v_radial)
  const track = [];
  for (let t = 0.4; t < r.meta.dur - 0.3; t += 0.05) {
    const want = f0 * r.at(di, t - lagOf(r)), p = peakIn(spectrum(r.mono, t * r.sr, 4096), r.sr, 250, 900);
    track.push({ t, want, got: p.f, z: r.at(zi, t) });
  }
  const far = track.filter(p => Math.abs(p.z) > 80), errFar = far.reduce((m, p) => Math.max(m, Math.abs(p.got - p.want) / p.want), 0);
  const before = track.filter(p => p.z < -80), after = track.filter(p => p.z > 80);
  const fb = mean(before.map(p => p.got)), fa = mean(after.map(p => p.got)), tb = mean(before.map(p => p.want)), ta = mean(after.map(p => p.want));
  check(r.name + ': Doppler - approaching ' + f1(fb) + ' Hz, receding ' + f1(fa) + ' Hz: ratio ' + f3(fb / fa) + ', theory (c + v) / (c - v) along the line of sight ' + f3(tb / ta) +
    ' (engine ' + f1(f0) + ' Hz at 300 km/h, c = ' + C + ' m/s); worst error beyond 80 m ' + (errFar * 100).toFixed(2) + ' %', Math.abs(fb / fa / (tb / ta) - 1) < 0.01 && errFar < 0.012 && fb / fa > 1.5);
  let mono = true;
  for (let i = 1; i < track.length; i++) if (track[i].got > track[i - 1].got * 1.004) mono = false;
  const closest = track.reduce((a, b) => Math.abs(a.z) < Math.abs(b.z) ? a : b);
  check(r.name + ': the pitch only ever falls during the pass (at the closest point ' + f1(closest.got) + ' Hz, expected ' + f1(closest.want) + ' Hz)', mono);
  // left / right
  const bal = (t0, t1) => dB(rmsT(r, r.L, t0, t1)) - dB(rmsT(r, r.R, t0, t1)), tPass = 3;
  const b1 = bal(tPass - 0.6, tPass - 0.2), b2 = bal(tPass + 0.2, tPass + 0.6), bFar = bal(0.5, 1.2), bEnd = bal(4.8, 5.5);
  let cross = NaN;
  for (let t = tPass - 0.2; t < tPass + 0.2; t += 0.002) if (bal(t - 0.01, t + 0.01) <= 0) { cross = t; break; }
  check(r.name + ': pan - left before the pass, right after (L - R: ' + f1(bFar) + ' dB far away, ' + f1(b1) + ' dB just before, ' + f1(b2) + ' dB just after, ' + f1(bEnd) + ' dB far away; the balance crosses over ' +
    Math.round((cross - tPass) * 1000) + ' ms after the car is straight ahead)', b1 > 6 && b2 < -6 && bFar > 6 && bEnd < -6 && Math.abs(cross - tPass) < 0.06);
  // level
  const lv = t => dB(rmsLR(r, t - 0.05, t + 0.05));
  const att = d => { const I = r.meta.info; if (d >= I.D_MAX) return 0; let g = d > I.D_REF ? Math.pow(I.D_REF / d, I.D_EXP) : 1; if (d > I.D_FADE) { const x = (I.D_MAX - d) / (I.D_MAX - I.D_FADE); g *= x * x * (3 - 2 * x); } return g; };
  note('level: ' + [0.5, 1.5, 2.5, 2.9, 3, 3.1, 3.5, 4.5, 5.5].map(t => f1(Math.abs(r.at(zi, t))) + ' m ' + f1(lv(t)) + ' dBFS').join(' | '));
  const peakT = [2.7, 2.8, 2.9, 3, 3.1, 3.2, 3.3].reduce((a, b) => lv(a) > lv(b) ? a : b);
  check(r.name + ': loudest as it passes (' + f1(lv(peakT)) + ' dBFS at ' + peakT + ' s), ' + f1(lv(3) - lv(1)) + ' dB above the level at 167 m', Math.abs(peakT - 3) <= 0.2 && lv(3) - lv(1) > 15);
  // in the full mix the own engine idles underneath
  const idle = rmsLR(w, 0.3, 0.9), pass = rmsLR(w, 2.9, 3.1);
  note('full mix: own idle + car far away ' + f1(dB(idle)) + ' dBFS, as the car passes ' + f1(dB(pass)) + ' dBFS');
}

function scenePack(dir) {
  const w = load(dir, 'd_pack'); if (!w) return check('d_pack: rendered', false);
  common(w);
  const r = load(path.join(dir, 'stems'), 'd_pack.remote'); if (!r) return check('d_pack: stem rendered', false);
  r.name = 'stems/' + r.name;
  const c = common(r);
  const vi = r.col('m_voices'), ni = r.col('inRange'), rows = r.meta.rows, MAXV = r.meta.info.MAX_VOICES;
  let maxV = 0, maxN = 0, changes = 0;
  rows.forEach((row, i) => { if (row[vi] > maxV) maxV = row[vi]; if (row[ni] > maxN) maxN = row[ni]; if (i && row[vi] !== rows[i - 1][vi]) changes++; });
  check(r.name + ': never more than MAX_VOICES = ' + MAXV + ' voices (peak ' + maxV + ' with up to ' + maxN + ' cars in range; the voice count changed ' + changes + ' times)', maxV === MAXV && maxN > MAXV);
  const tel = r.meta.events.filter(e => e.type === 'teleport');
  const alloc = [];
  rows.forEach((row, i) => { if (i && row[vi] !== rows[i - 1][vi]) alloc.push(row[0]); });
  const hfAll = r.hf[0].list.concat(r.hf[1].list), lpcAll = r.lpc[0].list.concat(r.lpc[1].list);
  const worstAt = (list, t, span) => list.filter(k => k.t > t - 0.03 && k.t < t + span).reduce((m, k) => Math.max(m, k.ratio), 0);
  const aHf = alloc.reduce((m, t) => Math.max(m, worstAt(hfAll, t, 0.4)), 0), aLpc = alloc.reduce((m, t) => Math.max(m, worstAt(lpcAll, t, 0.4)), 0);
  const aStep = alloc.reduce((m, t) => Math.max(m, maxStep(r, t - 0.03, t + 0.4, rmsLR(r, t - 0.3, t)).step), 0);
  check(r.name + ': voices come and go without clicks (' + alloc.length + ' changes: hf ' + (aHf ? aHf.toFixed(4) : 'nothing above ' + HF_MAX / 3) + ', lpc ' + (aLpc ? f2(aLpc) : 'nothing above 6') + ', largest level change in 2 ms ' + f1(aStep) + ' dB)',
    aHf < HF_MAX && aStep < STEP_MAX);
  tel.forEach(e => {
    const worst = worstAt(lpcAll, e.t0, 0.4), wh = worstAt(hfAll, e.t0, 0.4);
    const a = rmsLR(r, e.t0 - 0.3, e.t0 - 0.02), b = rmsLR(r, e.t0 + 0.02, e.t0 + 0.3), pk = Math.max(peakAbs(r.L, (e.t0 - 0.05) * r.sr, (e.t0 + 0.4) * r.sr).p, peakAbs(r.R, (e.t0 - 0.05) * r.sr, (e.t0 + 0.4) * r.sr).p);
    check(r.name + ': teleport at ' + e.t0 + ' s - no click (hf ' + (wh ? wh.toFixed(4) : 'nothing') + ', lpc ' + (worst ? f2(worst) : 'nothing') + '), no burst (level ' + f1(dB(a)) + ' -> ' + f1(dB(b)) + ' dBFS, peak ' + f1(dB(pk)) + ' dBFS, largest level change in 2 ms ' +
      f1(maxStep(r, e.t0 - 0.03, e.t0 + 0.4, a).step) + ' dB)', wh < HF_MAX && pk < 0.6 && maxStep(r, e.t0 - 0.03, e.t0 + 0.4, a).step < STEP_MAX);
  });
  note('levels: pack alone ' + f1(dB(rmsLR(r, 1, 13))) + ' dBFS, full mix ' + f1(dB(rmsLR(w, 1, 13))) + ' dBFS (own engine at 200 km/h part throttle + wind + pack)');
}

function sceneTeleport(dir) {
  const r = load(path.join(dir, 'stems'), 'd_teleport.remote'); if (!r) return check('d_teleport: stem rendered', false);
  r.name = 'stems/' + r.name;
  common(r);
  const fi = r.col('f0'), di = r.col('dop'), N = 2048, tel = r.meta.events.map(e => e.t0);
  // Every frame that is loud enough to be heard must sit on one of the pitches the car really has (before or after
  // a teleport), never in between: a Doppler factor computed from the jump in position would sweep / screech.
  const ref = rmsLR(r, 0.7, 0.95);
  let bad = [], heard = 0, minLevel = Infinity;
  for (let t = 0.3; t < r.meta.dur - 0.1; t += 0.01) {
    const lvl = rmsLR(r, t - 0.01, t + 0.01);
    if (tel.some(x => Math.abs(t - x) < 0.35) && lvl < minLevel) minLevel = lvl;
    if (lvl < ref * 0.05) continue;
    heard++;
    const p = peakIn(spectrum(r.mono, t * r.sr, N), r.sr, 150, 900);
    const cands = [r.held(fi, t) * r.held(di, t)];
    tel.forEach(x => { cands.push(r.held(fi, x - 0.03) * r.held(di, x - 0.03)); cands.push(r.held(fi, x + 0.03) * r.held(di, x + 0.03)); });
    const err = cands.reduce((m, c) => Math.min(m, Math.abs(p.f - c) / c), 1);
    if (err > 0.03) bad.push({ t: +t.toFixed(2), got: +p.f.toFixed(1), near: +cands[0].toFixed(1) });
  }
  const dA = r.held(di, 0.95), dB_ = r.held(di, 1.05);
  check(r.name + ': a teleported car does not screech (Doppler factor steps ' + f3(dA) + ' -> ' + f3(dB_) + '; ' + heard + ' audible frames, ' + bad.length + ' off the true pitches; the old voice fades to ' + f1(dB(minLevel) - dB(ref)) + ' dB while the new one starts)',
    bad.length === 0 && heard > 150, bad.slice(0, 5));
  const end = peakIn(spectrum(r.mono, 3.3 * r.sr, 8192), r.sr, 150, 900);
  check(r.name + ': after being placed on the grid it idles (' + f1(end.f) + ' Hz)', Math.abs(end.f - 200) < 2);
  const full = load(dir, 'd_teleport');
  if (full) common(full);
}

function sceneLights(dir) {
  const w = load(dir, 'e_lights'); if (!w) return check('e_lights: rendered', false);
  common(w);
  const fx = load(path.join(dir, 'stems'), 'e_lights.fx'); if (!fx) return check('e_lights: stem rendered', false);
  fx.name = 'stems/' + fx.name;
  common(fx);
  const T = fx.meta.info.tuning, ev = fx.meta.events, sr = fx.sr, bursts = [];
  let on = false, start = 0;
  for (let s = 0; s + 96 <= fx.n; s += 48) {
    const v = peakAbs(fx.mono, s, s + 96).p;
    if (v > T.beepAmp * 0.1) { if (!on) { on = true; start = s / sr; } }
    else if (on) { on = false; bursts.push({ t0: start, t1: s / sr }); }
  }
  bursts.forEach(b => { const p = peakIn(spectrum(fx.mono, (b.t0 + Math.min(0.06, (b.t1 - b.t0) / 2)) * sr, 4096), sr, 200, 5000); b.f = p.f; b.peak = peakAbs(fx.mono, b.t0 * sr, b.t1 * sr).p; });
  const okCount = bursts.length === ev.length, lights = bursts.slice(0, 5), go = bursts[5];
  check(fx.name + ': six beeps at the six events (' + bursts.map(b => f3(b.t0)).join(', ') + ' s)', okCount && bursts.every((b, i) => b.t0 - ev[i].t0 > -0.003 && b.t0 - ev[i].t0 < 0.03));
  if (okCount) {
    check(fx.name + ': light beeps ' + lights.map(b => f1(b.f)).join(' / ') + ' Hz, ' + lights.map(b => Math.round((b.t1 - b.t0) * 1000)).join(' / ') + ' ms, peak ' + f1(dB(lights[0].peak)) + ' dBFS',
      lights.every(b => Math.abs(b.f - T.beepHz) < 3 && b.t1 - b.t0 > 0.1 && b.t1 - b.t0 < 0.25));
    check(fx.name + ': the go beep is a different one (' + f1(go.f) + ' Hz, ' + Math.round((go.t1 - go.t0) * 1000) + ' ms)', Math.abs(go.f - T.beepGoHz) < 5 && go.t1 - go.t0 > 2.5 * (lights[0].t1 - lights[0].t0));
    const idle = rmsLR(w, 0.4, 0.95), beep = rmsLR(w, bursts[0].t0 + 0.02, bursts[0].t0 + 0.1);
    note('full mix: idle engine ' + f1(dB(idle)) + ' dBFS, during a light beep ' + f1(dB(beep)) + ' dBFS (the beep itself ' + f1(dB(rmsLR(fx, bursts[0].t0 + 0.02, bursts[0].t0 + 0.1))) + ' dBFS)');
  }
}

function sceneFades(dir) {
  const w = load(dir, 'f_fades'); if (!w) return check('f_fades: rendered', false);
  const c = common(w);
  const ref = rmsLR(w, 0.5, 0.95), lv = (a, b) => rmsLR(w, a, b), rel = (a, b) => dB(lv(a, b)) - dB(ref);
  note('reference level (200 km/h, half throttle) ' + f1(dB(ref)) + ' dBFS');
  check(w.name + ': mute is smooth and complete (' + f1(rel(1.0, 1.02)) + ' dB in the first 20 ms, ' + f1(rel(1.1, 1.15)) + ' dB after 100 ms, ' + f1(dB(lv(1.3, 1.95))) + ' dBFS from 0.3 s on)', rel(1.0, 1.02) > -12 && lv(1.3, 1.95) < 1e-4);
  check(w.name + ': unmute brings the level back (' + f2(rel(2.3, 2.95)) + ' dB)', Math.abs(rel(2.3, 2.95)) < 0.7);
  check(w.name + ': setVolume(0.5) = ' + f2(rel(3.3, 3.95)) + ' dB (v * v = -12.04 dB), back at 1: ' + f2(rel(4.3, 4.95)) + ' dB', Math.abs(rel(3.3, 3.95) + 12.04) < 0.7 && Math.abs(rel(4.3, 4.95)) < 0.7);
  const tail = Math.max(peakAbs(w.L, 5.3 * w.sr, 6.49 * w.sr).p, peakAbs(w.R, 5.3 * w.sr, 6.49 * w.sr).p);
  check(w.name + ': setActive(false) fades to silence within 0.3 s (' + f1(rel(5.1, 5.15)) + ' dB after 0.1 s, ' + f1(rel(5.2, 5.25)) + ' dB after 0.2 s; largest sample from 0.3 s on: ' + (tail === 0 ? 'digital zero' : f1(dB(tail)) + ' dBFS') + ')', tail < 3.2e-5);
  check(w.name + ': setActive(true) brings it back (' + f2(rel(6.8, 7.9)) + ' dB)', Math.abs(rel(6.8, 7.9)) < 0.7);
  const times = w.meta.events.map(e => e.t0), near = w.lpc[0].list.concat(w.lpc[1].list).filter(k => times.some(t => k.t > t - 0.05 && k.t < t + 0.45));
  const hfNear = w.hf[0].list.concat(w.hf[1].list).filter(k => times.some(t => k.t > t - 0.05 && k.t < t + 0.45)).reduce((m, k) => Math.max(m, k.ratio), 0);
  const steps = times.map(t => maxStep(w, t - 0.02, t + 0.45, ref));
  check(w.name + ': no click at any of the ' + times.length + ' transitions (hf: ' + (hfNear ? hfNear.toFixed(4) : 'nothing above ' + HF_MAX / 3) + '; lpc: ' + (near.length ? f2(near.reduce((m, k) => Math.max(m, k.ratio), 0)) : 'nothing above 6') +
    '; largest level change in 2 ms: ' + steps.map(x => f1(x.step)).join(' / ') + ' dB)', hfNear < HF_MAX && steps.every(x => x.step < STEP_MAX));
}

function sceneBalance(dir) {
  const st = n => { const x = load(path.join(dir, 'stems'), n); if (x) x.name = 'stems/' + x.name; return x; };
  const full = load(dir, 'g_top'), eng = st('g_top.engine'), aero = st('g_top.aero'), rem = st('g_top.remote'), mid = st('g_mid.engine'), over = st('g_overrun.engine'), idle = st('g_idle.engine');
  if (!full || !eng || !aero || !rem || !mid || !over || !idle) return check('g_*: rendered', false);
  [full, eng, aero, rem, mid, over, idle].forEach(x => common(x));
  const L = x => dB(rmsLR(x, 1, 3)), A = x => dB(rmsALR(x, 1, 3));
  const row = (label, x) => note(label.padEnd(44) + f1(L(x)).padStart(7) + ' dBFS   ' + f1(A(x)).padStart(7) + ' dB(A)FS');
  note('loudness (RMS of both channels, 1..3 s):');
  row('own engine, 330 km/h flat out (11287 rpm)', eng); row('wind + road, 330 km/h', aero); row('remote car 10 m to the right, flat out', rem); row('everything together', full);
  row('own engine, 150 km/h flat out (4th, 9833 rpm)', mid); row('own engine, 250 km/h, throttle closed', over); row('own engine, idle', idle);
  const e = L(eng), a = L(aero), r = L(rem), eA = A(eng), aA = A(aero), rA = A(rem);
  check('balance: the own engine is the loudest source to the ear even at top speed (A-weighted: engine ' + f1(eA) + ', wind + road ' + f1(aA) + ', remote at 10 m ' + f1(rA) + ' dB)', eA > aA && eA > rA + 3);
  check('balance: wind + road roar is on a par with the engine at 330 km/h (unweighted ' + f1(a - e) + ' dB re the engine, A-weighted ' + f1(aA - eA) + ' dB)', a - e > -3 && a - e < 4);
  check('balance: a car 10 m away is clearly there but below the own engine (' + f1(r - e) + ' dB re the own engine)', r - e < -3 && r - e > -12);
  check('balance: idle ' + f1(L(idle) - e) + ' dB, overrun ' + f1(L(over) - e) + ' dB, mid-range flat out ' + f1(L(mid) - e) + ' dB re flat out at top speed', L(idle) - e < -8 && L(idle) - e > -22 && L(over) - e < -5 && L(mid) - e < 0.5 && L(mid) - e > -5);
  check('balance: the whole mix at top speed leaves headroom (' + f1(L(full)) + ' dBFS RMS, peak ' + f1(dB(Math.max(peakAbs(full.L).p, peakAbs(full.R).p))) + ' dBFS)', L(full) < -9 && L(full) > -22);
  const bal = dB(rmsT(rem, rem.L, 1, 3)) - dB(rmsT(rem, rem.R, 1, 3));
  check('balance: the car on the right is on the right (L - R = ' + f1(bal) + ' dB)', bal < -6);
  // wind against speed from the launch scene is reported by the distance / launch checks; here: spectrum centroid
  return { e, a, r };
}

function sceneDistance(dir) {
  const r = load(path.join(dir, 'stems'), 'h_distance.remote'); if (!r) return check('h_distance: stem rendered', false);
  r.name = 'stems/' + r.name;
  common(r);
  const I = r.meta.info, di = r.col('dist');
  const att = d => { if (d >= I.D_MAX) return 0; let g = d > I.D_REF ? Math.pow(I.D_REF / d, I.D_EXP) : 1; if (d > I.D_FADE) { const x = (I.D_MAX - d) / (I.D_MAX - I.D_FADE); g *= x * x * (3 - 2 * x); } return g; };
  const pts = [];
  for (let t = 0.45; t < r.meta.dur - 0.3; t += 0.25) pts.push({ d: r.at(di, t), l: rmsLR(r, t - 0.2, t + 0.2) });
  const at = d => pts.reduce((a, b) => Math.abs(a.d - d) < Math.abs(b.d - d) ? a : b), ref = at(10);
  const table = [10, 20, 40, 60, 100, 150, 200, 250, 280].map(d => { const p = at(d); return { d, got: dB(p.l) - dB(ref.l), want: dB(att(p.d)) - dB(att(ref.d)), abs: dB(p.l) }; });
  note('level against distance (re 10 m): ' + table.map(x => x.d + ' m ' + f1(x.got) + ' dB (law ' + f1(x.want) + ')').join(' | '));
  note('absolute: 10 m ' + f1(table[0].abs) + ' dBFS, 60 m ' + f1(table[3].abs) + ' dBFS, 200 m ' + f1(table[6].abs) + ' dBFS');
  check(r.name + ': level follows the distance law within 1.5 dB from 10 m to 250 m (worst ' + f2(table.slice(0, 8).reduce((m, x) => Math.max(m, Math.abs(x.got - x.want)), 0)) + ' dB)', table.slice(0, 8).every(x => Math.abs(x.got - x.want) < 1.5));
  let mono = true, rise = 0;
  for (let i = 8; i < pts.length; i++) if (pts[i].d > 12 && pts[i - 8].l > 1e-5) { const up = dB(pts[i].l) - dB(pts[i - 8].l); if (up > rise) rise = up; if (up > 0.5) mono = false; }
  check(r.name + ': level falls steadily with distance (over any 24 m further out it never rises by more than ' + f2(Math.max(rise, 0)) + ' dB)', mono);
  check(r.name + ': clearly audible at 60 m (' + f1(table[3].got) + ' dB re 10 m, ' + f1(table[3].abs) + ' dBFS)', table[3].got > -16 && table[3].abs > -48);
  const gone = pts.filter(p => p.d > I.D_MAX + 8), last = gone.reduce((m, p) => Math.max(m, p.l), 0);
  check(r.name + ': gone by ' + I.D_MAX + ' m (beyond: ' + (last === 0 ? 'digital silence' : f1(dB(last)) + ' dBFS') + ', ' + gone.length + ' windows)', gone.length >= 5 && last < 1e-4);
}

function sceneWind(dir) {
  const w = load(path.join(dir, 'stems'), 'i_wind.aero'), eng = load(path.join(dir, 'stems'), 'g_top.engine');
  if (!w || !eng) return check('i_wind: stem rendered', false);
  w.name = 'stems/' + w.name;
  common(w);
  const si = w.col('speed'), e = dB(rmsLR(eng, 1, 3)), eA = dB(rmsALR(eng, 1, 3)), T = w.meta.info.tuning;
  const at = kmh => { let t = 0; while (t < w.meta.dur && w.at(si, t) * 3.6 < kmh) t += 0.01; return t; };
  const rows = [50, 100, 150, 200, 250, 300, 330].map(kmh => { const t = at(kmh); return { kmh, t, l: dB(rmsLR(w, t - 0.25, t + 0.25)), a: dB(rmsALR(w, Math.max(0, t - 0.2), t + 0.2)) }; });
  note('wind + road against speed (dBFS; A-weighted; re the own engine flat out at 330 km/h ' + f1(e) + ' dBFS / ' + f1(eA) + ' dB(A)): ' +
    rows.map(r => r.kmh + ' km/h ' + f1(r.l) + ' (' + (r.l - e >= 0 ? '+' : '') + f1(r.l - e) + ', A ' + (r.a - eA >= 0 ? '+' : '') + f1(r.a - eA) + ')').join(' | '));
  let mono = true;
  for (let i = 1; i < rows.length; i++) if (rows[i].l <= rows[i - 1].l) mono = false;
  const r250 = rows.find(r => r.kmh === 250), r330 = rows.find(r => r.kmh === 330), r100 = rows.find(r => r.kmh === 100);
  check(w.name + ': grows with speed all the way (' + f1(r100.l - e) + ' dB re the engine at 100 km/h, ' + f1(r250.l - e) + ' dB at 250, ' + f1(r330.l - e) + ' dB at 330)', mono && r100.l - e < -12);
  // (second review: the wind was taken 2 dB down, so that the engine stays on top at top speed and a top-gear upshift is heard)
  check(w.name + ': from 250 km/h on it is a match for the engine (within 9 dB at 250 km/h, 0.5 .. 5 dB under it at 330 km/h, unweighted)', r250.l - e > -9 && r330.l - e < -0.5 && r330.l - e > -5);
}

/* ---------------- self test: the checks must notice real damage ---------------- */
function selfTest(dir) {
  prefix = 'selftest: ';
  const w = load(dir, 'a_launch'); if (!w) return check('a_launch rendered', false);
  const base = clickScan(w.mono, w.sr), baseHf = hfScan(w.mono, w.sr);
  note('clean file: hf ' + baseHf.ratio.toFixed(4) + ', lpc ' + f2(base.ratio));
  const around = (list, t) => list.filter(k => Math.abs(k.t - t) < 0.02).reduce((m, k) => Math.max(m, k.ratio), 0);
  const copy = () => Float64Array.from(w.mono);
  const asW = x => ({ L: x, R: x, sr: w.sr, n: x.length });
  // 1. a 5 ms drop-out (a voice cut off and restarted without a fade)
  let x = copy();
  for (let i = Math.round(12.3456 * w.sr); i < (12.3456 + 0.005) * w.sr; i++) x[i] = 0;
  let h = hfScan(x, w.sr), c = clickScan(x, w.sr), st = maxStep(asW(x), 12.3, 12.4, rms(x, 12.2 * w.sr, 12.3 * w.sr));
  check('a 5 ms drop-out at 12.346 s is flagged (hf ' + h.ratio.toFixed(3) + ' at ' + f3(h.t) + ' s; level change in 2 ms ' + f1(st.step) + ' dB; lpc ' + f1(around(c.list, 12.348)) + ')', h.ratio > HF_MAX && Math.abs(h.t - 12.348) < 0.006 && st.step > STEP_MAX);
  // 2. a phase jump (an oscillator restarted at a gear change)
  x = copy();
  const j = Math.round(8.2 * w.sr);
  for (let i = w.n - 1; i >= j + 37; i--) x[i] = x[i - 37];
  h = hfScan(x, w.sr); c = clickScan(x, w.sr);
  check('a 37-sample phase jump at 8.2 s is flagged (hf ' + h.ratio.toFixed(3) + ' at ' + f3(h.t) + ' s; lpc ' + f1(c.ratio) + ' at ' + f3(c.t) + ' s)', h.ratio > HF_MAX && Math.abs(h.t - 8.2) < 0.005);
  // 3. gain steps: 6 dB, 1 dB
  [[0.5, '6 dB'], [0.89, '1 dB']].forEach(g => {
    x = copy();
    for (let i = Math.round(20.1 * w.sr); i < w.n; i++) x[i] *= g[0];
    h = hfScan(x, w.sr);
    const got = around(h.list, 20.1);
    if (g[0] === 0.5) check('a ' + g[1] + ' gain step at 20.1 s is flagged (hf ' + got.toFixed(3) + ')', got > HF_MAX);
    else note('a ' + g[1] + ' gain step at 20.1 s reads hf ' + got.toFixed(4) + ' (limit ' + HF_MAX + ')');
  });
  // 4. a hard mute
  x = copy();
  for (let i = Math.round(15 * w.sr); i < w.n; i++) x[i] = 0;
  st = maxStep(asW(x), 14.9, 15.2, rms(x, 14.8 * w.sr, 14.9 * w.sr)); h = hfScan(x, w.sr);
  check('a mute without a fade is flagged (level change in 2 ms ' + f1(st.step) + ' dB, hf ' + around(h.list, 15).toFixed(3) + ')', st.step > STEP_MAX && around(h.list, 15) > HF_MAX);
  // 5. zipper: the gain stepped by +-2 % at 60 Hz
  x = copy();
  for (let i = 0; i < w.n; i++) x[i] *= 1 + 0.02 * ((Math.floor(i * 60 / w.sr) * 7919 % 13) / 6 - 1);
  h = hfScan(x, w.sr);
  check('a gain stepped by up to 2 % at every 60 Hz update is flagged as zipper noise (' + (h.zip(1.2, 8, 60) * 100).toFixed(1) + ' % of the high band locked to 60 Hz; clean ' + (baseHf.zip(1.2, 8, 60) * 100).toFixed(1) + ' %; hf ' + h.ratio.toFixed(4) + ')', h.zip(1.2, 8, 60) > ZIP_MAX);
  // 4. the engine 3 % sharp
  const p = pitchTrack(w, w.mono, 0.4, w.meta.dur - 0.3, { scale: 1.03 });
  check('a 3 % pitch error fails the pitch check (median error ' + (p.med * 100).toFixed(2) + ' %)', !(p.med < 0.004 && p.p95 < 0.015));
  // 5. clipping and DC
  x = Float64Array.from(w.L, v => Math.max(-1, Math.min(1, v * 6)));
  let run = 0, maxRun = 0;
  for (let i = 0; i < x.length; i++) { if (Math.abs(x[i]) >= 0.999) { run++; if (run > maxRun) maxRun = run; } else run = 0; }
  check('a clipped copy is flagged (peak ' + f2(peakAbs(x).p) + ', ' + maxRun + ' samples in a row at full scale)', peakAbs(x).p >= PEAK_MAX && maxRun > 0);
  check('a copy with 0.01 of DC is flagged', Math.abs(mean(Float64Array.from(w.L, v => v + 0.01))) > DC_MAX);
  // 6. true peak above the sample peak
  x = new Float64Array(4800);
  for (let i = 0; i < x.length; i++) x[i] = 0.9 * Math.sin(2 * Math.PI * (w.sr / 4) * i / w.sr + Math.PI / 4);
  check('true-peak estimate finds the inter-sample over of a fs/4 sine (samples ' + f3(peakAbs(x).p) + ', true peak ' + f3(truePeak(x)) + ', really 0.900)', Math.abs(truePeak(x) - 0.9) < 0.02);
  prefix = '';
}

/* ---------------- run ---------------- */
const backends = BACKENDS.length ? BACKENDS : ['worklet', 'nodes'].filter(b => fs.existsSync(path.join(OUT, b)));
if (!backends.length) { console.log('nothing to analyse: run  npx electron devtests/audio-test/render.js  first'); process.exit(1); }
for (const b of backends) {
  const dir = path.join(OUT, b);
  console.log('\n================ ' + b + ' back end (' + dir + ') ================');
  prefix = b + ': ';
  sceneLaunch(dir, 'a_launch', false);
  sceneLaunch(dir, 'a_minimal', true);
  sceneLap(dir);
  scenePassby(dir);
  scenePack(dir);
  sceneTeleport(dir);
  sceneLights(dir);
  sceneFades(dir);
  sceneBalance(dir);
  sceneDistance(dir);
  sceneWind(dir);
  for (const fps of [30, 144]) if (fs.existsSync(path.join(dir, 'fps', 'a_launch.' + fps + 'fps.wav'))) sceneLaunch(path.join(dir, 'fps'), 'a_launch.' + fps + 'fps', false);
  prefix = '';
}
if (SELFTEST) { console.log('\n================ self test ================'); selfTest(path.join(OUT, backends[0])); }
const bad = results.filter(r => !r.ok);
console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '\nFAILED:\n  ' + bad.map(r => r.name).join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
