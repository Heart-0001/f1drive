// node devtests/audio-test/tunnel.js [worklet] [nodes]       (after: npx electron devtests/audio-test/render.js)
//
// v6.2: the tunnel sound of js/audio.js (setTunnel(k): a convolution reverb of js/tunnels.js F1.tunnelImpulse beside
// the dry mix, a mid band around 450 Hz, the engine + T.tunEngDb (0) and the wind / road roar + T.tunRoarDb, ramped;
// the reverb disconnected 2 s after k fell to 0), measured on the renders of scenes o_tunnel (290 km/h flat out, the
// loudest case) / o_tail (scenes.js) with k = 0 against k = 1. The designed amounts come from the render's tuning.
//   level      full mix, engine stem, wind / road stem: louder inside (by at least the designed amounts), the same
//              again after leaving; the master compressor never takes more than 3 dB (as ears.js asks of every file)
//   spectrum   the 355..560 Hz band rises more than the whole mix (the mid band), the 4..8 kHz band less (the tail
//              is dark: its highs die first)
//   ramps      no level step going in or out (20 ms RMS windows: the largest change between neighbours is no larger
//              than in the steady parts, + 1 dB); clicks are ears.js's job (it reads every rendered file)
//   reverb     connected while k > 0 (debug.reverb), disconnected again about 2 s after k reached 0
//   tail       the go beep (FX stem alone): outside it stops dead (> 50 dB down 0.2 s after it ends); inside a tail
//              follows (Schroeder backward integration: RT60 from the -5..-25 dB slope, the impulse is made for 1.4 s)
// Exit code 1 on a failure.
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./dsp-lib');
const OUT = path.join(__dirname, 'out');
const args = process.argv.slice(2).filter(a => a[0] !== '-');
const backends = args.length ? args : ['worklet', 'nodes'].filter(b => fs.existsSync(path.join(OUT, b, 'o_tunnel.wav')));
let failed = 0, total = 0;
function check(name, ok, detail) {
  total++; if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '   ' + detail : ''));
}
const f1 = x => (Math.round(x * 10) / 10).toFixed(1), f2 = x => x.toFixed(2);

function load(dir, name) {
  const wav = path.join(dir, name + '.wav'), js = path.join(dir, name + '.json');
  if (!fs.existsSync(wav) || !fs.existsSync(js)) return null;
  const w = L.readWav(wav), meta = JSON.parse(fs.readFileSync(js, 'utf8'));
  w.mono = L.mono(w); w.meta = meta; w.ix = {}; meta.cols.forEach((c, i) => { w.ix[c] = i; });
  return w;
}
const lvl = (w, t0, t1) => L.db(L.rms(w.mono, t0 * w.sr, t1 * w.sr));
// Welch power spectrum (8192-point Hann frames, half overlap) summed over a band -> dB
function band(w, t0, t1, fLo, fHi) {
  const nf = 8192, a = Math.round(t0 * w.sr), b = Math.round(t1 * w.sr), bin = w.sr / nf;
  let s = 0, frames = 0;
  for (let p = a; p + nf <= b; p += nf / 2) {
    const P = L.powerSpec(w.mono, p, nf, nf);
    for (let k = Math.ceil(fLo / bin); k <= Math.floor(fHi / bin); k++) s += P[k];
    frames++;
  }
  return 10 * Math.log10(Math.max(s / Math.max(frames, 1), 1e-30));
}
// largest change of the 20 ms RMS level between neighbouring windows inside [t0, t1]
function maxStep(w, t0, t1) {
  const win = Math.round(0.02 * w.sr); let prev = null, m = 0;
  for (let p = Math.round(t0 * w.sr); p + win <= t1 * w.sr; p += win) {
    const d = L.db(L.rms(w.mono, p, p + win));
    if (prev !== null) m = Math.max(m, Math.abs(d - prev));
    prev = d;
  }
  return m;
}
// Schroeder energy decay curve from t0 to t1 -> {t5, t25, rt60} (s after t0)
function decay(w, t0, t1) {
  const a = Math.round(t0 * w.sr), b = Math.round(t1 * w.sr), e = new Float64Array(b - a);
  let s = 0;
  for (let i = b - 1; i >= a; i--) { s += w.mono[i] * w.mono[i]; e[i - a] = s; }
  const e0 = e[0] || 1e-30;
  let t5 = NaN, t25 = NaN;
  for (let i = 0; i < e.length; i++) {
    const d = 10 * Math.log10(e[i] / e0);
    if (t5 !== t5 && d <= -5) t5 = i / w.sr;
    if (t25 !== t25 && d <= -25) { t25 = i / w.sr; break; }
  }
  return { t5, t25, rt60: 3 * (t25 - t5) };
}
// rows of the timeline where the reverb (m_rev) was / was not connected, by time
function revWindow(w) {
  const R = w.meta.rows, it = w.ix.t, ir = w.ix.m_rev, ik = w.ix.k;
  let on = Infinity, off = -Infinity, lastK = -Infinity;
  for (const r of R) {
    if (r[ir] === 1) { on = Math.min(on, r[it]); off = Math.max(off, r[it]); }
    if (r[ik] > 0) lastK = Math.max(lastK, r[it]);
  }
  return { on, off, lastK };
}

