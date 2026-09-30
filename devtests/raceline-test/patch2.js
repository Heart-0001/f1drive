const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
const old=`            var r = 2 * h / (hp + hn + 1e-6), wn = r * r * r;
            if (wn < 0.3) wn = 0.3; else if (wn > 12) wn = 12;
            w[c] = it === 0 ? wn : 0.5 * (w[c] + wn);
            hp = hn;`;
const neu=`            var hl = 0.5 * (hp + hn) + 1e-6, r = h / hl, wn = r * r * r;
            if (wn < 0.3) wn = 0.3; else if (wn > 12) wn = 12;
            // IRLS towards sum(curvature^4): tight spots get heavier, which opens up the minimum radius
            var kk = Math.hypot(qx[b] - 2 * qx[c] + qx[e], qz[b] - 2 * qz[c] + qz[e]) / (hl * hl) / PEAK_CURV;
            kk = kk * kk; if (kk > PEAK_GAIN_MAX) kk = PEAK_GAIN_MAX;
            wn *= 1 + kk;
            w[c] = it === 0 ? wn : 0.5 * (w[c] + wn);
            hp = hn; b = c;`;
if(!s.includes(old)) throw 1; s=s.replace(old,neu);
s=s.replace("  var LENGTH_WEIGHT = 2.5e-4;", "  var PEAK_CURV = 1 / 40;     // curvature above which tight spots are penalised extra (IRLS weight)\n  var PEAK_GAIN_MAX = 40;\n  var LENGTH_WEIGHT = 2.5e-4;");
fs.writeFileSync(f,s);
