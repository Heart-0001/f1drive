// node west/tiff-probe.mjs <file.tif> : prints the GeoTIFF header info read by ../be-nl-de-gb/tiff.mjs
import { readFileSync } from 'node:fs';
import { readTiff } from '../be-nl-de-gb/tiff.mjs';
const t = readTiff(readFileSync(process.argv[2]));
let mn = Infinity, mx = -Infinity, nd = 0;
for (const v of t.data) { if (t.nodata !== undefined && v === t.nodata) { nd++; continue; } if (v < mn) mn = v; if (v > mx) mx = v; }
console.log(JSON.stringify({ w: t.w, h: t.h, scale: t.scale, tie: t.tie, nodata: t.nodata, min: mn, max: mx, nd, info: t.info }).slice(0, 1500));
