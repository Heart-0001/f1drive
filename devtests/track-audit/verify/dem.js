// DEM readers for the synthesis verification. Every source samples at points WE choose (the game's built centreline),
// so the comparison does not reuse the auditors' sampling. Local rasters: own uncompressed-TIFF reader (written for this
// check, independent of the auditors' tiff.mjs). Remote point services: own cache in cache/verify/<name>.json,
// requests one at a time with a pause (OpenTopoData: 100 locations per request, 2.5 s apart).
'use strict';
const L = require('./lib.js');
const fs = L.fs, path = L.path;
const VC = path.join(L.CACHE, 'verify');
fs.mkdirSync(VC, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'F1Drive-track-audit/1 (one-off verification of a game data audit, cached)' };

// ---------------------------------------------------------------- TIFF (uncompressed, strips or tiles, LE)
function readTiff(file) {
  const b = fs.readFileSync(file);
  const le = b.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => le ? b.readUInt16LE(o) : b.readUInt16BE(o), u32 = (o) => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
  const f64 = (o) => le ? b.readDoubleLE(o) : b.readDoubleBE(o);
  const ifd = u32(4), n = u16(ifd), T = {};
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4), size = (SZ[type] || 1) * cnt;
    const off = size > 4 ? u32(e + 8) : e + 8, v = [];
    for (let k = 0; k < cnt && k < 100000; k++) {
      if (type === 3) v.push(u16(off + 2 * k)); else if (type === 4) v.push(u32(off + 4 * k));
      else if (type === 12) v.push(f64(off + 8 * k)); else if (type === 16) v.push(Number(le ? b.readBigUInt64LE(off + 8 * k) : b.readBigUInt64BE(off + 8 * k)));
      else if (type === 2) { v.push(b.toString('latin1', off, off + cnt)); break; } else v.push(null);
    }
    T[tag] = v;
  }
  const w = T[256][0], h = T[257][0], bps = T[258][0], fmt = (T[339] || [1])[0];
  if ((T[259] || [1])[0] !== 1) throw new Error('compressed TIFF not supported: ' + file);
  const val = (o) => bps === 16 ? (fmt === 2 ? (le ? b.readInt16LE(o) : b.readInt16BE(o)) : u16(o)) : (bps === 32 ? (fmt === 3 ? (le ? b.readFloatLE(o) : b.readFloatBE(o)) : (le ? b.readInt32LE(o) : b.readInt32BE(o))) : NaN);
  const bpp = bps / 8, data = new Float64Array(w * h);
  if (T[322]) { // tiles
    const tw = T[322][0], th = T[323][0], offs = T[324], across = Math.ceil(w / tw);
    offs.forEach((o, t) => {
      const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const X = tx + x, Y = ty + y;
        if (X < w && Y < h) data[Y * w + X] = val(o + (y * tw + x) * bpp);
      }
    });
  } else {
    const offs = T[273], rps = (T[278] || [h])[0];
    offs.forEach((o, si) => {
      for (let y = 0; y < rps; y++) {
        const Y = si * rps + y; if (Y >= h) break;
        for (let x = 0; x < w; x++) data[Y * w + x] = val(o + (y * w + x) * bpp);
      }
    });
  }
  const nod = T[42113] ? parseFloat(T[42113][0]) : null;
  if (nod !== null) for (let i = 0; i < data.length; i++) if (data[i] === nod) data[i] = NaN;
  // geo: x0, y0 = map coordinates of the top-left CORNER of pixel (0,0); dx, dy pixel size
  let x0, y0, dx, dy;
  if (T[34264]) { const m = T[34264]; dx = m[0]; dy = -m[5]; x0 = m[3]; y0 = m[7]; }
  else { const s = T[33550], tp = T[33922]; dx = s[0]; dy = s[1]; x0 = tp[3] - tp[0] * dx; y0 = tp[4] + tp[1] * dy; }
  // GeoKey RasterTypeGeoKey (1025): 2 = PixelIsPoint -> the tie point is a pixel centre
  const gk = T[34735] || []; let rt = 1;
  for (let k = 4; k < gk.length; k += 4) if (gk[k] === 1025) rt = gk[k + 3];
  if (rt === 2) { x0 -= dx / 2; y0 += dy / 2; }
  return { w, h, data, x0, y0, dx, dy, rasterType: rt };
}
function bilinear(r, X, Y) { // map coords
  const fx = (X - r.x0) / r.dx - 0.5, fy = (r.y0 - Y) / r.dy - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  if (i < 0 || j < 0 || i + 1 >= r.w || j + 1 >= r.h) return NaN;
  const v = (a, c) => r.data[c * r.w + a];
  return (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - ty) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * ty;
}
// WGS84 -> UTM (zone), standard Krueger series (sub-mm accuracy is not needed here)
function utm(lat, lon, zone) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const r = Math.PI / 180, phi = lat * r, lam0 = ((zone - 1) * 6 - 180 + 3) * r, lam = lon * r;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const E = 500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const Nn = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [E, lat < 0 ? Nn + 10000000 : Nn];
}
function rasterSource(files, proj) {
  let rs = null;
  return async (pts) => { rs = rs || files.map((f) => readTiff(f)); return pts.map(([lat, lon]) => {
    const [X, Y] = proj ? proj(lat, lon) : [lon, lat];
    for (const r of rs) { const v = bilinear(r, X, Y); if (Number.isFinite(v)) return v; }
    return NaN;
  }); };
}
// Copernicus GLO-30 sub-grids cached by the auditors as JSON {lonC0, latC0 (pixel centres), dlon, dlat, w, h, z}
// (raw COG pixels; only the bilinear sampling and the points are ours)
function gloJson(files) {
  const gs = files.map((f) => JSON.parse(fs.readFileSync(path.join(L.CACHE, 'glo30', f), 'utf8')));
  return async (pts) => pts.map(([lat, lon]) => {
    for (const g of gs) {
      const fx = (lon - g.lonC0) / g.dlon, fy = (g.latC0 - lat) / g.dlat, i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      if (i < 0 || j < 0 || i + 1 >= g.w || j + 1 >= g.h) continue;
      const v = (a, c) => g.z[c * g.w + a];
      return (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - ty) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * ty;
    }
    return NaN;
  });
}
// ---------------------------------------------------------------- remote point services (own cache)
function pcache(name) {
  const f = path.join(VC, name + '.json');
  const map = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  return { map, save: () => fs.writeFileSync(f, JSON.stringify(map)) };
}
const key = (lat, lon) => lat.toFixed(6) + ',' + lon.toFixed(6);
async function getJ(url, opt) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, Object.assign({ headers: UA }, opt || {}));
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 150)), { fatal: true });
      return await r.json();
    } catch (e) { if (e.fatal || a >= 4) throw e; await sleep(4000 * 2 ** a); }
  }
}
function onePerRequest(name, url, parse, gap) {
  return async (pts) => {
    const c = pcache(name), miss = [...new Set(pts.map(([a, b]) => key(a, b)))].filter((k) => !(k in c.map));
    if (miss.length) console.log(`  ${name}: ${miss.length} points to fetch (${gap} ms apart)`);
    let n = 0;
    for (const k of miss) {
      const [lat, lon] = k.split(',').map(Number);
      try { c.map[k] = parse(await getJ(url(lat, lon))); } catch (e) { console.warn('  ' + name + ' ' + e.message); c.map[k] = null; }
      if (++n % 25 === 0) { c.save(); }
      await sleep(gap);
    }
    c.save();
    return pts.map(([a, b]) => { const v = c.map[key(a, b)]; return v === null || v === undefined ? NaN : v; });
  };
}
const wallonia = onePerRequest('wallonia', (lat, lon) =>
  'https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNT_2021_2022/MapServer/identify?geometry=' +
  encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } })) +
  `&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=0&mapExtent=${lon - 0.001},${lat - 0.001},${lon + 0.001},${lat + 0.001}` +
  '&imageDisplay=400,400,96&returnGeometry=false&f=json',
