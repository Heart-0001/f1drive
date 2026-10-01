// node devtests/track-audit/west/osm-fetch.mjs <id> ...
// Overpass (ODbL): raceway ways / nodes, motor-sport relations, and tunnels / bridges in the circuit's bbox (+400 m).
// Cached in devtests/track-audit/cache/overpass/<id>-*.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { overpass, HERE } from './net.mjs';

for (const id of process.argv.slice(2)) {
  const g = JSON.parse(readFileSync(resolve(HERE, 'out', 'game-' + id + '.json'), 'utf8'));
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of g.points) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  const pad = 400 / 111000, padx = pad / Math.cos(((s + n) / 2) * Math.PI / 180);
  const bb = `${(s - pad).toFixed(5)},${(w - padx).toFixed(5)},${(n + pad).toFixed(5)},${(e + padx).toFixed(5)}`;
  const q1 = `[out:json][timeout:90];(way["highway"="raceway"](${bb});way["raceway"](${bb});node["raceway"](${bb});node["highway"="raceway"](${bb});` +
    `node["name"~"[Ss]tart|[Ff]inish|[Ll]igne|[Ss]alida|[Mm]eta|[Dd]épart|[Aa]rrivée"](${bb});way["service"="pit_lane"](${bb});way["name"~"[Pp]it|[Ss]tands|[Bb]oxes|[Ff]oso"](${bb}););out tags geom;`;
  const j1 = await overpass(id + '-raceway', q1);
  console.log(id, 'raceway query: ', j1.elements.length, 'elements');
  const q2 = `[out:json][timeout:90];(relation["sport"="motor"](${bb});relation["type"="circuit"](${bb});relation["route"~"raceway|racetrack|motor|racing"](${bb});relation["name"~"[Cc]ircuit|[Cc]ircuito|Madring|Grand Prix|Gran Premio"](${bb}););out tags geom;`;
  const j2 = await overpass(id + '-relations', q2);
  console.log(id, 'relations query: ', j2.elements.length, 'elements', j2.elements.map((x) => x.id + ' ' + (x.tags && x.tags.name)).join(' | '));
  const q3 = `[out:json][timeout:90];(way["tunnel"]["highway"](${bb});way["bridge"]["highway"](${bb});way["man_made"="bridge"](${bb});way["tunnel"]["raceway"](${bb});way["covered"="yes"]["highway"](${bb});way["building"="bridge"](${bb}););out tags geom;`;
  const j3 = await overpass(id + '-tunnels-bridges', q3);
  console.log(id, 'tunnels/bridges query: ', j3.elements.length, 'elements');
}
