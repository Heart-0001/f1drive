// Network helpers for the track audit of us-2012, us-2023, us-2022, us-1909, us-1956, ca-1978 ("americas").
// Every response is cached under devtests/track-audit/cache/<source>/ (files of their own: -americas suffix where other
// audit agents may write a cache of the same source at the same time) and reused; requests are serialised and spaced.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..');
export const CACHE = resolve(HERE, '..', 'cache');
const require = createRequire(import.meta.url);
const { readTiff } = require('./tiff.js');
const UA = 'F1Drive-track-audit/1 (offline game data check of 6 circuits; cached, spaced requests)';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = {};
async function spaced(source, gapMs) {
  const now = Date.now(), t = last[source] || 0;
  if (now - t < gapMs) await sleep(gapMs - (now - t));
  last[source] = Date.now();
}
function dirOf(source) { const d = resolve(CACHE, source); mkdirSync(d, { recursive: true }); return d; }
function saveJSON(file, obj) { writeFileSync(file + '.tmp', JSON.stringify(obj)); renameSync(file + '.tmp', file); }
const key5 = (lat, lon) => `${(+lat).toFixed(5)},${(+lon).toFixed(5)}`;
const key6 = (lat, lon) => `${(+lat).toFixed(6)},${(+lon).toFixed(6)}`;

// Overpass (ODbL): one query at a time, 3 s apart, back off on 429 / 504.
export async function overpass(name, query) {
  const file = resolve(dirOf('overpass'), name.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const hosts = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  for (let a = 0; a < 10; a++) {
    await spaced('overpass', 3000);
    const host = hosts[a % hosts.length];
    try {
      const r = await fetch(host, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query) });
      if (r.ok) {
        const j = await r.json();
        j._query = query; j._host = host; j._fetched = new Date().toISOString();
        saveJSON(file, j);
        return j;
      }
      const wait = r.status === 429 || r.status === 504 ? 15000 * (a + 1) : 5000;
      console.warn(`overpass ${name}: HTTP ${r.status} on ${host}, waiting ${wait / 1000} s`);
      await sleep(wait);
    } catch (e) { console.warn(`overpass ${name}: ${e.message}`); await sleep(10000); }
  }
  throw new Error('overpass failed: ' + name);
}

// OpenTopoData public API: <= 100 locations / request, >= 2.5 s apart (shared 1 req/s and 1000/day machine-wide).
export async function opentopodata(dataset, latlons) {
  const file = resolve(dirOf('opentopodata'), dataset + '-americas.json');
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const miss = [...new Set(latlons.map(([la, lo]) => key5(la, lo)))].filter((k) => !(k in cache));
  if (miss.length) console.log(`opentopodata ${dataset}: ${miss.length} locations to fetch (${Math.ceil(miss.length / 100)} requests)`);
  for (let i = 0; i < miss.length; i += 100) {
    const b = miss.slice(i, i + 100);
    for (let a = 0; ; a++) {
      await spaced('opentopodata', 2600);
      const r = await fetch(`https://api.opentopodata.org/v1/${dataset}?locations=${b.join('|')}`, { headers: { 'User-Agent': UA } });
      if (r.ok) { const j = await r.json(); j.results.forEach((q, n) => { cache[b[n]] = q.elevation; }); break; }
      const txt = await r.text();
      if (a > 6) throw new Error(`opentopodata ${dataset}: HTTP ${r.status} ${txt.slice(0, 200)}`);
      console.warn(`opentopodata ${dataset}: HTTP ${r.status} ${txt.slice(0, 120)}; backing off`);
      await sleep(15000 * (a + 1));
    }
    saveJSON(file, cache);
  }
  return latlons.map(([la, lo]) => { const v = cache[key5(la, lo)]; return v === undefined ? null : v; });
}

