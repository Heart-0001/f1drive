const path=require('path').resolve(__dirname, '..', '..')+'/';
global.window=global; global.THREE=require(path+'lib/three.min.js');
require(path+'tracks-data.js'); require(path+'js/track.js'); require(path+'js/scenery.js');
const td=F1_TRACKS.find(t=>t.id===process.argv[2]);const tr=F1.buildTrack(td);
try{require(path+'scenery-data.js');}catch(e){} const sc=F1.buildScenery(tr,td,window.F1_SCENERY&&F1_SCENERY[td.id]);console.log(sc.stats.buildMs.toFixed(0),JSON.stringify(sc.stats.phases));
