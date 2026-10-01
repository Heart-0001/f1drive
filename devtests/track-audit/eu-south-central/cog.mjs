// Minimal cloud-optimised GeoTIFF reader over HTTP range requests (classic TIFF and BigTIFF; full-resolution IFD only;
// tiled; deflate / LZW / none; predictor 1 / 2 / 3; one band). Every byte range read is cached on disk under
// devtests/track-audit/cache/<cacheName>/ (header + one file per tile), so a re-run makes no requests.
//   const c = await openCOG(url, cacheName); c.info; await c.sample(X, Y) (raster CRS coords, bilinear); await c.window(...)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
const HERE = dirname(fileURLToPath(import.meta.url));
const UA = { 'User-Agent': 'F1Drive track audit (devtests; cached one-off range reads)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lzwDecode(src) {
  const out = []; let dict, next, width, bitPos = 0, prev = null;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict[i] = [i]; next = 258; width = 9; };
  reset();
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = src[(bitPos + i) >> 3];
      if (byte === undefined) return 257;
      v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += width; return v;
  };
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { reset(); prev = null; continue; }
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else break;
    for (const b of entry) out.push(b);
    if (prev) dict[next++] = prev.concat([entry[0]]);
    prev = entry;
    if (next + 1 >= (1 << width) && width < 12) width++;
  }
  return Uint8Array.from(out);
}

