// node devtests/track-audit/americas/pdftext.js file.pdf  -> crude text of the PDF's Flate content streams (Tj / TJ strings)
'use strict';
const fs = require('fs'), zlib = require('zlib');
const buf = fs.readFileSync(process.argv[2]);
const s = buf.toString('latin1');
let i = 0;
const out = [];
function unesc(x) {
  return x.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => {
    if (/^[0-7]/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return { n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c];
  });
}
while ((i = s.indexOf('stream', i)) >= 0) {
  let a = i + 6;
  if (s[a] === '\r') a++;
  if (s[a] === '\n') a++;
  const e = s.indexOf('endstream', a);
  if (e < 0) break;
  const dict = s.slice(Math.max(0, s.lastIndexOf('<<', i)), i);
  let data = buf.subarray(a, e);
  if (/\/Subtype\s*\/Image|\/DCTDecode|\/JPX|\/FontFile|\/Length1/.test(dict)) { i = e + 9; continue; }
  if (/FlateDecode/.test(dict)) {
    try { data = zlib.inflateSync(data); } catch (er) { try { data = zlib.inflateRawSync(data); } catch (e2) { i = e + 9; continue; } }
  }
  const t = data.toString('latin1');
  if (!/\bBT\b/.test(t) || t.length > 3e6) { i = e + 9; continue; }
  const parts = [];
  const re = /\((?:\\.|[^\\)])*\)\s*Tj|\[(?:\((?:\\.|[^\\)])*\)|[^\]])*\]\s*TJ|T\*|ET/g;
  let m;
  while ((m = re.exec(t))) {
    const w = m[0];
    if (w[0] === '(') parts.push(unesc(w.replace(/\)\s*Tj$/, '').slice(1)));
    else if (w[0] === '[') {
      const inner = w.replace(/\]\s*TJ$/, '').slice(1);
      const re2 = /\((?:\\.|[^\\)])*\)|-?\d+\.?\d*/g;
      let q, acc = '';
      while ((q = re2.exec(inner))) acc += q[0][0] === '(' ? unesc(q[0].slice(1, -1)) : (+q[0] < -200 ? ' ' : '');
      parts.push(acc);
    } else parts.push(w === 'ET' ? '\n' : ' ');
  }
  const txt = parts.join('').replace(/[ \t]+/g, ' ').trim();
  if (txt.length > 3) out.push(txt);
  i = e + 9;
}
console.log(out.join('\n'));
