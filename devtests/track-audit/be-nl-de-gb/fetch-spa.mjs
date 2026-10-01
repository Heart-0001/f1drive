import { osmLoop } from './osmline.mjs';
import { resample } from './lib.mjs';
import { wallonia } from './dem.mjs';
const c = osmLoop('be-1925', { first: 126807110, only: null, exclude: [] , ...JSON.parse(process.argv[2] || '{}') });
const r = resample(c.xy, 5);
const ll = r.pts.map(([x, y]) => c.P.inv(x, y));
const h = await wallonia(ll);
console.log('done', h.length, 'nulls', h.filter((v) => v === null).length, 'range', Math.min(...h.filter(Number.isFinite)), Math.max(...h.filter(Number.isFinite)));
