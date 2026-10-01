// node devtests/track-audit/apac/wiki.mjs  -- raw wikitext of the reference pages (cached in cache/wikipedia/<lang>-<title>.wiki)
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE, UA, sleep } from './common.mjs';
const PAGES = [
  ['en', 'Suzuka_International_Racing_Course'], ['ja', '鈴鹿サーキット'], ['de', 'Suzuka_International_Racing_Course'],
  ['en', 'Marina_Bay_Street_Circuit'], ['de', 'Marina_Bay_Street_Circuit'], ['en', 'Singapore_Grand_Prix'],
  ['en', 'Sepang_International_Circuit'], ['de', 'Sepang_International_Circuit'], ['ms', 'Litar_Antarabangsa_Sepang'],
  ['en', 'Shanghai_International_Circuit'], ['de', 'Shanghai_International_Circuit'], ['zh', '上海国际赛车场'],
  ['en', 'Albert_Park_Circuit'], ['de', 'Albert_Park_Circuit'], ['en', 'Australian_Grand_Prix'],
  ['en', 'Anderson_Bridge'], ['en', 'Esplanade_Bridge'],
  ['en', '2023_Singapore_Grand_Prix'], ['en', '2022_Australian_Grand_Prix'], ['en', '2024_Chinese_Grand_Prix'],
];
const dir = resolve(CACHE, 'wikipedia'); mkdirSync(dir, { recursive: true });
for (const [lang, title] of (process.argv[2] ? [process.argv.slice(2, 4)] : PAGES)) {
  const file = resolve(dir, `${lang}-${title.replace(/[^\w぀-鿿-]/g, '_')}.wiki`);
  if (existsSync(file)) continue;
  const url = `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw&redirect=yes`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const t = await r.text();
  console.log(lang, title, r.status, t.length);
  if (r.ok) writeFileSync(file, t, 'utf8');
  await sleep(1500);
}
