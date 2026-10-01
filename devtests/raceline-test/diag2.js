const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/car.js'));
require('./rl_many.js');
const td = F1_TRACKS.find(t => new RegExp(process.argv[2],'i').test(t.name));
const track = F1.buildTrack(td), line = F1.buildRaceLine(track), S=track.samples, N=S.length, P=line.points;
const ds=track.length/N;
// local minima of limit speed
for (let i=0;i<N;i++){ const p=P[i]; let ismin=true; for(let k=-15;k<=15;k++){ if(P[(i+k+N)%N].speed<p.speed) ismin=false;} 
 if(ismin && p.speed<75){ const a=S[(i-2+N)%N], b=S[(i+2)%N], s=S[i]; const kc=((b.tx-a.tx)*s.nx+(b.tz-a.tz)*s.nz)/(4*ds);
  console.log(i, 'v', (p.speed*3.6).toFixed(0), 'lineR', (1/Math.abs(p.curvature)).toFixed(1), 'centreR', (1/Math.abs(kc)).toFixed(1), 'd', p.d.toFixed(2), 'dir', kc>0?'L':'R');}}
if (process.argv[3]) { const c=+process.argv[3]; for(let i=c-25;i<=c+25;i++){const p=P[(i+N)%N]; console.log(i,p.d.toFixed(2),(1/p.curvature).toFixed(1),(p.speed*3.6).toFixed(0));}}
