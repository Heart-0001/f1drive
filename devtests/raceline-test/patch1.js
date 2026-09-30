const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
const a=s.indexOf('      // projected SOR on'), b=s.indexOf('      prevD = d; prevM = M;');
const neu=`      // projected SOR on  sum w[i] |P[i-1] - 2P[i] + P[i+1]|^2 + lam * sum |P[i+1] - P[i]|^2
      // w[i] = (h / local point spacing)^3 turns the second difference into true curvature^2 * ds
      // (without it the tightly spaced inside of a hairpin looks "cheap" and the line hugs the inside).
      var lam = LENGTH_WEIGHT * h * h, omega = 1.4, it, n = iters[li], w = new Float64Array(M);
      for (it = 0; it < n; it++) {
        var a, b, c, e, g;
        if ((it & 3) === 0) {
          b = M - 1;
          var hp = Math.hypot(qx[0] - qx[b], qz[0] - qz[b]);
          for (c = 0; c < M; c++) {
            e = c + 1; if (e >= M) e = 0;
            var hn = Math.hypot(qx[e] - qx[c], qz[e] - qz[c]);
            var r = 2 * h / (hp + hn + 1e-6), wn = r * r * r;
            if (wn < 0.3) wn = 0.3; else if (wn > 12) wn = 12;
            w[c] = it === 0 ? wn : 0.5 * (w[c] + wn);
            hp = hn;
          }
        }
        a = M - 2; b = M - 1; e = 1; g = 2;
        for (c = 0; c < M; c++) {
          var wb = w[b], wc = w[c], we = w[e];
          var sx = -wb * (qx[a] - 2 * qx[b] + cx[c]) + 2 * wc * (qx[b] - 2 * cx[c] + qx[e]) - we * (cx[c] - 2 * qx[e] + qx[g]) +
                   lam * (qx[b] + qx[e] - 2 * cx[c]);
          var sz = -wb * (qz[a] - 2 * qz[b] + cz[c]) + 2 * wc * (qz[b] - 2 * cz[c] + qz[e]) - we * (cz[c] - 2 * qz[e] + qz[g]) +
                   lam * (qz[b] + qz[e] - 2 * cz[c]);
          var dn = (sx * ux[c] + sz * uz[c]) / (wb + 4 * wc + we + 2 * lam);
          dn = d[c] + omega * (dn - d[c]);
          if (dn < bl[c]) dn = bl[c]; else if (dn > bh[c]) dn = bh[c];
          d[c] = dn;
          qx[c] = cx[c] + ux[c] * dn; qz[c] = cz[c] + uz[c] * dn;
          a = b; b = c; e = g; g = g + 1; if (g >= M) g = 0;
        }
      }
`;
s=s.slice(0,a)+neu+s.slice(b);fs.writeFileSync(f,s);
