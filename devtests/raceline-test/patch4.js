const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
const a=s.indexOf('      var omega = 1.3, it, n = iters[li]'), b=s.indexOf('      prevD = d; prevM = M;');
if(a<0||b<0) throw 1;
const neu=`      var omega = 1.3, it, n = iters[li], a, b, c, e, g, i2h = 1 / (2 * h);
      var q, sl, t, r, kk;
      for (it = 0; it < n; it++) {
        if ((it & 3) === 0) {   // refresh the lagged peak-curvature weights
          b = M - 1;
          for (c = 0; c < M; c++) {
            e = c + 1; if (e >= M) e = 0;
            q = 1 - K[c] * d[c]; if (q < 0.2) q = 0.2;
            sl = (d[e] - d[b]) * i2h;
            t = q * q + sl * sl;
            r = q * (q * K[c] + (d[b] - 2 * d[c] + d[e]) * ih2) + 2 * K[c] * sl * sl;
            kk = r / (t * Math.sqrt(t) * PEAK_CURV); kk = kk * kk; if (kk > PEAK_GAIN_MAX) kk = PEAK_GAIN_MAX;
            W[c] = it === 0 ? 1 + kk : 0.5 * (W[c] + 1 + kk);
            b = c;
          }
        }
        a = M - 2; b = M - 1; e = 1; g = 2;
        for (c = 0; c < M; c++) {
          var u = d[c], kc = K[c], grad, hess, rp, den;
          // own node: r = q (q kc + d'') + 2 kc d'^2,  energy = r^2 / (q^2 + d'^2)^2.5
          q = 1 - kc * u; if (q < 0.2) q = 0.2;
          sl = (d[e] - d[b]) * i2h;
          var dd = (d[b] + d[e] - 2 * u) * ih2;
          t = q * q + sl * sl; den = t * t * Math.sqrt(t);
          r = q * (q * kc + dd) + 2 * kc * sl * sl;
          rp = -kc * (2 * q * kc + dd) - 2 * q * ih2;
          grad = W[c] * r / den * (2 * rp + 5 * kc * q * r / t);
          hess = W[c] * 2 * rp * rp / den;
          // previous node (u enters its d'' and d')
          q = 1 - K[b] * d[b]; if (q < 0.2) q = 0.2;
          sl = (u - d[a]) * i2h;
          t = q * q + sl * sl; den = t * t * Math.sqrt(t);
          r = q * (q * K[b] + (d[a] - 2 * d[b] + u) * ih2) + 2 * K[b] * sl * sl;
          rp = q * ih2 + 4 * K[b] * sl * i2h;
          grad += W[b] * r / den * (2 * rp - 5 * sl * i2h * r / t);
          hess += W[b] * 2 * rp * rp / den;
          // next node
          q = 1 - K[e] * d[e]; if (q < 0.2) q = 0.2;
          sl = (d[g] - u) * i2h;
          t = q * q + sl * sl; den = t * t * Math.sqrt(t);
          r = q * (q * K[e] + (u - 2 * d[e] + d[g]) * ih2) + 2 * K[e] * sl * sl;
          rp = q * ih2 - 4 * K[e] * sl * i2h;
          grad += W[e] * r / den * (2 * rp + 5 * sl * i2h * r / t);
          hess += W[e] * 2 * rp * rp / den;
          // path length
          grad += LENGTH_WEIGHT * (-kc + (2 * u - d[b] - d[e]) * ih2);
          hess += LENGTH_WEIGHT * 2 * ih2;

          var st = -omega * grad / hess;
          if (st > 1) st = 1; else if (st < -1) st = -1;
          u += st;
          if (u < bl[c]) u = bl[c]; else if (u > bh[c]) u = bh[c];
          d[c] = u;
          a = b; b = c; e = g; g = g + 1; if (g >= M) g = 0;
        }
      }
`;
s=s.slice(0,a)+neu+s.slice(b);
s=s.replace("      var W = new Float64Array(M);   // P / q^3 per node","      var W = new Float64Array(M);   // lagged peak weight P per node");
s=s.replace(/  \/\/   line curvature  k = \(d'' \+ kc\*q\) \/ q\^2,   line arc element = q ds,   q = 1 - d\*kc\n  \/\/ and minimises  sum P \* k\^2 \* q  \+  LENGTH_WEIGHT \* length/,
"  //   line curvature  k = (q (q kc + d'') + 2 kc d'^2) / (q^2 + d'^2)^1.5,   q = 1 - d*kc\n  // and minimises  sum P * k^2 * (line arc element)  +  LENGTH_WEIGHT * length");
fs.writeFileSync(f,s);
