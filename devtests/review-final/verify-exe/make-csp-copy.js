// Builds scratch copies of the app (devtests/review-final/verify-exe/csp-<tag>/) whose index.html carries a CSP meta,
// to test PKG-4's suggested policy (tag 'reviewer') and a corrected one (tag 'hash': + the inline script's sha256).
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const hash = "'sha256-" + crypto.createHash('sha256').update(inline, 'utf8').digest('base64') + "'";
const base = "default-src 'self'; script-src 'self' blob: data:; worker-src 'self' blob: data:; connect-src 'self' ws: wss: https://api.ipify.org; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'";
const variants = {
  reviewer: base,
  hash: base.replace("script-src 'self' blob: data:", "script-src 'self' " + hash + " blob: data:"),
  // no data: for scripts (a data: script source is a classic CSP bypass); the worklet's Blob URL path is enough
  strict: "default-src 'self'; script-src 'self' " + hash + " blob:; connect-src 'self' ws: wss: https://api.ipify.org; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'"
};
for (const tag of Object.keys(variants)) {
  const dir = path.join(__dirname, 'csp-' + tag);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of ['electron-main.js', 'preload.js', 'tracks-data.js', 'scenery-data.js']) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)); }
  for (const d of ['js', 'lib', 'net']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true, filter: s => !/README|\.md$/.test(s) });
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + variants[tag] + '">';
  fs.writeFileSync(path.join(dir, 'index.html'), html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + meta));
  console.log(tag, meta);
}