if (!backends.length) { console.log('nothing to analyse: run  ONLY=o_tunnel,o_tail npx electron devtests/audio-test/render.js  first'); process.exit(1); }
for (const be of backends) {
  const dir = path.join(OUT, be), st = path.join(dir, 'stems');
  console.log('\n================ ' + be + ' back end ================');
  const w = load(dir, 'o_tunnel'), eng = load(st, 'o_tunnel.engine'), aero = load(st, 'o_tunnel.aero');
  const tl = load(dir, 'o_tail'), fx = load(st, 'o_tail.fx');
  if (!w || !eng || !aero || !tl || !fx) { check(be + ': o_tunnel / o_tail rendered (full mixes and stems)', false); continue; }
  // windows: outside 1.0..2.4 s, inside 3.5..6.3 s (k = 1 from 2.92 s), outside again 9.3..9.95 s
  const OUTS = [1.0, 2.4], INS = [3.5, 6.3], AFTER = [9.3, 9.95];
  const d = (x, a, b) => lvl(x, b[0], b[1]) - lvl(x, a[0], a[1]);
  const dMix = d(w, OUTS, INS), dEng = d(eng, OUTS, INS), dAero = d(aero, OUTS, INS), back = d(w, OUTS, AFTER);
  console.log('     levels outside / inside / outside again: full mix ' + f1(lvl(w, ...OUTS)) + ' / ' + f1(lvl(w, ...INS)) + ' / ' + f1(lvl(w, ...AFTER)) +
    ' dBFS; engine stem ' + f1(lvl(eng, ...OUTS)) + ' / ' + f1(lvl(eng, ...INS)) + '; wind + road stem ' + f1(lvl(aero, ...OUTS)) + ' / ' + f1(lvl(aero, ...INS)));
  const T = w.meta.info.tuning, tE = T.tunEngDb, tR = T.tunRoarDb;
  check(be + ': full mix not quieter inside the tunnel (+0.5..8 dB at 290 km/h flat out, after the master compressor)', dMix >= 0.5 && dMix <= 8, '+' + f2(dMix) + ' dB');
  check(be + ': the engine stem louder inside by its +' + tE + ' dB and the reverb reflections (at least +' + (tE + 0.5) + ', at most 9 dB)', dEng >= tE + 0.5 && dEng <= 9, '+' + f2(dEng) + ' dB');
  check(be + ': the wind / road stem louder inside by at least its +' + tR + ' dB (and at most 9 dB)', dAero >= tR - 0.2 && dAero <= 9, '+' + f2(dAero) + ' dB');
  let red = 0; for (const r of w.meta.rows) if (r[w.ix.t] >= 1.5) red = Math.min(red, r[w.ix.m_red]);
  check(be + ': the master compressor takes at most 3 dB in the tunnel (no pumping; ears.js asks it of every file)', red >= -3, f2(red) + ' dB');
  check(be + ': back outside, the level is what it was before the tunnel (within 0.5 dB)', Math.abs(back) < 0.5, f2(back) + ' dB');
  const bMid = band(w, ...INS, 355, 560) - band(w, ...OUTS, 355, 560), bAll = band(w, ...INS, 60, 12000) - band(w, ...OUTS, 60, 12000), bHi = band(w, ...INS, 4000, 8000) - band(w, ...OUTS, 4000, 8000);
  console.log('     spectrum inside - outside: 355..560 Hz +' + f2(bMid) + ' dB, 60 Hz..12 kHz +' + f2(bAll) + ' dB, 4..8 kHz +' + f2(bHi) + ' dB');
  check(be + ': the 355..560 Hz band rises by at least the mid band (' + (T.tunMidDb - 1) + ' dB) and 1 dB more than the whole mix', bMid >= T.tunMidDb - 1 && bMid >= bAll + 1, '+' + f2(bMid) + ' vs +' + f2(bAll) + ' dB');
  const eAll = band(eng, ...INS, 60, 12000) - band(eng, ...OUTS, 60, 12000), eHi = band(eng, ...INS, 4000, 8000) - band(eng, ...OUTS, 4000, 8000);
  check(be + ': engine stem: its 4..8 kHz band rises less than the whole stem (the reverb is dark: its highs die first)', eHi < eAll, '+' + f2(eHi) + ' vs +' + f2(eAll) + ' dB');
  const sIn = maxStep(w, 2.3, 3.3), sOut = maxStep(w, 6.3, 7.3), sSteady = Math.max(maxStep(w, 1.0, 2.3), maxStep(w, 4.0, 6.0));
  check(be + ': no level step going in or out (largest 20 ms change ' + f2(sIn) + ' / ' + f2(sOut) + ' dB vs ' + f2(sSteady) + ' dB when steady)', Math.max(sIn, sOut) <= sSteady + 1);
  // setTunnel(1) as a step in o_tail at 3 s: the module ramps it (the rendered wet / mid gains one frame after the step
  // and 0.3 s after it; an audio measure cannot tell: the idle engine's level swings more than the step, and ears.js's
  // click detector does not notice an unramped step either - both tried with the ramps taken out)
  {
    const T = tl.meta.info.tuning, R = tl.meta.rows, it = tl.ix.t, iw = tl.ix.m_wet, im = tl.ix.m_mid, wT = T.tunWet, mT = Math.exp(T.tunMidDb * Math.LN10 / 20) - 1;
    const at = t => { let best = null; for (const r of R) if (r[it] >= t - 1e-6 && (!best || r[it] < best[it])) best = r; return best; };
    const r1 = at(3.0 + 1.5 / tl.meta.fps), r2 = at(3.3);
    console.log('     o_tail step at 3 s: wet gain ' + f2(r1[iw]) + ' at ' + f2(r1[it]) + ' s, ' + f2(r2[iw]) + ' at ' + f2(r2[it]) + ' s (target ' + wT + '); mid gain ' + f2(r1[im]) + ' / ' + f2(r2[im]) + ' (target ' + f2(mT) + ')');
    check(be + ': setTunnel(1) as a step is ramped (one frame later the wet and mid gains are below 60 % of their targets, after 0.3 s above 95 %)',
      r1[iw] >= 0 && r1[iw] < 0.6 * wT && r1[im] < 0.6 * mT && r2[iw] > 0.95 * wT && r2[im] > 0.95 * mT);
  }
  const rv = revWindow(w), kOff = rv.lastK + 1 / w.meta.fps;
  console.log('     reverb connected ' + f2(rv.on) + ' .. ' + f2(rv.off) + ' s; k > 0 last at ' + f2(rv.lastK) + ' s (k = 0 from ' + f2(kOff) + ' s)');
  check(be + ': reverb connected as soon as k > 0 (by 2.55 s) and while inside', rv.on <= 2.55);
  check(be + ': reverb disconnected about 2 s after k fell to 0 (between +1.9 and +2.3 s)', rv.off >= kOff + 1.9 && rv.off <= kOff + 2.3, 'last on at ' + f2(rv.off) + ' s');
  // tail: the go beep (0.5 s) at 1 s outside, at 5 s inside
  const ref0 = lvl(fx, 1.1, 1.45), ref1 = lvl(fx, 5.1, 5.45);
  const after0 = lvl(fx, 1.7, 1.8) - ref0, after1 = lvl(fx, 5.7, 5.8) - ref1, late1 = lvl(fx, 6.6, 6.7) - ref1;
  console.log('     beep level outside / inside ' + f1(ref0) + ' / ' + f1(ref1) + ' dBFS; 0.2 s after it ends: ' + f1(after0) + ' dB outside, ' + f1(after1) + ' dB inside; 1.1 s after: ' + f1(late1) + ' dB inside');
  check(be + ': outside the beep stops dead (more than 50 dB down 0.2 s after it ends)', after0 < -50, f1(after0) + ' dB');
  check(be + ': inside a reverb tail follows it (within 30 dB 0.2 s after it ends, and still decaying 1.1 s after)', after1 > -30 && late1 < after1 - 6, f1(after1) + ' / ' + f1(late1) + ' dB');
  const dc = decay(fx, 5.53, 7.95);
  check(be + ': the tail decays like the tunnel (RT60 from the -5..-25 dB slope within 0.9..2.0 s; the impulse is made for 1.4 s)', dc.rt60 >= 0.9 && dc.rt60 <= 2.0,
    'RT60 ' + f2(dc.rt60) + ' s (-5 dB at +' + f2(dc.t5) + ' s, -25 dB at +' + f2(dc.t25) + ' s)');
  for (const x of [w, eng, aero, tl, fx]) {
    let nan = 0, pk = 0;
    for (const c of x.ch) for (let i = 0; i < c.length; i++) { const v = c[i]; if (v !== v) nan++; else if (Math.abs(v) > pk) pk = Math.abs(v); }
    if (nan || pk >= 0.999 || x.meta.errors) check(be + ': ' + x.meta.scene + ' clean (no NaN, no clipping, no update() errors)', false, 'NaN ' + nan + ', peak ' + f2(pk) + ', errors ' + x.meta.errors);
  }
}
console.log('\n' + (total - failed) + ' / ' + total + ' tunnel checks passed');
process.exit(failed ? 1 : 0);
