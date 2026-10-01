// node devtests/track-audit/apac/layout.mjs [id]  -- OSM centreline of the layout (map-matched to the game's lap), lateral
// deviation game -> OSM (true metres, before the game's official-length rescale), lengths. Writes apac/out/osm-<id>.json
import { resolve } from 'node:path';
import { osmCentreline, deviation, loadOSM } from './osmline2.mjs';
import { IDS, HERE, cumLen, writeJSON, track } from './common.mjs';

const OPTS = {
  'jp-1962': { exclude: (w) => /Pit|コース|カート|West Circuit/.test(w.tags.name || '') || w.tags.highway !== 'raceway' },
  'sg-2008': { street: true, anyDir: true, maxSnap: 30, exclude: (w) => w.tags.raceway === 'pitlane' || /Pit/.test(w.tags.name || '') || /^(service|footway|cycleway|path|steps|motorway|motorway_link|trunk_link)$/.test(w.tags.highway) || w.tags.layer === '1' && w.tags.bridge !== 'yes' || (w.tags.layer && +w.tags.layer < 0) || (w.tags.bridge === 'yes' && !/Esplanade/.test(w.tags['bridge:name'] || '') && w.tags.highway !== 'raceway' && !/Anderson|Fullerton/.test(w.tags.name || '')) },
  'my-1999': { exclude: (w) => /Pit|North Circuit|South Circuit|Handling/.test(w.tags.name || '') || w.tags.highway !== 'raceway' },
  'cn-2004': { exclude: (w) => w.id !== 156328670 },
  'au-1953': null, // set below from the circuit relation
};
for (const id of process.argv[2] ? [process.argv[2]] : IDS) {
  let opts = OPTS[id];
  if (id === 'au-1953') {
    const rel = loadOSM(id).find((e) => e.type === 'relation' && e.id === 280443);
    const mem = new Set(rel.members.filter((m) => m.type === 'way').map((m) => m.ref));
    opts = { street: true, maxSnap: 30, exclude: (w) => !mem.has(w.id) };
  }
  const r = osmCentreline(id, opts);
  const L = cumLen(r.line)[r.line.length], G = cumLen(r.gameXY)[r.gameXY.length];
  const dev = deviation(r.gameXY, r.line, 5);
  const mx = dev.reduce((a, b) => (b.d > a.d ? b : a));
  const mean = dev.reduce((a, b) => a + b.d, 0) / dev.length;
  const p95 = dev.map((d) => d.d).sort((a, b) => a - b)[Math.floor(dev.length * 0.95)];
  const runs = []; let cur = null;
  for (const p of dev) { if (p.d > 6) { if (!cur) { cur = { s0: p.s, max: 0 }; runs.push(cur); } cur.s1 = p.s; if (p.d > cur.max) { cur.max = p.d; cur.at = p.s; } } else cur = null; }
  // game s (official-length scale) = true s * scale
  const t = track(id), scale = t.lengthKm * 1000 / G;
  const usedWays = [...new Set(r.anchors.filter((a) => a.snap).map((a) => a.snap.e.w.id))];
  const out = { id, osmLength: L, gameTrueLength: G, gameLength: t.lengthKm * 1000, scale, gaps: r.gaps.length, gapAt: r.gaps.map((g) => Math.round(g.s)),
    devMean: mean, devP95: p95, devMax: mx.d, devMaxAtGameS: mx.s * scale, stretches: runs.map((q) => ({ fromS: Math.round(q.s0 * scale), toS: Math.round(q.s1 * scale), max: +q.max.toFixed(1), atS: Math.round(q.at * scale) })),
    usedWays, llLine: r.llLine.map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)]) };
  writeJSON(resolve(HERE, 'out', 'osm-' + id + '.json'), out);
  console.log(id, 'osm', L.toFixed(0), 'game true', G.toFixed(0), 'game', out.gameLength, 'gaps', r.gaps.length, r.gaps.length ? JSON.stringify(out.gapAt.slice(0, 10)) : '',
    'dev mean', mean.toFixed(2), 'p95', p95.toFixed(1), 'max', mx.d.toFixed(1), 'at game s', (mx.s * scale).toFixed(0), 'ways', usedWays.length);
  console.log('  >6 m:', out.stretches.map((q) => `${q.fromS}-${q.toS} (${q.max} @${q.atS})`).join(', '));
}
