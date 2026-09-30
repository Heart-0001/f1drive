const fs=require('fs'); const p='C:/Users/user/Desktop/f1drive/js/cockpit.js'; let s=fs.readFileSync(p,'utf8');
function rep(a,b){ if(!s.includes(a)) throw new Error('missing: '+a); s=s.replace(a,b); }
rep("      box(hand, mGlove, 0.055, 0.055, 0.30, sx * 0.170, -0.085, -0.17).rotation.x = -0.35; // forearms\n","");
rep("var HANDWHEEL_VIS = 1.35;","var HANDWHEEL_VIS = 1.0; ");
fs.writeFileSync(p,s);
