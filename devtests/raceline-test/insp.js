const path = require('path');const ROOT = 'C:/Users/user/Desktop/f1drive';
global.window = global;global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));require(path.join(ROOT, 'js/track.js'));require(path.join(ROOT, 'js/car.js'));require(path.join(ROOT, 'js/raceline.js'));
const td = F1_TRACKS.find(t => new RegExp(process.argv[2], 'i').test(t.name)), c = +process.argv[3];
const tr = F1.buildTrack(td), l = F1.buildRaceLine(tr), P = l.points, S = tr.samples, N = P.length, ds = tr.length / N;
for (let i = c - 9; i <= c + 9; i++) { const s = S[i], p = P[i], a = S[i - 2], b = S[i + 2]; const kc = ((b.tx - a.tx) * s.nx + (b.tz - a.tz) * s.nz) / (4 * ds);
  console.log(i, 'd', p.d.toFixed(3), 'halfW', s.halfW.toFixed(2), 'wall+', s.wallPosDist.toFixed(1), 'wall-', s.wallNegDist.toFixed(1), 'Rc', (1 / kc).toFixed(0), 'fold', (0.75 / Math.abs(kc)).toFixed(1), 'lineR', (1 / p.curvature).toFixed(0), 'v', (p.speed * 3.6).toFixed(0)); }
