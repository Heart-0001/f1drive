const P = require('path').resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(P + '/lib/three.min.js');
require(P + '/tracks-data.js');
require(P + '/js/track.js');
require(P + '/js/car.js');
let synth = 0;
if (!process.env.FLAT) for (const t of global.F1_TRACKS) {
  if (t.elev && !process.env.SYNTH) continue;
  synth++;
  const n = t.points.length; let cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(t.points[i][0] - t.points[i - 1][0], t.points[i][1] - t.points[i - 1][1]));
  const L = cum[n - 1] + Math.hypot(t.points[0][0] - t.points[n - 1][0], t.points[0][1] - t.points[n - 1][1]);
  t.elev = cum.map(s => 22 + 16 * Math.sin(2 * Math.PI * 2 * s / L) + 6 * Math.sin(2 * Math.PI * 7 * s / L + 1));
}
if (process.env.FLAT) for (const t of global.F1_TRACKS) delete t.elev;
module.exports = { F1: global.F1, TRACKS: global.F1_TRACKS, THREE: global.THREE, synth };