export async function openCOG(url, cacheName, opts = {}) {
  const dir = resolve(HERE, '..', 'cache', cacheName);
  mkdirSync(dir, { recursive: true });
  const delay = opts.delay ?? 150;
  let last = 0;
  async function range(a, b) {
    const wait = last + delay - Date.now(); if (wait > 0) await sleep(wait);
    for (let t = 0; ; t++) {
      try {
        last = Date.now();
        const r = await fetch(url, { headers: Object.assign({ Range: `bytes=${a}-${b}` }, UA) });
        if (r.status === 206) return Buffer.from(await r.arrayBuffer());
        if (r.status === 200) throw new Error('server ignored Range');
        throw new Error('HTTP ' + r.status);
      } catch (e) { if (t > 5) throw e; await sleep(2000 * 2 ** t); }
    }
  }
  // header: first 1 MB (cached) + any tag arrays beyond it
  const hfile = resolve(dir, 'header.bin');
  let head = existsSync(hfile) ? readFileSync(hfile) : null;
  if (!head) { head = await range(0, (opts.headBytes || 1048576) - 1); writeFileSync(hfile, head); }
  const extra = {};
  async function bytesAt(off, len) {
    if (off + len <= head.length) return head.subarray(off, off + len);
    const k = `x${off}_${len}`, f = resolve(dir, k + '.bin');
    if (extra[k]) return extra[k];
    if (existsSync(f)) return (extra[k] = readFileSync(f));
    const b = await range(off, off + len - 1); writeFileSync(f, b); return (extra[k] = b);
  }
  const le = head[0] === 0x49;
  const rd = (b, o, n) => n === 2 ? (le ? b.readUInt16LE(o) : b.readUInt16BE(o)) : n === 4 ? (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
    : Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o));
  const big = rd(head, 2, 2) === 43;
  const ifd0 = big ? rd(head, 8, 8) : rd(head, 4, 4);
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
  const tags = {};
  {
    const ib = await bytesAt(ifd0, 8);
    const n = big ? rd(ib, 0, 8) : rd(ib, 0, 2), esz = big ? 20 : 12, base = big ? 8 : 2;
    const ent = await bytesAt(ifd0, base + n * esz);
    for (let i = 0; i < n; i++) {
      const e = base + i * esz, tag = rd(ent, e, 2), type = rd(ent, e + 2, 2), cnt = big ? rd(ent, e + 4, 8) : rd(ent, e + 4, 4);
      const vo = big ? e + 12 : e + 8, inl = big ? 8 : 4, bytes = (SZ[type] || 1) * cnt;
      const src = bytes <= inl ? ent.subarray(vo, vo + bytes) : await bytesAt(big ? rd(ent, vo, 8) : rd(ent, vo, 4), bytes);
      const vals = [];
      for (let k = 0; k < cnt; k++) {
        const o = k * (SZ[type] || 1);
        if (type === 3) vals.push(rd(src, o, 2)); else if (type === 4) vals.push(rd(src, o, 4));
        else if (type === 16) vals.push(rd(src, o, 8));
        else if (type === 12) vals.push(le ? src.readDoubleLE(o) : src.readDoubleBE(o));
        else if (type === 11) vals.push(le ? src.readFloatLE(o) : src.readFloatBE(o));
        else if (type === 2) vals.push(String.fromCharCode(src[o]));
        else vals.push(src[o]);
      }
      tags[tag] = type === 2 ? vals.join('').replace(/\0+$/, '') : vals;
    }
  }
  const W = tags[256][0], H = tags[257][0], TW = tags[322][0], TH = tags[323][0];
  const bits = tags[258][0], comp = tags[259] ? tags[259][0] : 1, pred = tags[317] ? tags[317][0] : 1, fmt = tags[339] ? tags[339][0] : 1;
  const scale = tags[33550], tie = tags[33922], nodata = tags[42113] ? parseFloat(tags[42113]) : null;
  const gk = tags[34735] || [];
  let rasterType = 1; for (let k = 4; k < gk.length; k += 4) if (gk[k] === 1025) rasterType = gk[k + 3];
  const offs = tags[324], cnts = tags[325], across = Math.ceil(W / TW), bps = bits / 8;
  const info = { W, H, TW, TH, bits, comp, pred, fmt, scale, tie, nodata, rasterType, big, geokeys: gk, url };
  const tileCache = new Map();
  async function tile(tx, ty) {
    const idx = ty * across + tx, key = idx;
    if (tileCache.has(key)) return tileCache.get(key);
    const f = resolve(dir, `t${idx}.bin`);
    let raw;
    if (existsSync(f)) raw = readFileSync(f);
    else { raw = cnts[idx] ? await range(offs[idx], offs[idx] + cnts[idx] - 1) : Buffer.alloc(0); writeFileSync(f, raw); }
    let b = null;
    if (raw.length) {
      b = comp === 1 ? new Uint8Array(raw) : (comp === 8 || comp === 32946) ? new Uint8Array(inflateSync(raw)) : comp === 5 ? lzwDecode(raw) : null;
      if (!b) throw new Error('compression ' + comp);
      if (pred === 2) {
        const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let r = 0; r < TH; r++) for (let c = 1; c < TW; c++) {
          const p = (r * TW + c) * bps, q = p - bps;
          if (bits === 16) d.setUint16(p, (d.getUint16(p, le) + d.getUint16(q, le)) & 0xffff, le);
          else if (bits === 32) d.setUint32(p, (d.getUint32(p, le) + d.getUint32(q, le)) >>> 0, le);
          else b[p] = (b[p] + b[q]) & 255;
        }
      } else if (pred === 3) {
        const out = new Uint8Array(b.length), rowB = TW * bps;
        for (let r = 0; r < TH; r++) {
          const row = b.slice(r * rowB, (r + 1) * rowB);
          for (let i = 1; i < rowB; i++) row[i] = (row[i] + row[i - 1]) & 255;
          for (let c = 0; c < TW; c++) for (let k = 0; k < bps; k++) out[r * rowB + c * bps + (le ? bps - 1 - k : k)] = row[k * TW + c];
        }
        b = out;
      }
    }
    const vals = new Float64Array(TW * TH).fill(NaN);
    if (b) {
      const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (let i = 0; i < TW * TH; i++) {
        const o = i * bps; if (o + bps > b.length) break;
        let v = fmt === 3 ? (bits === 32 ? d.getFloat32(o, le) : d.getFloat64(o, le))
          : fmt === 2 ? (bits === 16 ? d.getInt16(o, le) : d.getInt32(o, le)) : (bits === 16 ? d.getUint16(o, le) : d.getUint32(o, le));
        if (nodata !== null && v === nodata) v = NaN;
        if (v < -1000 || v > 10000) v = NaN;
        vals[i] = v;
      }
    }
    tileCache.set(key, vals);
    return vals;
  }
  // pixel (col, row) value
  async function px(c, r) {
    if (c < 0 || r < 0 || c >= W || r >= H) return NaN;
    const t = await tile(Math.floor(c / TW), Math.floor(r / TH));
    return t[(r % TH) * TW + (c % TW)];
  }
  // raster CRS (X, Y) -> bilinear value; pixel centres at tie + (i + 0.5) * scale for PixelIsArea
  async function sample(X, Y) {
    const off = rasterType === 1 ? 0.5 : 0;
    const fc = (X - tie[3]) / scale[0] - off + tie[0], fr = (tie[4] - Y) / scale[1] - off + tie[1];
    const c0 = Math.floor(fc), r0 = Math.floor(fr), tx = fc - c0, ty = fr - r0;
    const v00 = await px(c0, r0), v10 = await px(c0 + 1, r0), v01 = await px(c0, r0 + 1), v11 = await px(c0 + 1, r0 + 1);
    const vs = [[v00, (1 - tx) * (1 - ty)], [v10, tx * (1 - ty)], [v01, (1 - tx) * ty], [v11, tx * ty]].filter((q) => Number.isFinite(q[0]));
    if (!vs.length) return NaN;
    const ws = vs.reduce((s, q) => s + q[1], 0);
    return ws > 0 ? vs.reduce((s, q) => s + q[0] * q[1], 0) / ws : vs[0][0];
  }
  return { info, tags, sample, px, tile };
}
