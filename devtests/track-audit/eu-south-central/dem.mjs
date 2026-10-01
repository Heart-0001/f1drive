// Elevation samplers for the eu-south-central circuits. Each takes [[lat, lon], ...] and returns heights (m, NaN = no data).
// Every response is cached under devtests/track-audit/cache/<source>/, so a re-run makes no requests.
//   bev       Austria  BEV ALS DTM 1 m (airborne laser scanning, 2023 release; CC BY 4.0), cloud-optimised GeoTIFF in
//                      EPSG:3035, range reads (cog.mjs): https://data.bev.gv.at/download/ALS/DTM/20230915/
//   er        Imola    Regione Emilia-Romagna DTM 0.5 m "RER 2022" (lidar Feb-May 2022 / Jan 2023, covers Imola), ArcGIS
//                      ImageServer getSamples: https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/public/DtmRER2022/ImageServer
//   toscana   Mugello  Regione Toscana DSM 1 m 2021 (lidar surface model: on the asphalt = the road) via the GEOscopio WMS
//                      (GetMap image/tiff float32, 500 x 500 m windows in EPSG:32632):
//                      https://www502.regione.toscana.it/wmsraster/com.rt.wms.RTmap/wms?map=wmsmorfologia layer rt_morfologia.iddsm2021.1m.rt
//                      (the 1 m DTM layer rt_morfologia.iddtm.1m.irs has no data there); + the 10 m DTM layer rt_morfologia.iddtm.10m.rt
//   tinitaly  Monza    TINITALY 1.1 DEM 10 m (INGV, CC BY 4.0, doi 10.13127/tinitaly/1.1), WCS 2.0.1 GetCoverage (EPSG:32632)
//   otd:<ds>  any      OpenTopoData public API (eudem25m = EU-DEM v1.1 25 m, srtm30m = SRTM GL1 30 m), 100 points / request,
//                      >= 2.5 s between requests (shared 1000 / day budget)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { CACHE, sleep } from './lib.mjs';
import { openCOG } from './cog.mjs';
import { readTiff } from '../be-nl-de-gb/tiff.mjs';
const require = createRequire(import.meta.url);
const { toLAEA } = require('./laea.js');
const { toUTM } = require('./utm.js');
const UA = { 'User-Agent': 'F1Drive track audit (devtests; cached one-off requests)' };

async function getBuf(url, tries = 5) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (r.status !== 429 && r.status < 500) throw Object.assign(new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200)), { fatal: true });
      throw new Error('HTTP ' + r.status);
    } catch (e) { if (e.fatal || a >= tries) throw e; await sleep(3000 * 2 ** a); }
  }
}

// ---- Austria: BEV ALS DTM 1 m (tile chosen per point from the 50 km EPSG:3035 grid)
const bevTiles = new Map();
export async function bev(pts) {
  const out = [];
  for (const [lat, lon] of pts) {
    const [E, N] = toLAEA(lat, lon), tn = Math.floor(N / 50000) * 50000, te = Math.floor(E / 50000) * 50000, key = `N${tn}E${te}`;
    if (!bevTiles.has(key)) bevTiles.set(key, await openCOG(`https://data.bev.gv.at/download/ALS/DTM/20230915/ALS_DTM_CRS3035RES50000m${key}.tif`, 'bev-als-dtm-' + key));
    out.push(await bevTiles.get(key).sample(E, N));
  }
  return out;
}

