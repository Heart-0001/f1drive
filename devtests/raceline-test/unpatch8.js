const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
const a=s.indexOf("    // two light [1,2,1] passes"), b=s.indexOf("    // line points, heights, segment lengths");
if(a<0||b<0) throw 1; s=s.slice(0,a)+"\n"+s.slice(b); fs.writeFileSync(f,s);
