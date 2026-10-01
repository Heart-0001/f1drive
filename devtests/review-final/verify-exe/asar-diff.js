// Compare every file in the exe's app.asar against the project sources (line endings ignored).
'use strict';
const path = require('path');
const fs = require('fs');
const asar = require(path.join(__dirname, '..', '..', '..', 'node_modules', '@electron', 'asar'));
const ROOT = path.join(__dirname, '..', '..', '..');
const ASAR = process.argv[2] || path.join(__dirname, 'x', 'app.asar');
const files = asar.listPackage(ASAR).map(f => f.replace(/^[\\/]/, '').replace(/\\/g, '/'));
const norm = b => b.toString('utf8').replace(/\r\n/g, '\n');
let same = 0, diff = [], missing = [], dirs = 0;
for (const f of files) {
  let buf;
  try { buf = asar.extractFile(ASAR, f.replace(/\//g, path.sep)); } catch (e) { dirs++; continue; }
  if (f.startsWith('node_modules/')) { same++; continue; }
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { missing.push(f); continue; }
  const a = norm(buf).split('\n'), b = norm(fs.readFileSync(src)).split('\n');
  if (a.join('\n') === b.join('\n')) { same++; continue; }
  // crude line diff: lines present in one but not the other
  const sa = new Set(a), sb = new Set(b);
  const onlyExe = a.filter(l => !sb.has(l)), onlySrc = b.filter(l => !sa.has(l));
  diff.push({ f, exeLines: a.length, srcLines: b.length, onlyExe: onlyExe.slice(0, 12), onlySrc: onlySrc.slice(0, 12), nOnlyExe: onlyExe.length, nOnlySrc: onlySrc.length });
}
console.log('asar entries', files.length, 'dirs', dirs, 'identical', same);
console.log('missing in project', missing);
console.log('js files in asar', files.filter(f => /^js\//.test(f)).length, files.filter(f => /^js\//.test(f)).join(' '));
for (const d of diff) {
  console.log('\n=== DIFF', d.f, 'exe', d.exeLines, 'src', d.srcLines, 'onlyExe', d.nOnlyExe, 'onlySrc', d.nOnlySrc);
  for (const l of d.onlyExe) console.log('  EXE> ' + l.slice(0, 200));
  for (const l of d.onlySrc) console.log('  SRC> ' + l.slice(0, 200));
}
