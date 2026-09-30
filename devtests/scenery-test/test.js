const path='C:/Users/user/Desktop/f1drive/';
global.window=global; global.THREE=require(path+'lib/three.min.js');
require(path+'tracks-data.js');
try{require(path+'scenery-data.js');}catch(e){console.log('no scenery data');}
require(path+'js/track.js'); require(path+'js/scenery.js');
F1.SCENERY_DEBUG=true;
const only=process.argv[2];
let worst={tris:0,dc:0,ms:0}, fails=0;
function check(td,data,label){
  const track=F1.buildTrack(td); const S=track.samples,N=S.length;
  const t0=performance.now(); const sc=F1.buildScenery(track,td,data); const ms=performance.now()-t0;
  const lim=(s,side)=>Math.max(side>0?(s.wallPosDist??track.wallDist):(s.wallNegDist??track.wallDist),(s.halfW??7)+1)+1.5;
  // brute clearance
  let inC=0;function viol(x,z,r){ if(track.inCorridor&&track.inCorridor(x,z,0)&&!(r>0))inC++;let worst=Infinity,wi=-1;for(let i=0;i<N;i++){const s=S[i],dx=x-s.x,dz=z-s.z;if(Math.abs(dx)>40||Math.abs(dz)>40)continue;const d=Math.hypot(dx,dz)-(r||0);const v=d-lim(s,(dx*s.nx+dz*s.nz)>=0?1:-1);if(v<worst){worst=v;wi=i;}}return [worst,wi];}
  let nanCount=0,tris=0,vfail=0,ffail=0,failKinds={};
  sc.group.traverse(o=>{ if(!o.geometry)return; const g=o.geometry;
    for(const k in g.attributes){const a=g.attributes[k].array;for(let i=0;i<a.length;i++)if(!Number.isFinite(a[i]))nanCount++;}
    if(o.isInstancedMesh){const a=o.instanceMatrix.array;for(let i=0;i<a.length;i++)if(!Number.isFinite(a[i]))nanCount++;
      return;}
    const p=g.attributes.position.array;
    for(let i=0;i<p.length;i+=3){const [v,wi]=viol(p[i],p[i+2]); if(v<-1e-3){ if(p[i+1] < S[wi].y+6-1e-6){vfail++; failKinds[o.name]=(failKinds[o.name]||0)+1; if(vfail<4)console.log('  VERT',o.name,p[i].toFixed(1),p[i+1].toFixed(1),p[i+2].toFixed(1),'v',v.toFixed(2),'sample',wi);} } }
  });
  const pip=(x,z,p)=>{let c=false;for(let i=0,n=p.length,j=n-1;i<n;j=i++){const a=p[i],b=p[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])c=!c;}return c;};
  for(const f of sc.debug.footprints){
    if(f.k==='gantry-beam'){ if(!(f.minY>=S[f.sample].y+6)) {ffail++;console.log('  gantry low');} continue;}
    if(f.k==='bridge'&&f.over){ continue; }
    const p=f.p; const closed=p.length>2; const n=closed?p.length:p.length-1;
    let bad=false;
    if(p.length===1){ if(viol(p[0][0],p[0][1],f.r||0)[0]<-1e-3)bad=true; }
    for(let i=0;i<n&&!bad;i++){const a=p[i],b=p[(i+1)%p.length];const l=Math.hypot(b[0]-a[0],b[1]-a[1]);const st=Math.max(1,Math.ceil(l/0.5));
      for(let q=0;q<=st;q++){if(viol(a[0]+(b[0]-a[0])*q/st,a[1]+(b[1]-a[1])*q/st)[0]<-1e-3){bad=true;break;}}}
    if(closed&&!bad){ let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9; for(const q of p){x0=Math.min(x0,q[0]);x1=Math.max(x1,q[0]);z0=Math.min(z0,q[1]);z1=Math.max(z1,q[1]);}
      for(let i=0;i<N;i++){const s=S[i]; if(s.x<x0||s.x>x1||s.z<z0||s.z>z1)continue; if(pip(s.x,s.z,p)){bad=true;break;}} }
    if(bad){ffail++;failKinds[f.k]=(failKinds[f.k]||0)+1;}
  }
  const st=sc.stats;
  const okB = st.triangles<=400000 && st.drawCalls<=25;
  if(nanCount||vfail||ffail||!okB) fails++;
  worst.tris=Math.max(worst.tris,st.triangles);worst.dc=Math.max(worst.dc,st.drawCalls);worst.ms=Math.max(worst.ms,ms);
  console.log((td.id+' '+label).padEnd(16),'tris',String(st.triangles).padStart(7),'dc',st.drawCalls,'ms',ms.toFixed(0).padStart(4),'fp',sc.debug.footprints.length,'nan',nanCount,'vfail',vfail,'ffail',ffail,'inCorr',inC,JSON.stringify(failKinds),JSON.stringify(st.counts));
  sc.dispose(); if(sc.group.children.length)console.log('  dispose left children'); track.dispose();
}
for(const td of F1_TRACKS){ if(only&&td.id!==only)continue;
  const d=window.F1_SCENERY&&window.F1_SCENERY[td.id];
  if(d)check(td,d,'data');
  check(td,undefined,'proc');
}
// warm timing second pass
console.log('WORST',JSON.stringify(worst),'FAILS',fails);
