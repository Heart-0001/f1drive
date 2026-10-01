// node devtests/track-audit/americas/refs-fetch.mjs [Title ...]
// Raw wikitext of the reference articles (en.wikipedia.org, CC BY-SA), cached in devtests/track-audit/cache/wikipedia/.
import { cachedGet } from './net.mjs';
const TITLES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'Circuit_of_the_Americas', 'Las_Vegas_Strip_Circuit', 'Miami_International_Autodrome', 'Indianapolis_Motor_Speedway',
  'Watkins_Glen_International', 'Circuit_Gilles_Villeneuve', 'United_States_Grand_Prix', 'Las_Vegas_Grand_Prix', 'Miami_Grand_Prix',
  'Canadian_Grand_Prix', '2005_United_States_Grand_Prix', '1980_United_States_Grand_Prix'];
for (const t of TITLES) {
  const lang = t.includes(':') ? t.split(':')[0] : 'en', title = t.includes(':') ? t.split(':').slice(1).join(':') : t;
  try {
    const txt = await cachedGet('wikipedia', `${lang}-${title}.wiki`, `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`, 1500);
    console.log(t, txt.length, 'chars');
  } catch (e) { console.log(t, 'FAILED', e.message.slice(0, 200)); }
}
