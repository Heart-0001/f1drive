// node devtests/track-audit/americas/osm-streets.mjs [ids...]
// Lean Overpass queries (OpenStreetMap, ODbL) along the game's own centreline (a polyline 'around' filter, ~25 m):
//   <id>-raceway   (if not cached yet): raceway ways / nodes, pit lanes, start / finish nodes in the bbox
//   <id>-streets   the public roads under the line (street circuits: the track's road where it is not mapped as raceway)
//   <id>-tunnels-bridges (if not cached yet): bridges / tunnels / covered ways within 25 m of the line
// Relations are skipped (the relation query timed out on every Overpass instance on 2026-10-01).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { overpass, HERE, CACHE } from './net.mjs';

const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['us-2023', 'us-2022', 'us-1909', 'us-1956', 'ca-1978'];
const cached = (n) => existsSync(resolve(CACHE, 'overpass', n + '.json'));
for (const id of IDS) {
  const g = JSON.parse(readFileSync(resolve(HERE, 'out', 'game-' + id + '.json'), 'utf8'));
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of g.points) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  const pad = 400 / 111000, padx = pad / Math.cos(((s + n) / 2) * Math.PI / 180);
  const bb = `${(s - pad).toFixed(5)},${(w - padx).toFixed(5)},${(n + pad).toFixed(5)},${(e + padx).toFixed(5)}`;
  // the game line every ~40 m, closed
  const line = [];
  let acc = 0;
  for (let i = 0; i < g.samples.length; i++) {
    const q = g.samples[i];
    if (i === 0 || acc >= 40) { line.push(q.lat.toFixed(6), q.lon.toFixed(6)); acc = 0; }
    acc += g.ds;
  }
  line.push(g.samples[0].lat.toFixed(6), g.samples[0].lon.toFixed(6));
  const around = (r) => `(around:${r},${line.join(',')})`;
  if (!cached(id + '-raceway')) {
    const q1 = `[out:json][timeout:120];(way["highway"="raceway"](${bb});way["raceway"](${bb});node["raceway"](${bb});node["highway"="raceway"](${bb});` +
      `node["name"~"[Ss]tart|[Ff]inish|[Ll]igne|[Dd]épart|[Aa]rrivée"](${bb});way["service"="pit_lane"](${bb});way["name"~"[Pp]it [Ll]ane|[Pp]itlane|[Pp]it [Rr]oad|[Vv]oie des stands"](${bb}););out tags geom;`;
    const j1 = await overpass(id + '-raceway', q1);
    console.log(id, 'raceway:', j1.elements.length);
  }
  if (!cached(id + '-streets') && !['us-1909', 'us-1956', 'us-2012', 'ca-1978'].includes(id)) {   // permanent circuits (and Montreal: one raceway way covers the lap): raceway ways only
    const q2 = `[out:json][timeout:150];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]${around(20)};);out tags geom;`;
    const j2 = await overpass(id + '-streets', q2);
    console.log(id, 'streets:', j2.elements.length);
  }
  if (!cached(id + '-tunnels-bridges')) {
    const q3 = `[out:json][timeout:150];(way["bridge"]${around(25)};way["tunnel"]${around(25)};way["man_made"="bridge"]${around(25)};way["covered"="yes"]${around(25)};way["building"="bridge"]${around(25)};);out tags geom;`;
    const j3 = await overpass(id + '-tunnels-bridges', q3);
    console.log(id, 'tunnels/bridges:', j3.elements.length);
  }
}
