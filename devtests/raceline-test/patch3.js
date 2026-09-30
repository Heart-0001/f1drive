const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
const a=s.indexOf('  // Returns Float64Array d[N]'), b=s.indexOf('  // ------------------------------------------------------------------ build');
const neu=`  // Returns Float64Array d[N]: lateral offsets of a minimum-curvature path inside [lo, hi].
  // Works in the track (Frenet) frame: for offset d(s) from a centreline of curvature kc(s)
  //   line curvature  k = (d'' + kc*q) / q^2,   line arc element = q ds,   q = 1 - d*kc
  // and minimises  sum P * k^2 * q  +  LENGTH_WEIGHT * length  by projected Gauss-Newton coordinate descent
  // (coarse to fine). P = 1 + (k / PEAK_CURV)^2 (lagged) pushes towards a larger minimum radius.
  function solveOffsets(N, kcs, lo, hi, ds) {
    var levels = [8, 4, 2, 1], iters = [1500, 400, 150, 60];
    var prevD = null, prevM = 0, li;
    for (li = 0; li < levels.length; li++) {
      var M = levels[li] === 1 ? N : Math.max(12, Math.round(N / levels[li]));
      if (M > N) M = N;
      if (M === prevM) continue;
      var ratio = N / M, h = ds * ratio, ih2 = 1 / (h * h);
      var K = new Float64Array(M), bl = new Float64Array(M), bh = new Float64Array(M), d = new Float64Array(M);
      var W = new Float64Array(M);   // P / q^3 per node
      var j, k;
      for (j = 0; j < M; j++) {
        var pos = j * ratio, i0 = Math.floor(pos), f = pos - i0;
        if (i0 >= N) i0 -= N;
        var l = -Infinity, hh = Infinity;
        if (M === N) { l = lo[j]; hh = hi[j]; K[j] = kcs[j]; }
        else {
          var span = Math.ceil(ratio), half = Math.ceil(ratio / 2), ksum = 0;
          for (k = -span; k <= span + 1; k++) {
            var q0 = ((i0 + k) % N + N) % N;
            if (lo[q0] > l) l = lo[q0];
            if (hi[q0] < hh) hh = hi[q0];
          }
          for (k = -half; k <= half; k++) ksum += kcs[((i0 + k) % N + N) % N];
          K[j] = ksum / (2 * half + 1);
          if (l > hh) l = hh = 0.5 * (l + hh);
        }
        bl[j] = l; bh[j] = hh;
        var dv = 0;
        if (prevD) {
          var pp = j * prevM / M, p0 = Math.floor(pp), pf = pp - p0;
          p0 %= prevM;
          dv = prevD[p0] + (prevD[(p0 + 1) % prevM] - prevD[p0]) * pf;
        }
        d[j] = dv < l ? l : (dv > hh ? hh : dv);
      }
      var omega = 1.3, it, n = iters[li], a, b, c, e, g, q, nn, kk;
      for (it = 0; it < n; it++) {
        if ((it & 3) === 0) {
          b = M - 1;
          for (c = 0; c < M; c++) {
            e = c + 1; if (e >= M) e = 0;
            q = 1 - K[c] * d[c]; if (q < 0.2) q = 0.2;
            nn = (d[b] - 2 * d[c] + d[e]) * ih2 + K[c] * q;
            kk = nn / (q * q * PEAK_CURV); kk = kk * kk; if (kk > PEAK_GAIN_MAX) kk = PEAK_GAIN_MAX;
            kk = (1 + kk) / (q * q * q);
            W[c] = it === 0 ? kk : 0.5 * (W[c] + kk);
            b = c;
          }
        }
        a = M - 2; b = M - 1; e = 1; g = 2;
        for (c = 0; c < M; c++) {
          var u = d[c], kc = K[c];
          q = 1 - kc * u; if (q < 0.2) q = 0.2;
          var wc = W[c], wb = W[b], we = W[e], bb = 2 * ih2 + kc * kc;
          nn = (d[b] + d[e] - 2 * u) * ih2 + kc * q;
          var nb = (d[a] - 2 * d[b] + u) * ih2 + K[b] * (1 - K[b] * d[b]);
          var ne = (u - 2 * d[e] + d[g]) * ih2 + K[e] * (1 - K[e] * d[e]);
          // d/du of  wc*q^3 * nn^2/q^3  (the 1/q^3 part of wc is differentiated exactly, P is lagged)
          var grad = wc * (-2 * bb * nn + 3 * kc * nn * nn / q) + 2 * ih2 * (wb * nb + we * ne) +
                     LENGTH_WEIGHT * (-kc + (2 * u - d[b] - d[e]) * ih2);
          var hess = wc * 2 * bb * bb + 2 * ih2 * ih2 * (wb + we) + LENGTH_WEIGHT * 2 * ih2;
          var st = -omega * grad / hess;
          if (st > 1) st = 1; else if (st < -1) st = -1;
          u += st;
          if (u < bl[c]) u = bl[c]; else if (u > bh[c]) u = bh[c];
          d[c] = u;
          a = b; b = c; e = g; g = g + 1; if (g >= M) g = 0;
        }
      }
      prevD = d; prevM = M;
    }
    return prevD;
  }

`;
s=s.slice(0,a)+neu+s.slice(b);
// caller: compute smoothed centreline curvature array and pass it
const o1=`      var a = S[(i - 2 + N) % N], b = S[(i + 2) % N];
      var kc = ((b.tx - a.tx) * s.nx + (b.tz - a.tz) * s.nz) / (4 * ds);`;
const n1=`      var a = S[(i - 2 + N) % N], b = S[(i + 2) % N];
      var kc = ((b.tx - a.tx) * s.nx + (b.tz - a.tz) * s.nz) / (4 * ds);
      kcs[i] = kc;`;
if(!s.includes(o1)) throw 1; s=s.replace(o1,n1);
s=s.replace("var lo = new Float64Array(N), hi = new Float64Array(N);","var lo = new Float64Array(N), hi = new Float64Array(N), kcs = new Float64Array(N);");
if(!s.includes("var dOff = solveOffsets(N, px, pz, nx, nz, lo, hi, ds);")) throw 2;
s=s.replace("var dOff = solveOffsets(N, px, pz, nx, nz, lo, hi, ds);","var dOff = solveOffsets(N, kcs, lo, hi, ds);");
fs.writeFileSync(f,s);