(j) => { const r = j.results && j.results[0]; const v = r ? parseFloat(r.attributes['Stretch.Pixel Value'] ?? r.attributes['Pixel Value']) : NaN; return Number.isFinite(v) ? v : null; }, 700);
const usgs = onePerRequest('usgs-epqs', (lat, lon) => `https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Meters&includeDate=false`,
  (j) => { const v = +j.value; return Number.isFinite(v) && v > -1000 ? v : null; }, 700);
async function batched(name, pts, size, gap, fetchBatch) {
  const c = pcache(name), miss = [...new Set(pts.map(([a, b]) => key(a, b)))].filter((k) => !(k in c.map));
  if (miss.length) console.log(`  ${name}: ${miss.length} points to fetch in ${Math.ceil(miss.length / size)} request(s)`);
  for (let i = 0; i < miss.length; i += size) {
    const b = miss.slice(i, i + size).map((k) => k.split(',').map(Number));
    const vals = await fetchBatch(b);
    b.forEach((p, k) => { c.map[key(p[0], p[1])] = Number.isFinite(vals[k]) ? vals[k] : null; });
    c.save();
    await sleep(gap);
  }
  return pts.map(([a, b]) => { const v = c.map[key(a, b)]; return v === null || v === undefined ? NaN : v; });
}
const er = (pts) => batched('er-dtmrer2022', pts, 100, 1500, async (b) => {
  const body = 'geometry=' + encodeURIComponent(JSON.stringify({ points: b.map((p) => [p[1], p[0]]), spatialReference: { wkid: 4326 } })) +
    '&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json';
  const j = await getJ('https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/public/DtmRER2022/ImageServer/getSamples',
    { method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, UA) });
  const vals = b.map(() => NaN);
  for (const s of j.samples || []) { const v = parseFloat(s.value); if (Number.isFinite(v) && v > -1000) vals[s.locationId] = v; }
  return vals;
});
const otd = (dataset) => (pts) => batched('otd-' + dataset, pts, 100, 2600, async (b) => {
  const j = await getJ(`https://api.opentopodata.org/v1/${dataset}?locations=${b.map((p) => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join('|')}`);
  if (!Array.isArray(j.results)) throw new Error('otd: ' + JSON.stringify(j).slice(0, 200));
  return j.results.map((r) => (r.elevation === null ? NaN : r.elevation));
});
const ahn4 = (pts) => batched('ahn4', pts, 100, 800, async (b) => {
  const geom = encodeURIComponent(JSON.stringify({ points: b.map((p) => [p[1], p[0]]), spatialReference: { wkid: 4326 } }));
  const j = await getJ('https://ahn.arcgisonline.nl/arcgis/rest/services/AHNviewer/AHN4_DTM_50cm/ImageServer/getSamples' +
    `?geometry=${geom}&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json`);
  const vals = b.map(() => NaN);
  for (const s of j.samples || []) { const v = +s.value; if (Number.isFinite(v) && v > -1000) vals[s.locationId] = v; }
  return vals;
});
const CA = (f) => path.join(L.CACHE, f);
const SOURCES = {
  wallonia, usgs, er, ahn4,
  srtm30m: otd('srtm30m'), eudem25m: otd('eudem25m'), ned10m: otd('ned10m'),
  'ignes-es-1991': rasterSource([CA('ign-es/es-1991-mdt05.tif')]),
  'ignes-es-2026': rasterSource([CA('ign-es/es-2026-mdt05.tif')]),
  tinitaly: rasterSource([CA('tinitaly/521300_5050500_523800_5053600.tif')], (a, b) => utm(a, b, 32)),
  'toscana-dsm': rasterSource(fs.readdirSync(CA('toscana-rt_morfologia_iddsm2021_1m_rt')).filter((f) => f.endsWith('.tif'))
    .map((f) => CA('toscana-rt_morfologia_iddsm2021_1m_rt/' + f)), (a, b) => utm(a, b, 32)),
  'glo30-pt-2008': gloJson(['east-pt-2008.json']),
  'glo30-br-1940': gloJson(['br-1940--24_-47.json']),
  'glo30-my-1999': gloJson(['my-1999-apac.json']),
  'glo30-pt-1972': gloJson(['east-pt-1972.json']),
  'glo30-bh-2002': gloJson(['bh-2002.json']),
};
module.exports = { readTiff, bilinear, utm, SOURCES, gloJson, pcache };
