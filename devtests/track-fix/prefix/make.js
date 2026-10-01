// node devtests/track-fix/prefix/make.js -> devtests/track-fix/prefix/track-pre.js = js/track.js with the kerb-mask and
// groundY fixes of 2026-10-01 taken out again (the review probes ran against that to reproduce the findings:
//   node devtests/track-fix/prefix/vw/kerb-taper.js, node devtests/track-fix/prefix/vw/groundy.js). Breaks once
// js/track.js moves on; the logs it produced are devtests/track-fix/baseline/{kerb-taper,groundy}.log.
const fs = require('fs');
let s = fs.readFileSync(require('path').join(__dirname, '..', '..', '..', 'js', 'track.js'), 'utf8').replace(/\r\n/g, '\n');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 60)); s = s.replace(a, b); };
rep("          // the kerbs were laid out before the lane: none where the lane's asphalt adjoins the road edge (tapers)\n          if (P.ao[k] > halfW[i] + 0.05) kerbMask[sd][i] = 0;\n", '');
rep('        dropShortRuns(kerbMask[sd], 4);\n        wallIn[sd] = line(L.side, wallOff[sd]);', '        wallIn[sd] = line(L.side, wallOff[sd]);');
rep('if (n.dist > gyReach + 2) return terrainAt(x, z);   // (beyond every verge: plain terrain)', 'if (n.dist > WALL_DIST + WALL_THICK + SKIRT_W + 2) return terrainAt(x, z);');
fs.writeFileSync(__dirname + '/track-pre.js', s);   // generated: do not edit
console.log('ok');
