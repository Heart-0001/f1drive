// DEM samplers (each caches every response under ../cache/<source>/). All return metres ASL or null.
//   wallonia(ll)  SPW "Relief de la Wallonie - MNT 2021-2022" 0.5 m lidar DTM, ArcGIS MapServer identify (1 point / request)
//   ahn4(ll)      AHN4 DTM 0.5 m, ArcGIS ImageServer getSamples (100 points / request)
//   bwDgm1(ll)    LGL-BW DGM1 (1 m lidar DTM) INSPIRE WCS 2.0 GetCoverage GeoTIFF tiles (EPSG:25832)
//   rlpDgm1(ll)   LVermGeo RLP DGM1 (1 m) open-data GeoTIFF tiles (EPSG:25832) from geobasis-rlp.de
//   eaLidar(ll)   Environment Agency LIDAR Composite DTM 1 m, WCS 2.0.1 GetCoverage GeoTIFF tiles (EPSG:27700)
//   otd(ll, ds)   OpenTopoData public API (eudem25m / srtm30m ...), 100 points / request, >= 2.5 s apart
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE, sleep, politeFetch, toUTM, toBNG, bilinear, readJSON, writeJSON } from './lib.mjs';
import { readTiff } from './tiff.mjs';

const k5 = (lat, lon) => `${lat.toFixed(6)},${lon.toFixed(6)}`;
function pointCache(name) {
  const dir = resolve(CACHE, name); mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'points.json');
  const map = existsSync(file) ? readJSON(file) : {};
  return { map, save: () => writeJSON(file, map) };
}

export async function wallonia(ll) {
  const c = pointCache('wallonia-mnt2021');
  const miss = [...new Set(ll.map(([a, b]) => k5(a, b)))].filter((k) => !(k in c.map));
  if (miss.length) console.log(`wallonia: ${miss.length} points to fetch`);
  let done = 0, next = 0;
  const one = async (k) => {
    const [lat, lon] = k.split(',').map(Number);
    const url = 'https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNT_2021_2022/MapServer/identify?geometry=' +
      encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } })) +
      `&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=0&mapExtent=${lon - 0.001},${lat - 0.001},${lon + 0.001},${lat + 0.001}` +
      '&imageDisplay=400,400,96&returnGeometry=false&f=json';
    const j = await (await politeFetch(url, {}, 'wallonia identify')).json();
    const r = j.results && j.results[0];
    const v = r ? parseFloat(r.attributes['Stretch.Pixel Value'] ?? r.attributes['Pixel Value']) : NaN;
    c.map[k] = Number.isFinite(v) ? v : null;
  };
  const worker = async () => { while (next < miss.length) { const k = miss[next++]; await one(k); done++; if (done % 100 === 0) { c.save(); console.log(`  wallonia ${done}/${miss.length}`); } await sleep(150); } };
  await Promise.all([worker(), worker(), worker()]);
  c.save();
  return ll.map(([a, b]) => c.map[k5(a, b)]);
}

export async function ahn4(ll) {
  const c = pointCache('ahn4');
  const miss = [...new Set(ll.map(([a, b]) => k5(a, b)))].filter((k) => !(k in c.map));
  for (let i = 0; i < miss.length; i += 100) {
    const batch = miss.slice(i, i + 100), pts = batch.map((k) => k.split(',').map(Number)).map(([lat, lon]) => [lon, lat]);
    const geom = encodeURIComponent(JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } }));
    const j = await (await politeFetch('https://ahn.arcgisonline.nl/arcgis/rest/services/AHNviewer/AHN4_DTM_50cm/ImageServer/getSamples' +
      `?geometry=${geom}&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json`, {}, 'AHN4')).json();
    if (!Array.isArray(j.samples)) throw new Error('AHN4: ' + JSON.stringify(j).slice(0, 300));
    batch.forEach((k) => { c.map[k] = null; });
    for (const s of j.samples) { const v = +s.value; if (Number.isFinite(v) && v > -1000) c.map[batch[s.locationId]] = v; }
    c.save(); await sleep(500);
  }
  return ll.map(([a, b]) => c.map[k5(a, b)]);
}

