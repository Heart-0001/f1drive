// node devtests/track-audit/apac/dem.mjs [id] -- DEM profiles along the OSM centreline (out/osm-<id>.json; Albert Park: the circuit
// relation chain out/osm-au-1953-relation.json), started at the game's start line and in the racing direction:
//   glo30    Copernicus DEM GLO-30 (30 m surface model, TanDEM-X 2011-2015) from the AWS open COGs (glo30.mjs; cache/glo30/)
//   srtm30m  SRTM GL1 30 m (surface model, Feb 2000) via the OpenTopoData public API (2.6 s between requests, 100 points each;
//            cache/otd-srtm30m/<id>.json)
import { resolve } from 'node:path';
import { IDS, HERE, track, toLL, readJSON, writeJSON, metric, resample, project, otd } from './common.mjs';
import { glo30Window, sampleGrid } from './glo30.mjs';
export function osmLine(id) {
  // Singapore: the map-matched OSM path detours round dual carriageways (5279 m vs 4930 m), so the game's own centreline (mean
  // 2.0 m, p95 7 m from the OSM roads) is sampled there.
  if (id === 'sg-2008') return readJSON(resolve(HERE, 'out', 'gameline-sg-2008.json')).llLine;
  const f = id === 'au-1953' ? 'osm-au-1953-relation.json' : 'osm-' + id + '.json';
  return readJSON(resolve(HERE, 'out', f)).llLine;
}
// OSM line as metric polyline turned to start at the game's points[0] and oriented in the racing direction
export function osmLoop(id) {
  const t = track(id), ll = osmLine(id), M = metric(t.geo.lat0, t.geo.lon0);
  let XY = ll.map(([a, b]) => M.xy(a, b));
  const [sl, so] = toLL(t, t.points[0][0], t.points[0][1]), S = M.xy(sl, so);
  const pr = project(XY, S[0], S[1]);
  // insert the foot and rotate
  const a = XY[pr.seg], b = XY[(pr.seg + 1) % XY.length], foot = [a[0] + (b[0] - a[0]) * pr.t, a[1] + (b[1] - a[1]) * pr.t];
  XY = [foot, ...XY.slice(pr.seg + 1), ...XY.slice(0, pr.seg + 1)];
  // direction: the game's 2nd-quarter point should be ahead
  const [ql, qo] = toLL(t, ...t.points[Math.floor(t.points.length / 4)]), Q = M.xy(ql, qo), pq = project(XY, Q[0], Q[1]);
  if (pq.s > pq.total / 2) XY = [XY[0], ...XY.slice(1).reverse()];
  return { XY, M, startOffset: pr.dist };
}
const ids = process.argv[2] ? [process.argv[2]] : IDS;
for (const id of ids) {
  const { XY, M } = osmLoop(id);
  const R = resample(XY, 10), pts = R.pts.map((p) => M.ll(p.x, p.z));
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [la, lo] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  const g = await glo30Window(id + '-apac', [s - 0.002, w - 0.002, n + 0.002, e + 0.002]);
  const glo = pts.map(([la, lo]) => sampleGrid(g, la, lo));
  writeJSON(resolve(HERE, 'out', 'dem-' + id + '-glo30.json'), { id, source: 'Copernicus DEM GLO-30 (AWS open data COG ' + g.source + ')', ds: R.ds, total: R.total,
    profile: pts.map(([la, lo], i) => ({ s: +(i * R.ds).toFixed(1), lat: +la.toFixed(6), lon: +lo.toFixed(6), h: glo[i] === null ? null : +glo[i].toFixed(2) })) });
  let line = `${id} glo30 range ${(Math.max(...glo) - Math.min(...glo)).toFixed(1)} m`;
  if (id !== 'jp-1962') {
    const R3 = resample(XY, 30), p3 = R3.pts.map((p) => M.ll(p.x, p.z).map((v) => +v.toFixed(5)));
    const sr = await otd('srtm30m', id, p3);
    writeJSON(resolve(HERE, 'out', 'dem-' + id + '-srtm30m.json'), { id, source: 'SRTM GL1 30 m via api.opentopodata.org/v1/srtm30m', ds: R3.ds, total: R3.total,
      profile: p3.map(([la, lo], i) => ({ s: +(i * R3.ds).toFixed(1), lat: la, lon: lo, h: sr[i] })) });
    const v = sr.filter((x) => x !== null);
    line += `, srtm30m range ${(Math.max(...v) - Math.min(...v)).toFixed(1)} m (${v.length} pts)`;
  }
  console.log(line);
}
