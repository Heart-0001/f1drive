// devtests/audio-test/dsp-lib.js - the second reviewer's own signal analysis toolkit (node, no dependencies).
// WAV reader, radix-2 FFT, STFT, windowed peak picking with parabolic refinement, A-weighting, 4x true peak,
// a PNG encoder (zlib from node) and a spectrogram painter. Nothing here is shared with analyze.js.
'use strict';
const fs = require('fs'), zlib = require('zlib');

// ---------------------------------------------------------------- WAV (16-bit PCM or 32-bit float)
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV: ' + file);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    else if (id === 'data') data = { o: o + 8, n: Math.min(n, b.length - o - 8) };
    o += 8 + n + (n & 1);
  }
  if (!fmt || !data) throw new Error('no fmt / data chunk: ' + file);
  const bps = fmt.bits / 8, nc = fmt.ch, N = Math.floor(data.n / (bps * nc)), ch = [];
  for (let c = 0; c < nc; c++) ch.push(new Float32Array(N));
  for (let i = 0; i < N; i++) for (let c = 0; c < nc; c++) {
    const p = data.o + (i * nc + c) * bps;
    ch[c][i] = fmt.bits === 16 ? b.readInt16LE(p) / 32768 : b.readFloatLE(p);
  }
  return { sr: fmt.sr, ch, n: N, bits: fmt.bits };
}
function mono(w) { const m = new Float32Array(w.n); for (let i = 0; i < w.n; i++) { let s = 0; for (let c = 0; c < w.ch.length; c++) s += w.ch[c][i]; m[i] = s / w.ch.length; } return m; }

// ---------------------------------------------------------------- FFT (in place, complex, radix 2)
const twCache = new Map();
function twiddles(n) {
  let t = twCache.get(n);
  if (!t) {
    t = { c: new Float64Array(n / 2), s: new Float64Array(n / 2), rev: new Uint32Array(n) };
    for (let i = 0; i < n / 2; i++) { t.c[i] = Math.cos(2 * Math.PI * i / n); t.s[i] = -Math.sin(2 * Math.PI * i / n); }
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let k = 0; k < bits; k++) { r = (r << 1) | (x & 1); x >>= 1; } t.rev[i] = r; }
    twCache.set(n, t);
  }
  return t;
}
function fft(re, im) {
  const n = re.length, t = twiddles(n);
  for (let i = 0; i < n; i++) { const j = t.rev[i]; if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) for (let k = 0; k < half; k++) {
      const wr = t.c[k * step], wi = t.s[k * step], a = i + k, b = a + half;
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}
const hannCache = new Map();
function hann(n) { let w = hannCache.get(n); if (!w) { w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n); hannCache.set(n, w); } return w; }
// power spectrum (|X|^2, one-sided, bins 0..nfft/2) of x[start .. start+win) Hann-windowed, zero-padded to nfft.
// Scaled so that a sine of amplitude A gives a peak of A^2 / 4 * (sum w)^2 / (sum w)^2 ... see ampOfPeak.
function powerSpec(x, start, win, nfft, out) {
  const re = new Float64Array(nfft), im = new Float64Array(nfft), w = hann(win);
  for (let i = 0; i < win; i++) { const j = start + i; re[i] = j >= 0 && j < x.length ? x[j] * w[i] : 0; }
  fft(re, im);
  const P = out || new Float64Array(nfft / 2 + 1);
  for (let k = 0; k <= nfft / 2; k++) P[k] = re[k] * re[k] + im[k] * im[k];
  return P;
}
// sine amplitude from a (parabolically refined) peak of powerSpec with a Hann window of length win: |X| = A * win / 4
function ampOfPeak(p, win) { return Math.sqrt(p) * 4 / win; }
// parabolic refinement on log power around bin k -> { k (fractional), p (peak power) }
function refine(P, k) {
  if (k <= 0 || k >= P.length - 1) return { k, p: P[k] };
  const a = Math.log(P[k - 1] + 1e-30), b = Math.log(P[k] + 1e-30), c = Math.log(P[k + 1] + 1e-30), den = a - 2 * b + c;
  const d = den < 0 ? 0.5 * (a - c) / den : 0;
  return { k: k + d, p: Math.exp(b - 0.25 * (a - c) * d) };
}
// strongest local maximum in [fLo, fHi] Hz
function peakIn(P, sr, nfft, fLo, fHi) {
  const k0 = Math.max(1, Math.floor(fLo * nfft / sr)), k1 = Math.min(P.length - 2, Math.ceil(fHi * nfft / sr));
  let best = -1, bp = -1;
  for (let k = k0; k <= k1; k++) if (P[k] > bp && P[k] >= P[k - 1] && P[k] >= P[k + 1]) { bp = P[k]; best = k; }
  if (best < 0) return null;
  const r = refine(P, best);
  return { f: r.k * sr / nfft, p: r.p };
}
function rms(x, a, b) { let s = 0; a = Math.max(0, a | 0); b = Math.min(x.length, b | 0); for (let i = a; i < b; i++) s += x[i] * x[i]; return b > a ? Math.sqrt(s / (b - a)) : 0; }
function db(x) { return 20 * Math.log10(Math.max(x, 1e-12)); }
function median(a) { const s = Float64Array.from(a).sort(); const n = s.length; return n ? (n & 1 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN; }
function pct(a, q) { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))] : NaN; }

