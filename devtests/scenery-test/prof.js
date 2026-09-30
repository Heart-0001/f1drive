const path='C:/Users/user/Desktop/f1drive/';
global.window=global; global.THREE=require(path+'lib/three.min.js');
require(path+'tracks-data.js'); try{require(path+'scenery-data.js');}catch(e){}
require(path+'js/track.js'); require(path+'js/scenery.js');
for(const id of process.argv.slice(2)){const td=F1_TRACKS.find(t=>t.id===id);const tr=F1.buildTrack(td);
 for(let k=0;k<3;k++){const sc=F1.buildScenery(tr,td,window.F1_SCENERY&&F1_SCENERY[id]);if(k==2)console.log(id,sc.stats.buildMs.toFixed(0),JSON.stringify(sc.stats.phases));sc.dispose();}}
