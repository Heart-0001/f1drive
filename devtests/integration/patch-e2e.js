const fs = require('fs');
let s = fs.readFileSync('mp-e2e.js', 'utf8');
const a = s.indexOf("    A.key('W', true);\n    let maxErr = 0");
const b = s.indexOf("    A.key('S', true); await sleep(2500)");
if (a < 0 || b < 0) throw new Error('markers');
const block = `    await B.js(\`window.__rec=[]; (function loop(){ if(!window.__rec) return; var p=F1.net.players[0]; if(p&&p.active) window.__rec.push([performance.now(),p.state.x,p.state.z,p.state.speed]); requestAnimationFrame(loop); })(); 1\`);
    A.key('W', true);
    await sleep(3000);
    await B.shot('5-A-drives-away');
    const rec = await B.js(\`(function(){var r=window.__rec; window.__rec=null; return r;})()\`);
    A.key('W', false);
    let maxDev = 0, moved = 0, maxDt = 0;
    for (let i = 1; i < rec.length; i++) {
      const dt = (rec[i][0] - rec[i - 1][0]) / 1000, st = Math.hypot(rec[i][1] - rec[i - 1][1], rec[i][2] - rec[i - 1][2]);
      moved += st; maxDt = Math.max(maxDt, dt);
      maxDev = Math.max(maxDev, Math.abs(st - 0.5 * (rec[i][3] + rec[i - 1][3]) * dt));
    }
    check('B\'s copy of A moves smoothly while A accelerates', rec.length > 30 && moved > 10 && maxDev < 0.6,
      { frames: rec.length, moved, maxDevMetresPerFrame: maxDev, maxFrameDt: maxDt, endSpeed: rec.length && rec[rec.length - 1][3] });
`;
s = s.slice(0, a) + block + s.slice(b).replace("A.key('S', true); await sleep(2500); A.key('S', false);\n    await A.until(`Math.abs(F1.game.car.state.speed) < 0.05`, 6000, 'A stops');",
  "A.key('S', true); await A.until(`F1.game.car.state.speed < 0.3`, 8000, 'A stops'); A.key('S', false);\n    await A.until(`Math.abs(F1.game.car.state.speed) < 0.05`, 6000, 'A stops');");
fs.writeFileSync('mp-e2e.js', s);
