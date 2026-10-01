// Cached, polite HTTP GET for the Middle-East audit: every response is stored under devtests/track-audit/cache/<dir>/,
// a re-run never refetches. Back-off on 429 / 5xx / "too many requests" bodies (the Wikipedia API answers 200 with a
// plain-text body when throttled).
// node devtests/track-audit/mideast/net.mjs wiki <lang> <title> [<lang> <title> ...]
// node devtests/track-audit/mideast/net.mjs get <cacheDir> <file> <url>
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE = resolve(HERE, '..', 'cache');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'F1Drive track audit (devtests; cached one-off reads; contact: local research script)';
let last = 0;

export async function cachedGet(dir, name, url, { gapMs = 3000, tries = 8, binary = false, check = null, headers = {} } = {}) {
  const file = resolve(CACHE, dir, name);
  if (existsSync(file)) return binary ? readFileSync(file) : readFileSync(file, 'utf8');
  mkdirSync(dirname(file), { recursive: true });
  for (let t = 0; t < tries; t++) {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let r, body;
    try {
      r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA }, headers) });
      body = binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
    } catch (e) { r = { ok: false, status: 'network ' + (e.cause && e.cause.code || e.message) }; }
    const throttled = !r.ok || (!binary && /too many requests/i.test(body.slice(0, 300))) || (check && !check(body));
    if (!throttled) { writeFileSync(file, body); return body; }
    if (r.status === 404) throw new Error('404 ' + url);
    const back = Math.min(120000, 10000 * 2 ** t);
    console.warn(`GET ${url.slice(0, 120)}: ${r.status}${r.ok ? ' (throttled body)' : ''}, retry in ${back / 1000} s`);
    await sleep(back);
  }
  throw new Error('giving up: ' + url);
}

export async function wiki(lang, title) {
  const name = `${lang}-${title.replace(/[^\w.-]+/g, '_')}.wikitext`;
  const u = `https://${lang}.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&redirects=1&page=${encodeURIComponent(title)}`;
  const f = resolve(CACHE, 'wikipedia', name);
  if (existsSync(f)) return readFileSync(f, 'utf8');
  const raw = await cachedGet('wikipedia-raw', name + '.json', u, { gapMs: 4000, check: (b) => b.trim().startsWith('{') });
  const j = JSON.parse(raw);
  if (!j.parse) throw new Error(lang + ':' + title + ' ' + raw.slice(0, 200));
  const t = `<!-- ${u} fetched ${new Date().toISOString()} revision page ${j.parse.pageid} -->\n` + j.parse.wikitext['*'];
  writeFileSync(f, t, 'utf8');
  return t;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'wiki') {
    for (let i = 0; i < a.length; i += 2) {
      try { const t = await wiki(a[i], a[i + 1]); console.log(a[i], a[i + 1], t.length); } catch (e) { console.log(a[i], a[i + 1], 'ERROR', e.message); }
    }
  } else if (cmd === 'get') {
    const b = await cachedGet(a[0], a[1], a[2], { binary: /.(pdf|zip|tif|bin)$/i.test(a[1]) });
    console.log(a[1], b.length);
  }
}
