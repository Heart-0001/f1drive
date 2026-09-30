const fs=require('fs'); const p='C:/Users/user/Desktop/f1drive/js/cockpit.js'; let s=fs.readFileSync(p,'utf8');
function rep(a,b){ if(!s.includes(a)) throw new Error('missing: '+a); s=s.replace(a,b); }
rep("taper(body, mBody, 0.42, 0.82, 0.46, 0.18, 0.95, 0.62, 0.40, 0.20);","taper(body, mBody, 0.42, 0.82, 0.44, 0.18, 0.95, 0.62, 0.38, 0.20);");
rep("taper(body, mBody, 0.95, 0.62, 0.40, 0.20, 2.35, 0.26, 0.16, 0.20);","taper(body, mBody, 0.95, 0.62, 0.38, 0.20, 2.35, 0.26, 0.22, 0.22);");
rep("taper(body, mBody, 2.35, 0.26, 0.16, 0.20, 2.78, 0.16, 0.08, 0.16);","taper(body, mBody, 2.35, 0.26, 0.22, 0.22, 2.78, 0.16, 0.14, 0.26);");
rep("taper(body, mCarbon, 0.60, 0.16, 0.006, 0.600, 0.95, 0.14, 0.006, 0.602);","taper(body, mCarbon, 0.60, 0.16, 0.006, 0.608, 0.95, 0.14, 0.006, 0.582);");
rep("taper(body, mCarbon, 0.95, 0.14, 0.006, 0.602, 2.35, 0.07, 0.006, 0.362);","taper(body, mCarbon, 0.95, 0.14, 0.006, 0.582, 2.35, 0.07, 0.006, 0.442);");
rep("taper(body, mAccent, 2.35, 0.26, 0.006, 0.362, 2.78, 0.16, 0.006, 0.242);","taper(body, mAccent, 2.35, 0.26, 0.006, 0.442, 2.78, 0.16, 0.006, 0.402);");
rep("box(body, mDark, 0.56, 0.20, 0.04, 0, 0.50, 0.42);","box(body, mDark, 0.80, 0.46, 0.04, 0, 0.40, 0.405);");
rep("box(body, mCarbon, 0.02, 0.10, 0.20, sx * 0.07, 0.16, 2.62);","box(body, mCarbon, 0.02, 0.16, 0.20, sx * 0.06, 0.19, 2.62);");
rep("[[0.40, 0.80, -1.00], [0.41, 0.93, -0.55], [0.40, 0.97, -0.10], [0.34, 0.985, 0.30], [0.19, 0.99, 0.58]]","[[0.40, 0.80, -1.00], [0.42, 0.95, -0.55], [0.42, 1.01, -0.10], [0.35, 1.03, 0.30], [0.19, 1.035, 0.58]]");
rep("new THREE.Vector3(0, 0.99, 0.68)","new THREE.Vector3(0, 1.035, 0.68)");
rep("40, 0.032, 7, false","40, 0.024, 7, false");
rep("box(group, mCarbon, 0.022, 0.46, 0.07, 0, 0.79, 0.79);","box(group, mCarbon, 0.022, 0.50, 0.07, 0, 0.80, 0.79);");
rep("pillar.rotation.x = -0.42;","pillar.rotation.x = -0.40;");
rep("box(hand, mGlove, 0.070, 0.070, 0.30, sx * 0.165, -0.06, -0.17).rotation.x = -0.25;","box(hand, mGlove, 0.055, 0.055, 0.30, sx * 0.170, -0.085, -0.17).rotation.x = -0.35;");
fs.writeFileSync(p,s);