// ---- raster tiles (projected CRS): tile = T m square, fetched once, kept as GeoTIFF bytes on disk
const rasters = new Map();
function loadTif(file, x0, y0) {
  if (rasters.has(file)) return rasters.get(file);
  const t = readTiff(readFileSync(file));
  let r;
  if (t.scale && t.tie) r = { w: t.w, h: t.h, data: t.data, px: t.scale[0], py: t.scale[1], x0: t.tie[3] - t.tie[0] * t.scale[0], y0: t.tie[4] + t.tie[1] * t.scale[1], nodata: t.nodata };
  else if (t.xform) r = { w: t.w, h: t.h, data: t.data, px: t.xform[0], py: -t.xform[5], x0: t.xform[3], y0: t.xform[7], nodata: t.nodata };
  else throw new Error('no georeference in ' + file);
  rasters.set(file, r);
  return r;
}
async function tiled(ll, name, T, toXY, url, minBytes = 1000) {
  const dir = resolve(CACHE, name); mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [lat, lon] of ll) {
    const [x, y] = toXY(lat, lon), tx = Math.floor(x / T) * T, ty = Math.floor(y / T) * T;
    const file = resolve(dir, `${tx}_${ty}.tif`);
    if (!existsSync(file)) {
      const u = url(tx, ty, T);
      console.log(`${name}: tile ${tx} ${ty}`);
      const res = await politeFetch(u, {}, name);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < minBytes || !(buf[0] === 0x49 || buf[0] === 0x4d)) throw new Error(`${name}: not a TIFF (${buf.length} bytes): ${buf.slice(0, 300).toString()}`);
      writeFileSync(file, buf); await sleep(1500);
    }
    out.push(bilinear(loadTif(file), x, y));
  }
  return out;
}
const PAD = 2;   // m of overlap so bilinear works at tile edges
export const bwDgm1 = (ll) => tiled(ll, 'bw-dgm1', 500, (a, b) => toUTM(a, b, 32), (tx, ty, T) =>
  'https://owsproxy.lgl-bw.de/owsproxy/wcs/WCS_INSP_BW_Hoehe_Coverage_DGM1?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage' +
  `&COVERAGEID=EL.ElevationGridCoverage&FORMAT=image/tiff&SUBSET=E(${tx - PAD},${tx + T + PAD})&SUBSET=N(${ty - PAD},${ty + T + PAD})`);
export const eaLidar = (ll) => tiled(ll, 'ea-lidar', 500, toBNG, (tx, ty, T) =>
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs?service=WCS&version=2.0.1&request=GetCoverage' +
  `&CoverageId=13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m&format=image/tiff&subset=E(${tx - PAD},${tx + T + PAD})&subset=N(${ty - PAD},${ty + T + PAD})`);
// RLP: 1 km tiles named dgm1_32_<E km>_<N km>_1_rp_<year>.tif, resolved from the directory listing (cached)
let rlpNames = null;
async function rlpIndex() {
  if (rlpNames) return rlpNames;
  const f = resolve(CACHE, 'rlp-dgm1', 'index.json');
  if (existsSync(f)) return (rlpNames = readJSON(f));
  mkdirSync(resolve(CACHE, 'rlp-dgm1'), { recursive: true });
  const t = await (await politeFetch('https://geobasis-rlp.de/data/dgm1/current/tif/', {}, 'rlp index')).text();
  rlpNames = [...t.matchAll(/href="([^"]+.tif)"/g)].map((m) => m[1]);
  writeJSON(f, rlpNames);
  return rlpNames;
}
export async function rlpDgm1(ll) {
  const names = await rlpIndex();
  return tiled(ll, 'rlp-dgm1', 1000, (a, b) => toUTM(a, b, 32), (tx, ty) => {
    const n = names.find((q) => q.startsWith(`dgm1_32_${tx / 1000}_${ty / 1000}_1_rp`));
    if (!n) throw new Error('no RLP tile for ' + tx + ' ' + ty);
    return 'https://geobasis-rlp.de/data/dgm1/current/tif/' + n;
  });
}

