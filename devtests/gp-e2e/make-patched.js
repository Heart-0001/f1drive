// node devtests/gp-e2e/make-patched.js
// Writes MUTANTS (deliberately broken copies of project files, to see that the checks notice) into
// devtests/gp-e2e/mutants/ (the project files themselves are not touched); run a harness against them with PATCH, e.g.
//   PATCH='js/ui.js=devtests/gp-e2e/mutants/ui.lap-text.js,net/session.js=devtests/gp-e2e/mutants/session.timeout60.js' npx electron devtests/gp-e2e/online.js
// Each copy is the current project file plus the edits, so it never goes stale; a copy whose anchor is gone is skipped
// with a message and the old copy, if any, is left alone: delete it.
// (The product fixes this folder once proposed as patched copies - the online race clock at lights out, the room texts
// once the room has a track - are in js/main.js / js/ui.js now.)
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

let skipped = 0;
function make(rel, out, edits) {
  try { write(rel, out, edits); } catch (e) { skipped++; console.log('SKIPPED devtests/gp-e2e/' + out + ': ' + e.message); }
}
function write(rel, out, edits) {
  let s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const eol = s.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  edits.forEach(e => {
    const find = e.find.replace(/\n/g, eol), put = e.put.replace(/\n/g, eol);
    if (s.indexOf(find) < 0) throw new Error(rel + ': anchor not found (already patched?): ' + e.find.split('\n')[0]);
    if (s.indexOf(find) !== s.lastIndexOf(find)) throw new Error(rel + ': anchor is not unique: ' + e.find.split('\n')[0]);
    s = s.replace(find, () => put);
  });
  const file = path.join(__dirname, out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s);
  console.log(rel + ' -> devtests/gp-e2e/' + out);
  edits.forEach(e => console.log('    - ' + e.find.split('\n').join('\n    - ') + '\n    + ' + e.put.split('\n').join('\n    + ')));
}

/* ---------- mutants (not patches!) ---------- */

// the "+n 圈" cell says something else
make('js/ui.js', 'mutants/ui.lap-text.js', [
  { find: "if (r.down > 0) return '+' + count(r.down) + ' 圈';", put: "if (r.down > 0) return '+' + count(r.down) + ' LAP';" }
]);
// the online race clock starts from the session time when the lights-out frame RUNS instead of at its timestamp: it
// runs ahead of the session clock by that frame's delay (start-clock.js and online.js notice it through the injected hitch)
make('js/main.js', 'mutants/main.go-clock.js', [
  { find: 'lap.time = gp.sinceGo - (gp.online ? (performance.now() - lastT) / 1000 : 0);', put: 'lap.time = gp.sinceGo;' }
]);
// the race closes 60 s after the winner instead of 90 s (loaded by the server AND by the page)
make('net/session.js', 'mutants/session.timeout60.js', [
  { find: 'var RACE_TIMEOUT_MS = 90000;', put: 'var RACE_TIMEOUT_MS = 60000;' }
]);

if (skipped) console.log(skipped + ' copy / copies not written (see above)');
