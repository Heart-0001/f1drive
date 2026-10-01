// Shared network helpers for the west-European track audit (mc-1929, fr-1960, fr-1969, es-1991, es-2026).
// Every response is cached under devtests/track-audit/cache/<source>/ and reused; requests are serialised and spaced.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..');
export const CACHE = resolve(HERE, '..', 'cache');
const UA = 'F1Drive-track-audit/1 (offline game data check; cached, spaced requests; contact via github bacinger/f1-circuits users)';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = {};

async function spaced(source, gapMs) {
  const now = Date.now(), t = last[source] || 0;
  if (now - t < gapMs) await sleep(gapMs - (now - t));
  last[source] = Date.now();
}

function cachePath(source, key) {
  const dir = resolve(CACHE, source);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, key.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
}

// Overpass: one query at a time, back off on 429 / 504.
export async function overpass(name, query) {
  const file = cachePath('overpass', name);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const hosts = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  for (let a = 0; a < 8; a++) {
    await spaced('overpass', 3000);
    const host = hosts[a % hosts.length];
    try {
      const r = await fetch(host, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query) });
      if (r.ok) {
        const j = await r.json();
        j._query = query; j._host = host; j._fetched = new Date().toISOString();
        writeFileSync(file, JSON.stringify(j));
        return j;
      }
      const wait = r.status === 429 || r.status === 504 ? 15000 * (a + 1) : 5000;
      console.warn(`overpass ${name}: HTTP ${r.status} on ${host}, waiting ${wait / 1000} s`);
      await sleep(wait);
    } catch (e) {
      console.warn(`overpass ${name}: ${e.message}`);
      await sleep(10000);
    }
  }
  throw new Error('overpass failed: ' + name);
}

// OpenTopoData public API: <= 100 locations / request, 2.5 s between requests (shared 1 req/s, 1000/day machine-wide).
// Cache per dataset: key "lat,lon" (5 decimals) -> metres.
export async function opentopodata(dataset, latlons) {
  const file = cachePath('opentopodata', dataset);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const key = (lat, lon) => `${(+lat).toFixed(5)},${(+lon).toFixed(5)}`;
  const miss = [...new Set(latlons.map(([la, lo]) => key(la, lo)))].filter((k) => !(k in cache));
  if (miss.length) console.log(`opentopodata ${dataset}: ${miss.length} locations to fetch (${Math.ceil(miss.length / 100)} requests)`);
  for (let i = 0; i < miss.length; i += 100) {
    const b = miss.slice(i, i + 100);
    for (let a = 0; ; a++) {
      await spaced('opentopodata', 2500);
      const r = await fetch(`https://api.opentopodata.org/v1/${dataset}?locations=${b.join('|')}`, { headers: { 'User-Agent': UA } });
      if (r.ok) { const j = await r.json(); j.results.forEach((q, n) => { cache[b[n]] = q.elevation; }); break; }
      const txt = await r.text();
      if (a > 5) throw new Error(`opentopodata ${dataset}: HTTP ${r.status} ${txt.slice(0, 200)}`);
      console.warn(`opentopodata ${dataset}: HTTP ${r.status} ${txt.slice(0, 120)}; backing off`);
      await sleep(10000 * (a + 1));
    }
    writeFileSync(file, JSON.stringify(cache));
  }
  return latlons.map(([la, lo]) => cache[key(la, lo)]);
}

// IGN Geoplateforme altimetry (RGE ALTI, 1-5 m bare earth, France): 100 points / request, 1.5 s apart.
export async function ignAlti(latlons) {
  const file = cachePath('ignalti', 'rge_alti_wld');
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const key = (lat, lon) => `${(+lat).toFixed(6)},${(+lon).toFixed(6)}`;
  const miss = [...new Set(latlons.map(([la, lo]) => key(la, lo)))].filter((k) => !(k in cache));
  if (miss.length) console.log(`IGN RGE ALTI: ${miss.length} locations to fetch`);
  for (let i = 0; i < miss.length; i += 100) {
    const b = miss.slice(i, i + 100), ll = b.map((k) => k.split(','));
    for (let a = 0; ; a++) {
      await spaced('ign', 1500);
      const url = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=' + ll.map((p) => p[1]).join('|') +
        '&lat=' + ll.map((p) => p[0]).join('|') + '&resource=ign_rge_alti_wld&zonly=true';
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) {
        const j = await r.json();
        if (!Array.isArray(j.elevations) || j.elevations.length !== b.length) throw new Error('IGN: unexpected response');
        j.elevations.forEach((v, n) => { cache[b[n]] = Number.isFinite(+v) && +v > -1000 ? +v : null; });
        break;
      }
      if (a > 5) throw new Error('IGN HTTP ' + r.status);
      await sleep(5000 * (a + 1));
    }
    writeFileSync(file, JSON.stringify(cache));
  }
  return latlons.map(([la, lo]) => cache[key(la, lo)]);
}

// Generic cached GET (text or binary) for other services (WCS etc.).
export async function cachedGet(source, name, url, { binary = false, gapMs = 1500, headers = {} } = {}) {
  const dir = resolve(CACHE, source);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, name.replace(/[^A-Za-z0-9_.-]/g, '_'));
  if (existsSync(file)) return binary ? readFileSync(file) : readFileSync(file, 'utf8');
  for (let a = 0; ; a++) {
    await spaced(source, gapMs);
    const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA }, headers) });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      writeFileSync(file, buf);
      return binary ? buf : buf.toString('utf8');
    }
    const t = await r.text();
    if (a > 4 || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(`${source} HTTP ${r.status}: ${t.slice(0, 300)}`);
    await sleep(5000 * (a + 1));
  }
}

export function hash(s) { return createHash('sha1').update(s).digest('hex').slice(0, 10); }
