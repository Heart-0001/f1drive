// Copied from devtests/track-audit/mideast/glo30.mjs (2026-10-01) so this folder does not depend on another region's files.
// Copernicus DEM GLO-30 (30 m, the full-resolution version of the GLO-90 model the game uses) read straight from the
// public cloud-optimised GeoTIFFs on AWS Open Data (s3://copernicus-dem-30m, no key needed). Only the 1024 x 1024 tiles a
// circuit needs are fetched (HTTP range requests); the decoded window is cached under
// devtests/track-audit/cache/glo30/<name>.json, so a re-run makes no requests.
// Licence: Copernicus DEM - produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and
// Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved (free licence).
// Note: GLO-30 is a SURFACE model (TanDEM-X radar, acquisitions 2011-2015): grandstands / buildings / bridges are in it,
// and anything built after ~2014 (Jeddah's 2021 circuit) is not.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
const HERE = dirname(fileURLToPath(import.meta.url)), CACHE = resolve(HERE, '..', 'cache', 'glo30');
const UA = { 'User-Agent': 'F1Drive track audit (devtests; cached one-off reads)' };

function tileName(lat, lon) {
  const la = Math.floor(lat), lo = Math.floor(lon);
  const ns = (la >= 0 ? 'N' : 'S') + String(Math.abs(la)).padStart(2, '0');
  const ew = (lo >= 0 ? 'E' : 'W') + String(Math.abs(lo)).padStart(3, '0');
  const n = `Copernicus_DSM_COG_10_${ns}_00_${ew}_00_DEM`;
  return { n, url: `https://copernicus-dem-30m.s3.amazonaws.com/${n}/${n}.tif` };
}
async function range(url, a, b) {
  for (let t = 0; ; t++) {
    try {
      const r = await fetch(url, { headers: Object.assign({ Range: `bytes=${a}-${b}` }, UA) });
      if (r.status === 206 || r.status === 200) return Buffer.from(await r.arrayBuffer());
      throw new Error('HTTP ' + r.status);
    } catch (e) { if (t > 4) throw e; await new Promise((r) => setTimeout(r, 2000 * (t + 1))); }
  }
}

// Window [south, west, north, east] of the 1-degree tile containing it -> {lat0 (north edge of row 0 centre), lon0, dlat, dlon, w, h, z[]}.
export async function glo30Window(name, bbox) {
  const file = resolve(CACHE, name + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(CACHE, { recursive: true });
  const [s, w, n, e] = bbox, { url } = tileName((s + n) / 2, (w + e) / 2);
  const head = await range(url, 0, 65535);
  const u16 = (o) => head.readUInt16LE(o), u32 = (o) => head.readUInt32LE(o), f64 = (o) => head.readDoubleLE(o);
  const off = u32(4), cnt = u16(off), tags = {};
  for (let i = 0; i < cnt; i++) {
    const q = off + 2 + i * 12, tag = u16(q), type = u16(q + 2), c = u32(q + 4);
    const sz = { 3: 2, 4: 4, 12: 8, 2: 1 }[type] * c, at = sz <= 4 ? q + 8 : u32(q + 8);
    const vals = [];
    for (let k = 0; k < c; k++) vals.push(type === 3 ? u16(at + 2 * k) : type === 4 ? u32(at + 4 * k) : type === 12 ? f64(at + 8 * k) : head[at + k]);
    tags[tag] = vals;
  }
  const W = tags[256][0], H = tags[257][0], TW = tags[322][0], TH = tags[323][0];
  if (tags[259][0] !== 8 || tags[339][0] !== 3 || tags[258][0] !== 32) throw new Error('unexpected GeoTIFF layout');
  const pred = tags[317][0], scale = tags[33550], tie = tags[33922];
  const geokeys = tags[34735], rasterType = (() => { for (let k = 4; k < geokeys.length; k += 4) if (geokeys[k] === 1025) return geokeys[k + 3]; return 1; })();
  // GeoTIFF: tiepoint raster (I,J) -> model (X,Y); PixelIsArea: the model point is the pixel's CORNER
  const lonC = (i) => tie[3] + (i - tie[0] + (rasterType === 1 ? 0.5 : 0)) * scale[0];
  const latC = (j) => tie[4] - (j - tie[1] + (rasterType === 1 ? 0.5 : 0)) * scale[1];
  const i0 = Math.max(0, Math.floor((w - tie[3]) / scale[0]) - 2), i1 = Math.min(W - 1, Math.ceil((e - tie[3]) / scale[0]) + 2);
  const j0 = Math.max(0, Math.floor((tie[4] - n) / scale[1]) - 2), j1 = Math.min(H - 1, Math.ceil((tie[4] - s) / scale[1]) + 2);
  const tilesAcross = Math.ceil(W / TW), offs = tags[324], cnts = tags[325];
  const ww = i1 - i0 + 1, hh = j1 - j0 + 1, z = new Array(ww * hh).fill(null);
  for (let ty = Math.floor(j0 / TH); ty <= Math.floor(j1 / TH); ty++) {
    for (let tx = Math.floor(i0 / TW); tx <= Math.floor(i1 / TW); tx++) {
      const ti = ty * tilesAcross + tx, raw = inflateSync(await range(url, offs[ti], offs[ti] + cnts[ti] - 1));
      const rowB = TW * 4, val = new Float32Array(TW * TH), tmp = Buffer.alloc(4);
      for (let r = 0; r < TH; r++) {
        const row = raw.subarray(r * rowB, (r + 1) * rowB);
        if (pred === 3) for (let k = 1; k < rowB; k++) row[k] = (row[k] + row[k - 1]) & 255;
        for (let c = 0; c < TW; c++) {
          if (pred === 3) { tmp[0] = row[c]; tmp[1] = row[TW + c]; tmp[2] = row[2 * TW + c]; tmp[3] = row[3 * TW + c]; val[r * TW + c] = tmp.readFloatBE(0); }
          else val[r * TW + c] = row.readFloatLE(c * 4);
        }
      }
      for (let j = Math.max(j0, ty * TH); j <= Math.min(j1, ty * TH + TH - 1); j++)
        for (let i = Math.max(i0, tx * TW); i <= Math.min(i1, tx * TW + TW - 1); i++)
          z[(j - j0) * ww + (i - i0)] = Math.round(val[(j - ty * TH) * TW + (i - tx * TW)] * 100) / 100;
    }
  }
  const out = { source: url, licence: 'Copernicus DEM GLO-30, (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA',
    rasterType, lonC0: lonC(i0), latC0: latC(j0), dlon: scale[0], dlat: scale[1], w: ww, h: hh, z, fetched: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(out), 'utf8');
  return out;
}
// bilinear on pixel centres
export function sampleGrid(g, lat, lon) {
  const fx = (lon - g.lonC0) / g.dlon, fy = (g.latC0 - lat) / g.dlat;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  if (x0 < 0 || y0 < 0 || x0 + 1 >= g.w || y0 + 1 >= g.h) return null;
  const v = (x, y) => g.z[y * g.w + x];
  return v(x0, y0) * (1 - tx) * (1 - ty) + v(x0 + 1, y0) * tx * (1 - ty) + v(x0, y0 + 1) * (1 - tx) * ty + v(x0 + 1, y0 + 1) * tx * ty;
}
