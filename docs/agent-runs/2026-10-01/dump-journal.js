// node dump.js <journal.jsonl> [label-substring] [fields,comma]
const fs = require('fs');
const [file, want, fields] = process.argv.slice(2);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const labels = {};
for (const l of lines) if (l.type === 'started') labels[l.agentId || l.key] = l.label, labels[l.key] = l.label;
const F = (fields || 'summary,testsRun,bugsFound,openIssues,apiNotes,filesChanged').split(',');
for (const l of lines) {
  if (l.type !== 'result') continue;
  const label = labels[l.key] || labels[l.agentId] || l.key;
  if (want && want !== '*' && String(label).indexOf(want) < 0) continue;
  let r = l.result !== undefined ? l.result : l.value;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) {} }
  console.log('\n################ ' + label);
  if (!r || typeof r !== 'object') { console.log(String(r).slice(0, 4000)); continue; }
  for (const f of F) {
    if (!(f in r)) continue;
    console.log('\n== ' + f);
    const v = r[f];
    if (typeof v === 'string') console.log(v);
    else if (Array.isArray(v)) v.forEach(x => console.log(' - ' + (typeof x === 'string' ? x : JSON.stringify(x))));
    else console.log(JSON.stringify(v, null, 1));
  }
}
