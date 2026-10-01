// node devtests/track-audit/east/otd.mjs <dataset> <id> [...ids]
// OpenTopoData public API (https://www.opentopodata.org; datasets eudem25m, srtm30m, aster30m, mapzen ...): heights every
// 50 m along the OSM loop of each circuit (same loop and start as elev-osm.mjs), <= 100 locations per request, 2.5 s
// between requests (the public limit is 1 / s and 1000 / day for everyone on this machine). Cached as
// ../cache/opentopodata/<dataset>/east-<id>.json = {dataset, step, values[], fetched}; a re-run never refetches.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { osmProfile } from './elev-osm.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [dataset, ...ids] = process.argv.slice(2);
const dir = resolve(HERE, '..', 'cache', 'opentopodata', dataset);
mkdirSync(dir, { recursive: true });
for (const id of ids) {
  const file = resolve(dir, `east-${id}.json`);
  if (existsSync(file)) { console.log(dataset, id, 'cached'); continue; }
  const { P } = osmProfile(id, 50);
  const locs = P.lat.map((la, i) => `${la.toFixed(6)},${P.lon[i].toFixed(6)}`), values = [];
  for (let i = 0; i < locs.length; i += 100) {
    const url = `https://api.opentopodata.org/v1/${dataset}?locations=${locs.slice(i, i + 100).join('|')}`;
    for (let a = 0; ; a++) {
      const r = await fetch(url, { headers: { 'User-Agent': 'F1Drive devtests/track-audit (cached one-off)' } });
      if (r.ok) { const j = await r.json(); for (const q of j.results) values.push(q.elevation); break; }
      console.log(dataset, id, 'HTTP', r.status, (await r.text()).slice(0, 200));
      if (a > 4) throw new Error('giving up');
      await sleep(10000 * (a + 1));
    }
    await sleep(2500);
  }
  writeFileSync(file, JSON.stringify({ dataset, step: P.ds, values, fetched: new Date().toISOString() }));
  console.log(dataset, id, values.length, 'values, range', Math.min(...values.filter((v) => v != null)), '..', Math.max(...values.filter((v) => v != null)));
}
