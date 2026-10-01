// node devtests/track-fix/diff-data.js <old tracks-data.js> [new tracks-data.js]
// What changed between two tracks-data.js files: ids / names / lengths / geo / points must be identical; per track,
// whether elev changed (range old -> new, max |change|) and the bankOverrides.
const path = require('path');
function load(f) { const g = { window: {} }; new Function('window', require('fs').readFileSync(f, 'utf8'))(g.window); return g.window.F1_TRACKS; }
const A = load(path.resolve(process.argv[2])), B = load(path.resolve(process.argv[3] || path.join(__dirname, '..', '..', 'tracks-data.js')));
let bad = 0;
if (A.length !== B.length) { console.log('track count differs', A.length, B.length); bad++; }
for (let i = 0; i < Math.min(A.length, B.length); i++) {
  const a = A[i], b = B[i];
  for (const k of ['id', 'name', 'location', 'lengthKm', 'geo', 'points']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { console.log(a.id, k, 'DIFFERS'); bad++; }
  const keys = Object.keys(b).filter(k => !['id', 'name', 'location', 'lengthKm', 'geo', 'points', 'elev', 'bankOverrides'].includes(k));
  if (keys.length) { console.log(b.id, 'unexpected fields', keys); bad++; }
  const same = JSON.stringify(a.elev) === JSON.stringify(b.elev);
  const rng = e => Math.max(...e) - Math.min(...e);
  let md = 0; for (let j = 0; j < a.elev.length; j++) md = Math.max(md, Math.abs(a.elev[j] - b.elev[j]));
  console.log(`${b.id.padEnd(8)} elev ${same ? 'unchanged' : `CHANGED range ${rng(a.elev).toFixed(1)} -> ${rng(b.elev).toFixed(1)} m, max |dh| ${md.toFixed(1)} m`}` +
    (b.bankOverrides ? '  bankOverrides ' + JSON.stringify(b.bankOverrides) : ''));
}
console.log(bad ? `${bad} PROBLEM(S): ids / names / lengths / geo / points must not change` : 'OK: ids, names, locations, lengths, geo and points identical');
