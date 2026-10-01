// Minimal GeoTIFF reader (enough for the NRCan HRDEM WCS output): either byte order, strips or tiles, no / deflate
// compression, float32 / int16 / uint16 / int32 samples, ModelTiepoint + ModelPixelScale georeferencing, GDAL_NODATA.
'use strict';
const zlib = require('zlib');
function readTiff(buf) {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  if (u16(2) !== 42) throw new Error('not a classic TIFF');
  const ifd = u32(4), n = u16(ifd), tags = {};
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
    const bytes = (size[type] || 1) * cnt, off = bytes <= 4 ? e + 8 : u32(e + 8), vals = [];
    for (let k = 0; k < cnt; k++) {
      const o = off + k * (size[type] || 1);
      if (type === 3) vals.push(u16(o)); else if (type === 4) vals.push(u32(o)); else if (type === 12) vals.push(f64(o));
      else if (type === 2) vals.push(buf[o]); else if (type === 1) vals.push(buf[o]); else vals.push(u32(o));
    }
    tags[tag] = type === 2 ? Buffer.from(vals).toString('latin1').replace(/\0+$/, '') : vals;
  }
  const W = tags[256][0], H = tags[257][0], bps = tags[258] ? tags[258][0] : 8, comp = tags[259] ? tags[259][0] : 1;
  const fmt = tags[339] ? tags[339][0] : 1, pred = tags[317] ? tags[317][0] : 1;
  if (pred !== 1) throw new Error('predictor ' + pred + ' not supported');
  const out = new Float64Array(W * H).fill(NaN);
  const bytesPer = bps / 8;
  function decode(chunk) {
    if (comp === 1) return chunk;
    if (comp === 8 || comp === 32946) return zlib.inflateSync(chunk);
    throw new Error('compression ' + comp + ' not supported');
  }
  function val(b, o) {
    if (fmt === 3 && bps === 32) return le ? b.readFloatLE(o) : b.readFloatBE(o);
    if (fmt === 3 && bps === 64) return le ? b.readDoubleLE(o) : b.readDoubleBE(o);
    if (fmt === 2 && bps === 16) return le ? b.readInt16LE(o) : b.readInt16BE(o);
    if (fmt === 2 && bps === 32) return le ? b.readInt32LE(o) : b.readInt32BE(o);
    if (bps === 16) return le ? b.readUInt16LE(o) : b.readUInt16BE(o);
    if (bps === 32) return le ? b.readUInt32LE(o) : b.readUInt32BE(o);
    return b[o];
  }
  if (tags[324]) {                                  // tiles
    const tw = tags[322][0], th = tags[323][0], offs = tags[324], cnts = tags[325], across = Math.ceil(W / tw);
    offs.forEach((o, t) => {
      const b = decode(buf.subarray(o, o + cnts[t])), tx0 = (t % across) * tw, ty0 = Math.floor(t / across) * th;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const X = tx0 + x, Y = ty0 + y;
        if (X < W && Y < H) out[Y * W + X] = val(b, (y * tw + x) * bytesPer);
      }
    });
  } else {                                          // strips
    const rps = tags[278] ? tags[278][0] : H, offs = tags[273], cnts = tags[279];
    offs.forEach((o, t) => {
      const b = decode(buf.subarray(o, o + cnts[t]));
      for (let y = 0; y < rps; y++) for (let x = 0; x < W; x++) {
        const Y = t * rps + y;
        if (Y < H) out[Y * W + x] = val(b, (y * W + x) * bytesPer);
      }
    });
  }
  const nodata = tags[42113] ? +tags[42113] : null;
  if (nodata !== null && Number.isFinite(nodata)) for (let i = 0; i < out.length; i++) if (out[i] === nodata) out[i] = NaN;
  const tie = tags[33922], scale = tags[33550];
  return { W, H, data: out, tie, scale, nodata, comp, bps, fmt, tags };
}
module.exports = { readTiff };
