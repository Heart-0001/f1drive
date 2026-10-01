// node devtests/track-audit/east/wiki.mjs <lang> <title> [...]  -> cache/wikipedia/<lang>-<title>.wikitext
// Raw wikitext via the MediaWiki API (CC BY-SA), cached; a re-run never refetches. 1.5 s between requests.
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), C = resolve(HERE, '..', 'cache', 'wikipedia');
mkdirSync(C, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function wikiFile(lang, title) { return resolve(C, `${lang}-${title.replace(/[^\w.-]+/g, '_')}.wikitext`); }
export async function wiki(lang, title) {
  const f = wikiFile(lang, title);
  if (existsSync(f)) return readFileSync(f, 'utf8');
  const u = `https://${lang}.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&redirects=1&page=${encodeURIComponent(title)}`;
  const r = await fetch(u, { headers: { 'User-Agent': 'F1Drive track audit (devtests; one-off cached reads)' } });
  const j = await r.json();
  if (!j.parse) throw new Error(lang + ':' + title + ' ' + JSON.stringify(j).slice(0, 200));
  const t = j.parse.wikitext['*'];
  writeFileSync(f, `<!-- ${u} fetched ${new Date().toISOString()} pageid ${j.parse.pageid} title ${j.parse.title} -->\n` + t, 'utf8');
  await sleep(1500);
  return t;
}
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    try { const t = await wiki(a[i], a[i + 1]); console.log(a[i], a[i + 1], t.length); }
    catch (e) { console.log(a[i], a[i + 1], 'FAILED', e.message.slice(0, 200)); }
  }
}
