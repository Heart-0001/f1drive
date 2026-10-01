// Minimal GeoTIFF reader (no dependencies): strips or tiles, no compression / deflate / LZW, predictor 1 / 2 / 3,
// uint / int / float samples of 8 / 16 / 32 / 64 bits, one band. Returns {w, h, data: Float64Array, scale, tie, nodata, info}.
import { inflateSync } from 'node:zlib';

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
    if (prev) { dict[next++] = prev.concat([entry[0]]); }
    prev = entry;
    if (next + 1 >= (1 << width) && width < 12) width++;
  }
  return Uint8Array.from(out);
}

export function readTiff(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = buf[0] === 0x49;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error('not a classic TIFF: ' + buf.slice(0, 200).toString());
  const ifd = u32(4), n = u16(ifd), tags = {};
  const sz = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
    const bytes = (sz[type] || 1) * cnt, off = bytes <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let k = 0; k < cnt; k++) {
      const o = off + k * (sz[type] || 1);
      if (type === 3) vals.push(u16(o)); else if (type === 4) vals.push(u32(o));
      else if (type === 12) vals.push(dv.getFloat64(o, le)); else if (type === 11) vals.push(dv.getFloat32(o, le));
      else if (type === 2) vals.push(String.fromCharCode(buf[o])); else if (type === 16) vals.push(Number(dv.getBigUint64(o, le)));
      else vals.push(buf[o]);
    }
    tags[tag] = type === 2 ? vals.join('').replace(/\0+$/, '') : vals;
  }
  const w = tags[256][0], h = tags[257][0], bits = tags[258] ? tags[258][0] : 1, comp = tags[259] ? tags[259][0] : 1;
  const fmt = tags[339] ? tags[339][0] : 1, pred = tags[317] ? tags[317][0] : 1, spp = tags[277] ? tags[277][0] : 1;
  if (spp !== 1) throw new Error('only single-band TIFFs: ' + spp);
  const bps = bits / 8;
  const decode = (bytes) => {
    if (comp === 1) return bytes;
    if (comp === 8 || comp === 32946) return new Uint8Array(inflateSync(bytes));
    if (comp === 5) return lzwDecode(bytes);
    throw new Error('compression ' + comp);
  };
  const data = new Float64Array(w * h);
  const getVal = (b, o) => {
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (fmt === 3) return bits === 32 ? d.getFloat32(o, le) : d.getFloat64(o, le);
    if (fmt === 2) return bits === 16 ? d.getInt16(o, le) : bits === 32 ? d.getInt32(o, le) : d.getInt8(o);
    return bits === 16 ? d.getUint16(o, le) : bits === 32 ? d.getUint32(o, le) : d.getUint8(o);
  };
  const blocks = [];   // [x0, y0, bw, bh, offset, count]
  if (tags[322]) {
    const tw = tags[322][0], th = tags[323][0], offs = tags[324], cnts = tags[325], across = Math.ceil(w / tw);
    offs.forEach((o, i) => blocks.push([(i % across) * tw, Math.floor(i / across) * th, tw, th, o, cnts[i]]));
  } else {
    const rps = tags[278] ? Math.min(tags[278][0], h) : h, offs = tags[273], cnts = tags[279];
    offs.forEach((o, i) => blocks.push([0, i * rps, w, rps, o, cnts[i]]));
  }
  for (const [x0, y0, bw, bh, o, c] of blocks) {
    let b = decode(buf.subarray(o, o + c));
    if (pred === 2 && fmt !== 3) {         // horizontal differencing (integers)
      b = new Uint8Array(b);
      const d = new DataView(b.buffer);
      for (let r = 0; r < bh; r++) for (let col = 1; col < bw; col++) {
        const p = (r * bw + col) * bps, q = p - bps;
        if (bits === 16) d.setUint16(p, (d.getUint16(p, le) + d.getUint16(q, le)) & 0xffff, le);
        else if (bits === 32) d.setUint32(p, (d.getUint32(p, le) + d.getUint32(q, le)) >>> 0, le);
        else b[p] = (b[p] + b[q]) & 255;
      }
    } else if (pred === 3) {               // floating-point predictor
      const out = new Uint8Array(b.length);
      const rowB = bw * bps;
      for (let r = 0; r < bh; r++) {
        const row = b.slice(r * rowB, (r + 1) * rowB);
        for (let i = 1; i < rowB; i++) row[i] = (row[i] + row[i - 1]) & 255;
        for (let col = 0; col < bw; col++) for (let k = 0; k < bps; k++) {
          // bytes were split into planes, most significant first
          out[r * rowB + col * bps + (le ? bps - 1 - k : k)] = row[k * bw + col];
        }
      }
      b = out;
    }
    for (let r = 0; r < bh; r++) for (let col = 0; col < bw; col++) {
      const X = x0 + col, Y = y0 + r;
      if (X >= w || Y >= h) continue;
      const o2 = (r * bw + col) * bps;
      if (o2 + bps > b.length) continue;
      data[Y * w + X] = getVal(b, o2);
    }
  }
  const nodata = tags[42113] ? parseFloat(tags[42113]) : null;
  return { w, h, data, scale: tags[33550] || null, tie: tags[33922] || null, xform: tags[34264] || null, nodata, tags,
    info: { bits, fmt, comp, pred, tiled: !!tags[322], geokeys: tags[34735] || null } };
}
