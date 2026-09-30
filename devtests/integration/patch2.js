const fs = require('fs');
let s = fs.readFileSync('mp-e2e.js', 'utf8');
s = s.replace("    A.key('W', true);\n    await sleep(3000);", "    await A.js(`window.__ft=[]; (function loop(t){ if(!window.__ft) return; window.__ft.push(t); requestAnimationFrame(loop); })(performance.now()); 1`);\n    A.key('W', true);\n    await sleep(3000);");
s = s.replace("    A.key('W', false);\n    let maxDev", "    A.key('W', false);\n    const ft = await A.js(`(function(){var r=window.__ft; window.__ft=null; return r;})()`);\n    let aMaxDt = 0; for (let i = 1; i < ft.length; i++) aMaxDt = Math.max(aMaxDt, ft[i] - ft[i - 1]);\n    console.log('A frames during drive:', ft.length, 'max frame gap ms', aMaxDt, 'B frames', rec.length);\n    let maxDev");
if (!s.includes('__ft')) throw new Error('no patch');
fs.writeFileSync('mp-e2e.js', s);