// A-weighting (IEC 61672), linear gain at f Hz, 0 dB at 1 kHz
function aWeight(f) {
  const f2 = f * f, n = 12194 * 12194 * f2 * f2, d = (f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194);
  return n / d * 1.2589;
}
// unweighted and A-weighted RMS of a segment (via one long Hann FFT; the ratio A / flat is applied to the time RMS)
function levels(x, sr, t0, t1) {
  const a = Math.round(t0 * sr), b = Math.round(t1 * sr), r = rms(x, a, b);
  let nfft = 1; while (nfft < b - a) nfft <<= 1;
  const P = powerSpec(x, a, b - a, nfft);
  let sp = 0, sa = 0;
  for (let k = 1; k < P.length; k++) { const w = aWeight(k * sr / nfft); sp += P[k]; sa += P[k] * w * w; }
  return { rms: r, dB: db(r), dBA: db(r * Math.sqrt(sa / Math.max(sp, 1e-30))) };
}
// 4x oversampled true peak (windowed-sinc interpolation, 64 taps per phase)
function truePeak(x) {
  const T = 32, ph = 4, h = [];
  for (let p = 1; p < ph; p++) {
    const hp = new Float64Array(2 * T);
    for (let k = -T + 1; k <= T; k++) { const t = k - p / ph, w = 0.5 + 0.5 * Math.cos(Math.PI * t / T); hp[k + T - 1] = (Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w; }
    h.push(hp);
  }
  let pk = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]); if (a > pk) pk = a;
    if (a < pk * 0.6) continue;                                    // an inter-sample peak can only be near a large sample
    for (let p = 0; p < ph - 1; p++) {
      let s = 0; const hp = h[p];
      for (let k = -T + 1; k <= T; k++) { const j = i + k; if (j >= 0 && j < x.length) s += x[j] * hp[k + T - 1]; }
      if (Math.abs(s) > pk) pk = Math.abs(s);
    }
  }
  return pk;
}

