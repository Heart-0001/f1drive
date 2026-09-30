const path = require('path');const ROOT = 'C:/Users/user/Desktop/f1drive';
global.window = global;global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));require(path.join(ROOT, 'js/track.js'));require(path.join(ROOT, 'js/car.js'));require(path.join(ROOT, 'js/raceline.js'));
let worst=0;
for (const td of F1_TRACKS){const tr=F1.buildTrack(td),l=F1.buildRaceLine(tr),P=l.points,N=P.length;let ch=0,prev=0;
 for(let i=0;i<N;i++){const dd=P[(i+1)%N].d-P[i].d; if(Math.abs(dd)<1e-4)continue; const s=Math.sign(dd); if(prev&&s!==prev)ch++; prev=s;}
 worst=Math.max(worst,ch); if(/Monza|Spa|Monaco/.test(td.name)) console.log(td.name,'d-direction reversals per lap',ch);}
console.log('max reversals any track',worst);
// significant swings: list extrema of d for Monza with swing > 0.15 m, and the smallest swings
{const td=F1_TRACKS.find(t=>/Monza/.test(t.name)),tr=F1.buildTrack(td),l=F1.buildRaceLine(tr),P=l.points,N=P.length;
 const ex=[];let prev=0;for(let i=0;i<N;i++){const dd=P[(i+1)%N].d-P[i].d;if(Math.abs(dd)<1e-4)continue;const s=Math.sign(dd);if(prev&&s!==prev)ex.push([i,P[i].d]);prev=s;}
 console.log(ex.map(e=>e[0]+':'+e[1].toFixed(2)).join('  '));
 let maxLat=0;for(let i=0;i<N;i++){ if(Math.abs(P[i].curvature)<1/400){} }
}
