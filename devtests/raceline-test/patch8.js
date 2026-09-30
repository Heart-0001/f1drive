const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
const o="    var dOff = solveOffsets(N, kcs, lo, hi, ds);\n";
if(!s.includes(o)) throw 1;
s=s.replace(o,o+`    // two light [1,2,1] passes take out the 2 m scale kinks left where the line meets / leaves a bound
    var dTmp = new Float64Array(N), pass;
    for (pass = 0; pass < 2; pass++) {
      for (i = 0; i < N; i++) dTmp[i] = 0.25 * dOff[(i - 1 + N) % N] + 0.5 * dOff[i] + 0.25 * dOff[(i + 1) % N];
      for (i = 0; i < N; i++) dOff[i] = dTmp[i] < lo[i] ? lo[i] : (dTmp[i] > hi[i] ? hi[i] : dTmp[i]);
    }
`);
fs.writeFileSync(f,s);