// ---------------------------------------------------------------- PNG
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, rgb) {                     // rgb: Uint8Array w * h * 3
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
// a perceptual-ish colour ramp (black - purple - red - orange - yellow - white), t in 0..1
const RAMP = [[0, 0, 0], [40, 10, 90], [120, 20, 120], [200, 40, 60], [240, 120, 20], [250, 200, 40], [255, 255, 220]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
// 5x7 digits for axis labels
const FONT = { '0': '7b6f', '1': '2c97', '2': '73e7', '3': '73cf', '4': '5bc9', '5': '79cf', '6': '79ef', '7': '7249', '8': '7bef', '9': '7bcf', 'k': '4bed', '.': '0002', 's': '01ce', ' ': '0000', 'H': '5bed', 'z': '03e7' };
function drawText(img, W, H, x, y, s, col) {
  for (const ch of s) {
    const g = parseInt(FONT[ch] || '0000', 16);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (!((g >> (14 - (r * 3 + c))) & 1)) continue;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const px = x + c * 2 + dx, py = y + r * 2 + dy;
        if (px >= 0 && px < W && py >= 0 && py < H) { const o = (py * W + px) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; }
      }
    }
    x += 8;
  }
}
// spectrogram of x -> PNG buffer. opts: { fLo, fHi, log (bool), W, H, win, dbRange, t0, t1, overlay: [{ f: t -> Hz | null, col }] }
function spectrogram(x, sr, opts) {
  const o = Object.assign({ fLo: 50, fHi: 12000, log: true, W: 1400, H: 600, win: 2048, dbRange: 90, t0: 0, t1: x.length / sr }, opts || {});
  let nfft = 4096; while (nfft < o.win * 2) nfft <<= 1;
  const W = o.W, H = o.H, img = new Uint8Array(W * H * 3), col = new Float64Array(H), cols = [];
  let gmax = -1e9;
  const P = new Float64Array(nfft / 2 + 1);
  for (let px = 0; px < W; px++) {
    const t = o.t0 + (o.t1 - o.t0) * (px + 0.5) / W, start = Math.round(t * sr) - o.win / 2;
    powerSpec(x, start, o.win, nfft, P);
    const c = new Float64Array(H);
    for (let py = 0; py < H; py++) {
      const u = 1 - (py + 0.5) / H, f = o.log ? o.fLo * Math.pow(o.fHi / o.fLo, u) : o.fLo + (o.fHi - o.fLo) * u;
      const fu = o.log ? o.fLo * Math.pow(o.fHi / o.fLo, 1 - py / H) : o.fLo + (o.fHi - o.fLo) * (1 - py / H);
      const fd = o.log ? o.fLo * Math.pow(o.fHi / o.fLo, 1 - (py + 1) / H) : o.fLo + (o.fHi - o.fLo) * (1 - (py + 1) / H);
      let k0 = Math.floor(fd * nfft / sr), k1 = Math.ceil(fu * nfft / sr), m = 0;
      if (k1 <= k0 + 1) { const kf = f * nfft / sr, k = Math.floor(kf), a = kf - k; m = P[k] * (1 - a) + P[Math.min(k + 1, P.length - 1)] * a; }
      else for (let k = k0; k <= k1 && k < P.length; k++) if (P[k] > m) m = P[k];
      c[py] = 10 * Math.log10(m + 1e-20);
      if (c[py] > gmax) gmax = c[py];
    }
    cols.push(c);
  }
  for (let px = 0; px < W; px++) for (let py = 0; py < H; py++) {
    const v = ramp((cols[px][py] - (gmax - o.dbRange)) / o.dbRange), p = (py * W + px) * 3;
    img[p] = v[0]; img[p + 1] = v[1]; img[p + 2] = v[2];
  }
  const yOf = f => o.log ? Math.round((1 - Math.log(f / o.fLo) / Math.log(o.fHi / o.fLo)) * H) : Math.round((1 - (f - o.fLo) / (o.fHi - o.fLo)) * H);
  // frequency grid
  const grid = o.log ? [100, 200, 500, 1000, 2000, 5000, 10000] : [];
  if (!o.log) for (let f = 1000; f < o.fHi; f += 1000) grid.push(f);
  for (const f of grid) {
    const y = yOf(f); if (y < 0 || y >= H) continue;
    for (let px = 0; px < W; px += 3) { const p = (y * W + px) * 3; img[p] = 90; img[p + 1] = 200; img[p + 2] = 255; }
    drawText(img, W, H, 2, y - 12, f >= 1000 ? (f / 1000) + 'k' : String(f), [120, 220, 255]);
  }
  // time ticks every second
  for (let s = Math.ceil(o.t0); s <= o.t1; s++) {
    const px = Math.round((s - o.t0) / (o.t1 - o.t0) * W); if (px < 0 || px >= W) continue;
    for (let py = H - 10; py < H; py++) { const p = (py * W + px) * 3; img[p] = 255; img[p + 1] = 255; img[p + 2] = 255; }
    if (s % 5 === 0) drawText(img, W, H, px + 2, H - 12, s + 's', [255, 255, 255]);
  }
  for (const ov of o.overlay || []) {
    for (let px = 0; px < W; px += 2) {
      const t = o.t0 + (o.t1 - o.t0) * (px + 0.5) / W, f = ov.f(t);
      if (!(f > o.fLo && f < o.fHi)) continue;
      const y = yOf(f); if (y < 0 || y >= H) continue;
      const p = (y * W + px) * 3; img[p] = ov.col[0]; img[p + 1] = ov.col[1]; img[p + 2] = ov.col[2];
    }
  }
  return png(W, H, img);
}

module.exports = { readWav, mono, fft, hann, powerSpec, ampOfPeak, refine, peakIn, rms, db, median, pct, aWeight, levels, truePeak, png, spectrogram };