// USGS 3DEP (bare earth, 1 m lidar where available; public domain) via the 3DEPElevation ImageServer getSamples:
// 100 points / request, bilinear, 1.2 s apart. Cache key "lat,lon" (6 decimals) -> {v, res}.
export async function usgs3dep(latlons) {
  const file = resolve(dirOf('usgs3dep'), 'imageserver-americas.json');
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const miss = [...new Set(latlons.map(([la, lo]) => key6(la, lo)))].filter((k) => !(k in cache));
  if (miss.length) console.log(`USGS 3DEP: ${miss.length} locations to fetch (${Math.ceil(miss.length / 100)} requests)`);
  for (let i = 0; i < miss.length; i += 100) {
    const b = miss.slice(i, i + 100), pts = b.map((k) => { const [la, lo] = k.split(','); return [+lo, +la]; });
    const geom = encodeURIComponent(JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } }));
    const url = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples?geometry=' + geom +
      '&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&interpolation=RSP_BilinearInterpolation&f=json';
    for (let a = 0; ; a++) {
      await spaced('usgs', 1200);
      let ok = false;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.samples)) {
            for (const k of b) if (!(k in cache)) cache[k] = null;
            for (const s of j.samples) { const v = +s.value; cache[b[s.locationId]] = Number.isFinite(v) && v > -1000 ? { v, res: s.resolution } : null; }
            ok = true;
          } else console.warn('USGS: unexpected ' + JSON.stringify(j).slice(0, 200));
        } else console.warn('USGS HTTP ' + r.status);
      } catch (e) { console.warn('USGS ' + e.message); }
      if (ok) break;
      if (a > 6) throw new Error('USGS 3DEP failed');
      await sleep(5000 * (a + 1));
    }
    saveJSON(file, cache);
  }
  return latlons.map(([la, lo]) => { const c = cache[key6(la, lo)]; return c ? c.v : null; });
}

// NRCan HRDEM mosaic (DTM, lidar 1-2 m where available; Open Government Licence - Canada) via its WCS 1.1.1
// (datacube.services.geo.ca/ows/elevation, coverage 'dtm', EPSG:4326, 1e-5 deg grid): tiles of 0.004 x 0.004 deg,
// each cached as a GeoTIFF in cache/hrdem/. Bilinear sampling at the pixel centres.
const HR_TILE = 0.004, HR_RES = 0.00001;
const hrTiles = {};
async function hrTile(ty, tx) {
  const id = `${ty}_${tx}`;
  if (hrTiles[id]) return hrTiles[id];
  const file = resolve(dirOf('hrdem'), `dtm_${id}.tif`);
  let buf;
  if (existsSync(file)) buf = readFileSync(file);
  else {
    const la0 = ty * HR_TILE, lo0 = tx * HR_TILE;
    const bb = [la0, lo0, la0 + HR_TILE, lo0 + HR_TILE].map((v) => v.toFixed(6)).join(',');
    const url = 'https://datacube.services.geo.ca/ows/elevation?service=WCS&version=1.1.1&request=GetCoverage&identifier=dtm' +
      `&format=image/geotiff&BoundingBox=${bb},urn:ogc:def:crs:EPSG::4326&GridBaseCRS=urn:ogc:def:crs:EPSG::4326&GridOffsets=-${HR_RES},${HR_RES}`;
    for (let a = 0; ; a++) {
      await spaced('hrdem', 1500);
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok && /tiff/.test(r.headers.get('content-type') || '')) { buf = Buffer.from(await r.arrayBuffer()); break; }
      const t = await r.text();
      if (a > 4) throw new Error('HRDEM HTTP ' + r.status + ' ' + t.slice(0, 200));
      await sleep(5000 * (a + 1));
    }
    writeFileSync(file, buf);
  }
  const t = readTiff(buf);
  hrTiles[id] = t;
  return t;
}
export async function hrdem(latlons) {
  const out = [];
  for (const [lat, lon] of latlons) {
    const t = await hrTile(Math.floor(lat / HR_TILE), Math.floor(lon / HR_TILE));
    const lonT = t.tie[3], latT = t.tie[4], sx = t.scale[0], sy = t.scale[1];
    const fx = (lon - lonT) / sx - 0.5, fy = (latT - lat) / sy - 0.5;
    const x0 = Math.max(0, Math.min(t.W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(t.H - 2, Math.floor(fy)));
    const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    const g = (x, y) => t.data[y * t.W + x];
    const v = (g(x0, y0) * (1 - ax) + g(x0 + 1, y0) * ax) * (1 - ay) + (g(x0, y0 + 1) * (1 - ax) + g(x0 + 1, y0 + 1) * ax) * ay;
    out.push(Number.isFinite(v) ? v : null);
  }
  return out;
}

// Generic cached GET (text) for reference pages (Wikipedia raw wikitext etc.).
export async function cachedGet(source, name, url, gapMs = 1500) {
  const file = resolve(dirOf(source), name.replace(/[^A-Za-z0-9_.-]/g, '_'));
  if (existsSync(file)) return readFileSync(file, 'utf8');
  for (let a = 0; ; a++) {
    await spaced(source, gapMs);
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) { const t = await r.text(); writeFileSync(file, t); return t; }
    const t = await r.text();
    if (a > 4 || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(`${source} HTTP ${r.status}: ${t.slice(0, 300)}`);
    await sleep(5000 * (a + 1));
  }
}
