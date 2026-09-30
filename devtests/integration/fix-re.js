// Replace the mangled "strip control characters" regex with a char-code filter (ASCII-only source).
const fs = require('fs');
const helper = [
  'function stripControl(v) {',
  '  var out = "";',
  '  for (var i = 0; i < v.length; i++) {',
  '    var c = v.charCodeAt(i);',
  '    // C0 / C1 controls, zero-width and bidi formatting characters, line separators, BOM',
  '    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) ||',
  '        (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) continue;',
  '    out += v.charAt(i);',
  '  }',
  '  return out;',
  '}'
];
for (const [file, indent, decl] of [['net/server.js', '', 'let'], ['js/net.js', '  ', 'var']]) {
  const p = 'C:/Users/user/Desktop/f1drive/' + file;
  let s = fs.readFileSync(p, 'utf8');
  const lines = s.split('\n');
  const i = lines.findIndex(l => l.includes('v.replace(/[') && l.includes('u0000'));
  if (i < 0) throw new Error('not found in ' + file);
  if (file === 'net/server.js') {
    lines.splice(i, 2, "  let s = stripControl(v).replace(/\\s+/g, ' ').trim();");
  } else {
    lines[i] = "    var s = stripControl(v).replace(/\\s+/g, ' ').trim();";
  }
  const j = lines.findIndex(l => l.trim().startsWith('function cleanName('));
  lines.splice(j, 0, ...helper.map(l => indent + l));
  s = lines.join('\n');
  if (/[^\x00-\x7f]/.test(s.split('\n').filter(l => l.includes('stripControl')).join(''))) throw new Error('non-ascii left');
  fs.writeFileSync(p, s);
  console.log('fixed', file);
}
