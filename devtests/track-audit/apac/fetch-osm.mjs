// node devtests/track-audit/apac/fetch-osm.mjs  -- one Overpass query per circuit (cached in cache/overpass/<id>-*.json)
import { IDS, track, toLL, overpass, sleep } from './common.mjs';

for (const id of process.argv[2] ? [process.argv[2]] : IDS) {
  const t = track(id);
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of t.points) {
    const [lat, lon] = toLL(t, p[0], p[1]);
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  const mLat = 400 / 110540, mLon = 400 / (111320 * Math.cos(s * Math.PI / 180));
  const bb = `${(s - mLat).toFixed(6)},${(w - mLon).toFixed(6)},${(n + mLat).toFixed(6)},${(e + mLon).toFixed(6)}`;
  const q = `[out:json][timeout:180];
(
  way["highway"](${bb});
  way["raceway"](${bb});
  node["raceway"](${bb});
  node["highway"="raceway"](${bb});
  node["name"~"[Ss]tart|[Ff]inish|[Gg]rid|[Pp]it"](${bb});
  way["bridge"](${bb});
  way["tunnel"](${bb});
  way["covered"](${bb});
  way["man_made"="bridge"](${bb});
  way["building"="bridge"](${bb});
  way["building"]["min_height"](${bb});
  way["building:part"]["min_height"](${bb});
  way["building"]["layer"](${bb});
  relation["name"~"Circuit|Grand Prix|Raceway|Speedway"](${bb});
  relation["sport"="motor"](${bb});
);
out tags geom;`;
  const j = await overpass(id + '-all', q);
  console.log(id, bb, 'elements', j.elements.length);
  await sleep(5000);
}
