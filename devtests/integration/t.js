const P=require('path').resolve(__dirname, '..', '..')+'/';
const fs=require('fs');
let raf=null, keyH={};
const noop=()=>{};
function elStub(){return {classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},addEventListener:noop,children:[],style:{},getContext:()=>new Proxy({}, {get:()=>noop}),set innerHTML(v){this._h=v},textContent:'',value:'',blur:noop,getAttribute:()=>'0'};}
const els={};
global.document={readyState:'complete',getElementById:id=>els[id]||(els[id]=elStub()),createElement:()=>elStub(),addEventListener:noop,activeElement:null,hidden:false};
global.window=global; window.innerWidth=800;window.innerHeight=600;window.devicePixelRatio=1;
window.addEventListener=(n,f)=>{keyH[n]=f};
global.requestAnimationFrame=f=>{raf=f;return 1}; global.cancelAnimationFrame=()=>{raf=null};
const O=function(){this.position={set:noop};this.add=noop;this.remove=noop;};
window.THREE={WebGLRenderer:function(){this.setPixelRatio=noop;this.setSize=noop;this.render=noop},Scene:O,Color:O,Fog:O,PerspectiveCamera:function(){O.call(this);this.updateProjectionMatrix=noop},HemisphereLight:O,DirectionalLight:O};
eval(fs.readFileSync(P+'tracks-data.js','utf8'));
const N=1000; let huds=[];
window.F1={buildTrack:()=>({group:{},samples:new Array(N),dispose:noop}),
 createCar:()=>({state:{x:0,z:0,heading:0,speed:0,sampleIndex:0},reset(t,i){this.state.sampleIndex=i;this.state.speed=0},update(dt,inp){this.state.speed=script.speed;this.state.sampleIndex=((this.state.sampleIndex+script.step)%N+N)%N}}),
 createCockpit:()=>({group:{},update:noop})};
let script={speed:50,step:5};
eval(fs.readFileSync(P+'js/ui.js','utf8'));
const realUpd=F1.ui.updateHUD; F1.ui.updateHUD=h=>{huds.push({...h});realUpd(h)};
let sel; const realInit=F1.ui.init; F1.ui.init=o=>{sel=o.onSelectTrack;realInit(o)};
eval(fs.readFileSync(P+'js/main.js','utf8'));
console.log('grid html len',els['track-grid']._h.length);
sel(F1_TRACKS[0]);
let t=0; function run(k){for(let i=0;i<k;i++){t+=20;raf(t)}}
const last=()=>huds[huds.length-1];
run(1); run(3); console.log('after cross',last().lap,last().curTime);
run(200); console.log('after 1 lap',last().lap,last().lastTime,last().bestTime,F1.ui.formatTime(last().lastTime));
// reverse over the line and come forward again: must not count
script={speed:-10,step:-5}; run(10); script={speed:50,step:5}; run(12); console.log('reverse/forward',last().lap,last().lastTime);
run(200); console.log('after lap 2',last().lap,last().lastTime);
// full lap backwards then forward over line
script={speed:-10,step:-5}; run(210); script={speed:50,step:5}; run(30); console.log('backward lap',last().lap);
console.log(F1.ui.formatTime(null),F1.ui.formatTime(83.4567),last().gear);
keyH.keydown({code:'Escape',preventDefault:noop}); console.log('raf after esc',raf);
