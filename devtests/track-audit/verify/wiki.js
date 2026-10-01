// node devtests/track-audit/verify/wiki.js <lang> <Title> <regex> [context=200]
// Fetches the plain-text extract of a Wikipedia article (cached in cache/verify/wiki/, 1.5 s between requests) and
// prints every match of <regex> with some context, to re-read a cited sentence.
'use strict';
const L = require('./lib.js');
const fs = L.fs, path = L.path;
const [lang, title, re, ctx] = process.argv.slice(2);
const dir = path.join(L.CACHE, 'verify', 'wiki'); fs.mkdirSync(dir, { recursive: true });
(async () => {
  const f = path.join(dir, `${lang}-${title.replace(/[^\w\-]+/g, '_')}.txt`);
  let text;
  if (fs.existsSync(f)) text = fs.readFileSync(f, 'utf8');
  else {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'F1Drive-track-audit/1 (verification; contact via github Heart-0001/f1drive)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), p = Object.values(j.query.pages)[0];
    text = p.extract || '';
    fs.writeFileSync(f, text);
    await new Promise((res) => setTimeout(res, 1500));
  }
  const rx = new RegExp(re, 'gi'), c = +(ctx || 200);
  let m, n = 0;
  while ((m = rx.exec(text)) && n < 12) { n++; console.log('...' + text.slice(Math.max(0, m.index - c), m.index + m[0].length + c).replace(/\s+/g, ' ') + '...\n'); }
  if (!n) console.log(`no match in ${text.length} chars`);
})().catch((e) => { console.error(e.message); process.exit(1); });
