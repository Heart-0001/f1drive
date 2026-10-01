global.window = global;
const ROOT = require('path').resolve(__dirname, '..', '..');
global.THREE = require(ROOT + '/lib/three.min.js');
require(ROOT + '/js/car.js');
require(ROOT + '/js/cockpit.js');
const cam = new THREE.PerspectiveCamera(70, 16/9, 0.5, 4000);
let n=0; const o=cam.updateProjectionMatrix.bind(cam); cam.updateProjectionMatrix=()=>{n++;o();};
const c = F1.createCockpit(cam);
// v6: the cockpit is merged per material (84 meshes in v5 -> about 19 now); the detailed build is checked in
// devtests/cockpit-test/api.test.js, here only that it stays a handful of draw calls
let meshes=0; c.group.traverse(o=>{if(o.isMesh)meshes++;});
console.log('REV', THREE.REVISION, 'meshes', meshes, 'near', cam.near, 'far', cam.far, 'camParent', cam.parent===c.group);
if(meshes>30) throw new Error('too many meshes: '+meshes);
if(c.setCar) for(const s of ['modern','halo','halo18']){ c.setCar({cockpit:s}); console.log('style',s,JSON.stringify(c.info?{tris:c.info().triangles,draws:c.info().drawCalls}:{})); }
const st={x:5,z:7,heading:0.3,speed:0,steer:0,sampleIndex:0,d:0,onGrass:false,hit:0};
c.update(st,0); c.update(st,1/60);
for(let i=0;i<600;i++){st.speed=Math.min(91,st.speed+0.3);st.heading+=0.01;st.steer=Math.sin(i/30);st.hit=i==300?1:0;st.onGrass=i>400;c.update(st,1/60);
 if(![cam.position.x,cam.position.y,cam.rotation.x,cam.rotation.z,cam.fov].every(isFinite))throw new Error('nan');}
c.group.updateMatrixWorld(true);
const d=new THREE.Vector3(); cam.getWorldDirection(d);
console.log('fov',cam.fov.toFixed(2),'projUpdates',n,'camDir',d.x.toFixed(3),d.y.toFixed(3),d.z.toFixed(3),'expected fwd',Math.sin(st.heading).toFixed(3),Math.cos(st.heading).toFixed(3));
console.log('cam pos', cam.position.toArray().map(v=>v.toFixed(3)).join(','), 'rot', cam.rotation.x.toFixed(4), cam.rotation.z.toFixed(4));
if(Math.abs(d.x-Math.sin(st.heading))>0.01||Math.abs(d.z-Math.cos(st.heading))>0.01) throw new Error('camera does not look along the heading');
console.log('ok');