// ---- Emilia-Romagna DTM 0.5 m RER2022 (getSamples, 100 points per request)
export async function er(pts, service = 'DtmRER2022') {
  const dir = resolve(CACHE, 'er-' + service.toLowerCase()); mkdirSync(dir, { recursive: true });
  const f = resolve(dir, 'points.json'), cache = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  const key = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  const miss = [...new Set(pts.map(key))].filter((k) => !(k in cache));
  for (let i = 0; i < miss.length; i += 100) {
    const b = miss.slice(i, i + 100).map((k) => k.split(',').map(Number));
    // POST: 100 points do not fit in the server's URL length limit (GET answers 404)
    const body = 'geometry=' + encodeURIComponent(JSON.stringify({ points: b.map((p) => [p[1], p[0]]), spatialReference: { wkid: 4326 } })) +
      '&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json';
    const url = `https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/public/${service}/ImageServer/getSamples`;
    let j;
    for (let a = 0; ; a++) {
      try {
        const r = await fetch(url, { method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, UA) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        j = await r.json(); break;
      } catch (e) { if (a >= 4) throw e; await sleep(3000 * 2 ** a); }
    }
    if (!Array.isArray(j.samples)) throw new Error('ER: ' + JSON.stringify(j).slice(0, 300));
    const vals = b.map(() => null);
    for (const s of j.samples) { const v = parseFloat(s.value); if (Number.isFinite(v) && v > -1000) vals[s.locationId] = v; }
    b.forEach((p, k) => { cache[key(p)] = vals[k]; });
    writeFileSync(f, JSON.stringify(cache));
    await sleep(600);
  }
  return pts.map((p) => { const v = cache[key(p)]; return v === null || v === undefined ? NaN : v; });
}

// ---- Tuscany WMS GeoTIFF windows (EPSG:32632, 1 m DSM or 10 m DTM)
const tosc = new Map();
async function toscWindow(layer, E0, N0, size, px) {
  const dir = resolve(CACHE, 'toscana-' + layer.replace(/[^\w]+/g, '_')); mkdirSync(dir, { recursive: true });
  const f = resolve(dir, `${E0}_${N0}_${size}_${px}.tif`);
  if (!existsSync(f)) {
    const url = 'https://www502.regione.toscana.it/wmsraster/com.rt.wms.RTmap/wms?map=wmsmorfologia&service=WMS&version=1.3.0&request=GetMap' +
      `&layers=${layer}&styles=&crs=EPSG:32632&bbox=${E0},${N0},${E0 + size},${N0 + size}&width=${px}&height=${px}&format=image/tiff`;
    const b = await getBuf(url);
    if (b[0] !== 0x49 && b[0] !== 0x4d) throw new Error('Toscana WMS: ' + b.slice(0, 300).toString());
    writeFileSync(f, b); await sleep(700);
  }
  const t = readTiff(readFileSync(f));
  return { E0, N0, size, px, w: t.w, h: t.h, data: t.data, nodata: t.nodata };
}
export async function toscana(pts, layer = 'rt_morfologia.iddsm2021.1m.rt', res = 1) {
  const size = 500, px = Math.round(size / res), out = [];
  for (const [lat, lon] of pts) {
    const [E, N] = toUTM(lat, lon, 32), E0 = Math.floor(E / size) * size, N0 = Math.floor(N / size) * size, k = layer + E0 + '_' + N0;
    if (!tosc.has(k)) tosc.set(k, await toscWindow(layer, E0, N0, size, px));
    const W = tosc.get(k), r = size / W.w;
    // pixel (i, j): centre at E0 + (i + 0.5) r, N0 + size - (j + 0.5) r; bilinear (edge pixels clamp)
    const fi = (E - E0) / r - 0.5, fj = (N0 + size - N) / r - 0.5;
    const i0 = Math.max(0, Math.min(W.w - 2, Math.floor(fi))), j0 = Math.max(0, Math.min(W.h - 2, Math.floor(fj)));
    const tx = Math.max(0, Math.min(1, fi - i0)), ty = Math.max(0, Math.min(1, fj - j0));
    const g = (i, j) => { const v = W.data[j * W.w + i]; return (W.nodata !== null && v === W.nodata) || v <= 0 || v > 9000 ? NaN : v; };
    const v = g(i0, j0) * (1 - tx) * (1 - ty) + g(i0 + 1, j0) * tx * (1 - ty) + g(i0, j0 + 1) * (1 - tx) * ty + g(i0 + 1, j0 + 1) * tx * ty;
    out.push(v);
  }
  return out;
}

// ---- TINITALY 10 m, one WCS window per bbox (EPSG:32632)
const tin = new Map();
export async function tinitaly(pts, win) {      // win = [E0, N0, E1, N1] on the 10 m grid edges (312500 + 10 k)
  const k = win.join('_');
  if (!tin.has(k)) {
    const dir = resolve(CACHE, 'tinitaly'); mkdirSync(dir, { recursive: true });
    const f = resolve(dir, k + '.tif');
    if (!existsSync(f)) {
      const url = 'https://tinitaly.pi.ingv.it/TINItaly_1_1/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=TINItaly_1_1__tinitaly_dem' +
        `&subset=E(${win[0]},${win[2]})&subset=N(${win[1]},${win[3]})&format=image/tiff`;
      const b = await getBuf(url);
      if (b[0] !== 0x49 && b[0] !== 0x4d) throw new Error('TINITALY: ' + b.slice(0, 300).toString());
      writeFileSync(f, b);
    }
    const t = readTiff(readFileSync(f));
    tin.set(k, t);
  }
  // top-left corner (PixelIsArea): tie point + pixel scale, or the ModelTransformation matrix GeoServer writes
  const t = tin.get(k), X = t.xform, sx = t.scale ? t.scale[0] : X[0], sy = t.scale ? t.scale[1] : -X[5], ox = t.tie ? t.tie[3] : X[3], oy = t.tie ? t.tie[4] : X[7];
  return pts.map(([lat, lon]) => {
    const [E, N] = toUTM(lat, lon, 32), fi = (E - ox) / sx - 0.5, fj = (oy - N) / sy - 0.5;
    const i0 = Math.floor(fi), j0 = Math.floor(fj), tx = fi - i0, ty = fj - j0;
    const g = (i, j) => { const v = t.data[j * t.w + i]; return t.nodata !== null && v === t.nodata ? NaN : v; };
    if (i0 < 0 || j0 < 0 || i0 + 1 >= t.w || j0 + 1 >= t.h) return NaN;
    return g(i0, j0) * (1 - tx) * (1 - ty) + g(i0 + 1, j0) * tx * (1 - ty) + g(i0, j0 + 1) * (1 - tx) * ty + g(i0 + 1, j0 + 1) * tx * ty;
  });
}

// ---- OpenTopoData public API (shared quota: 100 locations / request, >= 2.5 s apart)
let otdLast = 0;
export async function otd(pts, dataset) {
  const dir = resolve(CACHE, 'opentopodata'); mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < pts.length; i += 100) {
    const b = pts.slice(i, i + 100), loc = b.map((p) => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join('|');
    const h = createHash('sha1').update(dataset + loc).digest('hex').slice(0, 16), f = resolve(dir, `${dataset}-${h}.json`);
    let j;
    if (existsSync(f)) j = JSON.parse(readFileSync(f, 'utf8'));
    else {
      const wait = otdLast + 2600 - Date.now(); if (wait > 0) await sleep(wait);
      otdLast = Date.now();
      const url = `https://api.opentopodata.org/v1/${dataset}?locations=${encodeURIComponent(loc)}`;
      j = JSON.parse((await getBuf(url, 3)).toString('utf8'));
      if (j.status !== 'OK') throw new Error('OTD ' + JSON.stringify(j).slice(0, 200));
      j._url = `https://api.opentopodata.org/v1/${dataset}`; writeFileSync(f, JSON.stringify(j));
    }
    for (const r of j.results) out.push(r.elevation === null ? NaN : r.elevation);
  }
  return out;
}
