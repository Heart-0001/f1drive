// node devtests/track-audit/mideast/wiki.mjs <lang> <title> [...]  -> cache/wikipedia/<lang>-<title>.wikitext (raw wikitext via the MediaWiki API)
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), C = resolve(HERE, '..', 'cache', 'wikipedia');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function wiki(lang, title) {
  const f = resolve(C, `${lang}-${title.replace(/[^\w.-]+/g, '_')}.wikitext`);
  if (existsSync(f)) return readFileSync(f, 'utf8');
  const u = `https://${lang}.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&redirects=1&page=${encodeURIComponent(title)}`;
  const r = await fetch(u, { headers: { 'User-Agent': 'F1Drive track audit (devtests; one-off cached reads)' } });
  const j = await r.json();
  if (!j.parse) throw new Error(lang + ':' + title + ' ' + JSON.stringify(j).slice(0, 200));
  const t = j.parse.wikitext['*'];
  writeFileSync(f, `<!-- ${u} fetched ${new Date().toISOString()} revision page ${j.parse.pageid} -->\n` + t, 'utf8');
  await sleep(1000);
  return t;
}
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) { const t = await wiki(a[i], a[i + 1]); console.log(a[i], a[i + 1], t.length); }
}
