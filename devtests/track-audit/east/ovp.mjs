// node devtests/track-audit/east/ovp.mjs <name> "<overpass QL>"
// One Overpass query (ODbL data), cached as ../cache/overpass/east-<name>.json; never refetched. Backs off on 429 / 504.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), CACHE = resolve(HERE, '..', 'cache', 'overpass');
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EP = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export async function overpass(name, q) {
  const file = resolve(CACHE, `east-${name}.json`);
  if (existsSync(file)) { console.log(name, 'cached'); return; }
  for (let a = 0; a < 12; a++) {
    const ep = EP[a % EP.length];
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'F1Drive devtests/track-audit (one-off, cached)' } });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) {
        const j = JSON.parse(text);
        if (j.remark && /runtime error|timed out/i.test(j.remark)) throw new Error('remark ' + j.remark);
        writeFileSync(file, text); console.log(name, ep, 'elements', j.elements.length); return;
      }
      console.log(name, ep, 'HTTP', res.status, text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
      if (res.status === 400) return;
      await sleep(res.status === 429 ? 30000 * (a + 1) : 10000);
    } catch (e) { console.log(name, ep, 'error', e.message); await sleep(10000); }
  }
}
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await overpass(process.argv[2], process.argv[3]);
