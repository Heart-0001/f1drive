// node devtests/track-audit/apac/gsi.mjs -- Suzuka: GSI DEM (5 m laser DEM5A where available, else 10 m) sampled every 10 m along the
// OSM centreline (out/osm-jp-1962.json), via the GSI elevation API (one point per request, sequential, 200 ms apart).
// Cache: cache/gsi5m/jp-1962-osm.json  {"lat,lon": [elevation, hsrc]}.  Source: Geospatial Information Authority of Japan (国土地理院).
import { resolve } from 'node:path';
import { HERE, CACHE, UA, sleep, readJSON, writeJSON, metric, cumLen, resample } from './common.mjs';
const id = 'jp-1962';
const osm = readJSON(resolve(HERE, 'out', 'osm-' + id + '.json'));
const file = resolve(CACHE, 'gsi5m', id + '-osm.json'), cache = readJSON(file, {});
const lat0 = osm.llLine[0][0], lon0 = osm.llLine[0][1], M = metric(lat0, lon0);
const XY = osm.llLine.map(([a, b]) => M.xy(a, b));
const R = resample(XY, 10);
const pts = R.pts.map((p) => M.ll(p.x, p.z));
let n = 0;
for (const [lat, lon] of pts) {
  const k = lat.toFixed(6) + ',' + lon.toFixed(6);
  if (k in cache) continue;
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&outtype=JSON`, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); cache[k] = [Number.isFinite(+j.elevation) ? +j.elevation : null, j.hsrc]; break;
    } catch (e) { if (a > 5) throw e; await sleep(3000 * (a + 1)); }
  }
  if (++n % 50 === 0) { writeJSON(file, cache); console.log(n); }
  await sleep(200);
}
writeJSON(file, cache);
const prof = pts.map(([lat, lon], i) => ({ s: +(i * R.ds).toFixed(1), lat: +lat.toFixed(6), lon: +lon.toFixed(6), h: cache[lat.toFixed(6) + ',' + lon.toFixed(6)][0], src: cache[lat.toFixed(6) + ',' + lon.toFixed(6)][1] }));
writeJSON(resolve(HERE, 'out', 'dem-' + id + '-gsi.json'), { id, source: 'GSI DEM via cyberjapandata2.gsi.go.jp getelevation.php (DEM5A laser 5 m where hsrc says so)', ds: R.ds, total: R.total, profile: prof });
const srcs = {}; prof.forEach((p) => { srcs[p.src] = (srcs[p.src] || 0) + 1; });
console.log('samples', prof.length, 'ds', R.ds.toFixed(2), 'sources', JSON.stringify(srcs), 'range', (Math.max(...prof.map((p) => p.h)) - Math.min(...prof.map((p) => p.h))).toFixed(1));
