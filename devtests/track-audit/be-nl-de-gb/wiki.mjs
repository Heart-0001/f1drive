// node wiki.mjs lang:Title ...  -> caches raw wikitext in ../cache/wikipedia/<lang>-<Title>.wiki (follows #REDIRECT)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE, politeFetch, sleep } from './lib.mjs';
const dir = resolve(CACHE, 'wikipedia'); mkdirSync(dir, { recursive: true });
export async function wiki(lang, title) {
  const f = resolve(dir, `${lang}-${title.replace(/[\/\:*?"<>| ]/g, '_')}.wiki`);
  if (existsSync(f)) return readFileSync(f, 'utf8');
  let t = await (await politeFetch(`https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`, {}, 'wikipedia')).text();
  const m = t.match(/^#REDIRECT\s*\[\[([^\]#]+)/i) || t.match(/^#WEITERLEITUNG\s*\[\[([^\]#]+)/i) || t.match(/^#DOORVERWIJZING\s*\[\[([^\]#]+)/i);
  if (m) { await sleep(800); t = await (await politeFetch(`https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(m[1])}&action=raw`, {}, 'wikipedia')).text(); }
  writeFileSync(f, t); await sleep(800);
  return t;
}
if (process.argv[1] && process.argv[1].endsWith('wiki.mjs')) {
  for (const a of process.argv.slice(2)) { const i = a.indexOf(':'); const t = await wiki(a.slice(0, i), a.slice(i + 1)); console.log(a, t.length); }
}
