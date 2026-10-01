// What the game would show with a given raw height profile: tools/build-tracks.mjs's filters (copied, read-only
// reference: medianLoop / gaussLoop / slopeLimitLoop / gaussLoop(1), DTM or GLO-90 or FLAT parameters) followed by
// js/track.js's Y_SMOOTH_PASSES = 40 passes of [1, 2, 1] / 4 on ~2 m samples (a Gaussian of sigma ~ sqrt(40 / 2) samples
// = ~8.9 m). Input: raw heights on a closed loop every ds metres. Output: the predicted in-game profile, same sampling.
export const BUILD = {
  dtm: { medHalf: 2, sigma: 20 },          // DTM_MEDIAN_HALF, DTM_GAUSS_SIGMA (m)
  glo90: { medHalf: 2, sigma: 50 },        // MEDIAN_HALF, GAUSS_SIGMA
  flat: { medHalf: 6, sigma: 250, maxRange: 4 },
  maxSlope: 0.18, trackSigma: Math.sqrt(40 / 2) * 2,   // MAX_SLOPE; js/track.js smoothing in metres
};
function medianLoop(h, half) {
  const m = h.length;
  return h.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]); w.sort((a, b) => a - b); return w[half]; });
}
function gaussLoop(h, sigma) {
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), Math.floor((m - 1) / 2)), k = [];
  let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => { let acc = 0; for (let j = -r; j <= r; j++) acc += k[j + r] * h[((i + j) % m + m) % m]; return acc / sum; });
}
function slopeLimitLoop(h, maxStep) {
  const m = h.length;
  return h.map((_, i) => {
    let lo = -Infinity, hi = Infinity;
    for (let j = 0; j < m; j++) {
      const d = Math.min(Math.abs(i - j), m - Math.abs(i - j)) * maxStep;
      if (h[j] - d > lo) lo = h[j] - d;
      if (h[j] + d < hi) hi = h[j] + d;
    }
    return (lo + hi) / 2;
  });
}
// kind: 'dtm' | 'glo90' | 'flat'. The build samples every 10 m (DTM) / 25 m (GLO-90); here the input's own ds is used.
export function predictGame(raw, ds, kind = 'dtm', over = null) {
  const P = Object.assign({}, BUILD[kind], over || {});
  let h = medianLoop(raw, Math.max(1, Math.round(P.medHalf * (kind === 'dtm' ? 10 : 25) / ds)));
  h = gaussLoop(h, P.sigma / ds);
  h = slopeLimitLoop(h, BUILD.maxSlope * ds);
  h = gaussLoop(h, 1);
  const mn = Math.min(...h), rg = Math.max(...h) - mn;
  const sc = kind === 'flat' && rg > P.maxRange ? P.maxRange / rg : 1;
  h = h.map((v) => (v - mn) * sc);
  return gaussLoop(h, BUILD.trackSigma / ds);
}