export async function otd(ll, dataset) {
  const c = pointCache('opentopodata-' + dataset);
  const miss = [...new Set(ll.map(([a, b]) => k5(a, b)))].filter((k) => !(k in c.map));
  for (let i = 0; i < miss.length; i += 100) {
    const batch = miss.slice(i, i + 100);
    const j = await (await politeFetch(`https://api.opentopodata.org/v1/${dataset}?locations=${batch.join('|')}`, {}, 'opentopodata')).json();
    if (!Array.isArray(j.results)) throw new Error('otd: ' + JSON.stringify(j).slice(0, 300));
    j.results.forEach((r, q) => { c.map[batch[q]] = r.elevation; });
    c.save(); await sleep(2600);
  }
  return ll.map(([a, b]) => c.map[k5(a, b)]);
}

// ---- LGL-BW DGM1 open data (2 km x 2 km ZIP tiles of XYZ text at the 1 m pixel centres; float metres DHHN2016).
// (The INSPIRE WCS above serves the same model as 16-bit integers, i.e. quantised to 1 m: unusable for grades.)
// Tiles: /data/dgm/dgm1_32_<E km, odd>_<N km, even>_2_bw.zip (pattern from the portal's odp-products.json).
import { inflateRawSync } from 'node:zlib';
function unzipAll(buf, re) {     // entries whose name matches re, via the central directory
  let e = buf.length - 22; while (e > 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10); let o = buf.readUInt32LE(e + 16); const out = [];
  for (let k = 0; k < n; k++) {
    const m = buf.readUInt16LE(o + 10), cs = buf.readUInt32LE(o + 20), nl = buf.readUInt16LE(o + 28), xl = buf.readUInt16LE(o + 30), cl = buf.readUInt16LE(o + 32), lo = buf.readUInt32LE(o + 42);
    const name = buf.slice(o + 46, o + 46 + nl).toString();
    if (re.test(name)) { const st = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), d = buf.slice(st, st + cs); out.push({ name, data: m === 8 ? inflateRawSync(d) : d }); }
    o += 46 + nl + xl + cl;
  }
  return out;
}
const bwGrids = new Map();
async function bwTile(te, tn) {
  const key = `${te}_${tn}`;
  if (bwGrids.has(key)) return bwGrids.get(key);
  const dir = resolve(CACHE, 'bw-dgm1-xyz'); mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `dgm1_32_${te}_${tn}_2_bw.zip`);
  if (!existsSync(file)) {
    console.log(`bw-dgm1-xyz: tile ${te} ${tn}`);
    const res = await politeFetch(`https://opengeodata.lgl-bw.de/data/dgm/dgm1_32_${te}_${tn}_2_bw.zip`, { headers: { 'User-Agent': 'Mozilla/5.0 (F1Drive track audit)' } }, 'bw zip');
    writeFileSync(file, Buffer.from(await res.arrayBuffer())); await sleep(2000);
  }
  const ents = unzipAll(readFileSync(file), /.xyz$/i);
  const x0 = te * 1000, y0 = tn * 1000, W = 2000, H = 2000, data = new Float64Array(W * H).fill(NaN);
  let n = 0;
  for (const ent of ents) {
  const txt = ent.data.toString('latin1');
  let p = 0;
  while (p < txt.length) {
    let e = txt.indexOf('\n', p); if (e < 0) e = txt.length;
    const line = txt.slice(p, e).trim(); p = e + 1;
    if (!line) continue;
    const [a, b, c] = line.split(/\s+/).map(Number);
    const i = Math.floor(a - x0), j = Math.floor(y0 + H - b);   // row 0 = north edge
    if (i >= 0 && i < W && j >= 0 && j < H) { data[j * W + i] = c; n++; }
  }
  }
  const r = { w: W, h: H, data, px: 1, py: 1, x0, y0: y0 + H, nodata: null, names: ents.map((q) => q.name), n };
  bwGrids.set(key, r);
  return r;
}
export async function bwXyz(ll) {
  const out = [];
  for (const [lat, lon] of ll) {
    const [x, y] = toUTM(lat, lon, 32);
    let te = Math.floor(x / 1000); if (te % 2 === 0) te -= 1;
    let tn = Math.floor(y / 1000); if (tn % 2 !== 0) tn -= 1;
    const r = await bwTile(te, tn);
    let v = bilinear(r, x, y);
    out.push(v === null || !Number.isFinite(v) ? null : v);
  }
  return out;
}
