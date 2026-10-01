const L = require('../lib.js'), { drive } = require('../driver.js');
for (const a of process.argv.slice(2)) {
  const [name, hj] = a.split(/:(.*)/s);
  const F1 = L.load(L.variant(name, hj ? JSON.parse(hj) : undefined));
  const tr = L.track(F1, 'mc-1929'), S = tr.samples;
  for (const mode of ['keys', 'analog']) {
    const r = drive(F1, tr, { mode, trace: [600, 665], laps: 3 });
    const fly = r.trace.filter(q => q.lap === 2);
    const by = {};
    for (const q of fly) if (!(q.i in by)) by[q.i] = q;
    console.log(`=== ${a} ${mode} lap2 ${r.laps[2] && r.laps[2].toFixed(2)}`);
    const out = [];
    for (let i = 612; i <= 660; i += 3) { const q = by[i]; if (q) out.push(`${i}: v ${(q.v*3.6).toFixed(0)}/${(q.lineV*3.6).toFixed(0)} d ${q.d.toFixed(1)}/${q.lineD.toFixed(1)} hw ${S[i].halfW.toFixed(1)} st ${q.steer.toFixed(2)}`); }
    console.log('  ' + out.join('\n  '));
  }
}
