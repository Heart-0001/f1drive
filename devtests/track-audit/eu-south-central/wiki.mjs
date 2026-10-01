// node wiki.mjs <lang>:<Title> ...  -> raw wikitext cached under devtests/track-audit/cache/wikipedia/<lang>-<Title>.wiki
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const CACHE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cache', 'wikipedia');
mkdirSync(CACHE, { recursive: true });
const UA = { 'User-Agent': 'F1Drive track audit (devtests; cached one-off reads; https://github.com/Heart-0001/f1drive)' };
for (const arg of process.argv.slice(2)) {
  const [lang, ...rest] = arg.split(':'), title = rest.join(':');
  const f = resolve(CACHE, `${lang}-${title.replace(/[^\w\-]+/g, '_')}.wiki`);
  if (existsSync(f)) { console.log('cached', f, readFileSync(f, 'utf8').length); continue; }
  const url = `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`;
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  const t = await r.text();
  if (!r.ok) { console.log('FAIL', r.status, arg); continue; }
  writeFileSync(f, t);
  console.log('fetched', f, t.length);
  await new Promise((r) => setTimeout(r, 1200));
}
