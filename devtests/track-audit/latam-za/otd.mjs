// OpenTopoData public API client (https://www.opentopodata.org; api.opentopodata.org: about 1 request / s and 1000 / day
// for everyone on this machine): at most 100 locations per request, 2.5 s between requests, every answer cached under
// devtests/track-audit/cache/opentopodata/<dataset>/<name>.json ("lat,lon" with 6 decimals -> metres or null) and reused.
// Datasets used here: srtm30m (NASA SRTM GL1 v3, 1 arc-second, acquired Feb 2000, a radar SURFACE model), aster30m
// (ASTER GDEM v3), mapzen (Mapzen / Tilezen terrain tiles: INEGI's CEM in Mexico, SRTM elsewhere in these regions).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '..', 'cache', 'opentopodata');
const UA = 'F1Drive-track-audit/1 (offline game-data check; cached, 1 request per 2.5 s)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (lat, lon) => `${lat.toFixed(6)},${lon.toFixed(6)}`;
let last = 0;

// pts = [[lat, lon], ...] -> heights (m, null = no data), in order. name = cache file (one per circuit).
export async function otd(dataset, name, pts) {
  const dir = resolve(ROOT, dataset), file = resolve(dir, name + '.json');
  mkdirSync(dir, { recursive: true });
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const missing = [...new Set(pts.map(([a, b]) => key(a, b)))].filter((k) => !(k in cache));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const url = `https://api.opentopodata.org/v1/${dataset}?interpolation=bilinear&locations=` + batch.join('|');
    for (let a = 0; ; a++) {
      const wait = last + 2500 - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let r;
      try { r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) }); }
      catch (e) { if (a > 5) throw e; console.log(`  opentopodata ${dataset}: ${e.message}, retry`); await sleep(10000 * (a + 1)); continue; }
      if (r.status === 429) { if (a > 5) throw new Error('opentopodata: 429 (daily quota?)'); console.log('  opentopodata 429, waiting 60 s'); await sleep(60000); continue; }
      if (!r.ok) { const t = await r.text(); if (a > 3 || r.status < 500) throw new Error(`opentopodata ${r.status} ${t.slice(0, 200)}`); await sleep(10000); continue; }
      const j = await r.json();
      if (j.status !== 'OK' || !Array.isArray(j.results) || j.results.length !== batch.length) throw new Error('opentopodata: ' + JSON.stringify(j).slice(0, 200));
      j.results.forEach((q, k) => { cache[batch[k]] = q.elevation === null || q.elevation === undefined ? null : +q.elevation; });
      cache._meta = { dataset, endpoint: 'https://api.opentopodata.org/v1/' + dataset, interpolation: 'bilinear', updated: new Date().toISOString() };
      writeFileSync(file, JSON.stringify(cache));
      console.log(`  opentopodata ${dataset} ${name}: ${Math.min(i + 100, missing.length)}/${missing.length}`);
      break;
    }
  }
  return pts.map(([a, b]) => { const v = cache[key(a, b)]; return v === undefined ? null : v; });
}
