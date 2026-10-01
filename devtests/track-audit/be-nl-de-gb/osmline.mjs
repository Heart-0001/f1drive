// node osmline.mjs <id> <firstWayId> [rev] [allowed way ids comma-separated | 'rel' | 'raceway'] -> prints the chain
// Library use: osmLoop(id, cfg) -> {ll, ways, L} (closed loop in the ways' oneway direction).
import { osm, chain, proj, cumLen } from './lib.mjs';
export function osmLoop(id, cfg) {
  const j = osm(id);
  let ways = j.elements.filter((e) => e.type === 'way' && e.geometry && e.tags && (e.tags.highway === 'raceway' || e.tags.raceway));
  if (cfg.only) ways = ways.filter((w) => cfg.only.includes(w.id));
  if (cfg.exclude) ways = ways.filter((w) => !cfg.exclude.includes(w.id));
  if (cfg.extra) for (const id2 of cfg.extra) { const w = j.elements.find((e) => e.id === id2 && e.type === 'way'); if (w && !ways.includes(w)) ways.push(w); }
  const c = chain(ways, cfg.first, !!cfg.rev);
  const lat0 = c.ll.reduce((a, p) => a + p[0], 0) / c.ll.length, lon0 = c.ll.reduce((a, p) => a + p[1], 0) / c.ll.length;
  const P = proj(lat0, lon0), xy = c.ll.map((p) => P.fwd(p[0], p[1]));
  const cum = cumLen(xy);
  return Object.assign(c, { xy, cum, L: cum[cum.length - 1], P });
}
if (process.argv[1] && process.argv[1].endsWith('osmline.mjs')) {
  const [id, first, rev, allowed] = process.argv.slice(2);
  const j = osm(id);
  let only = null;
  if (allowed === 'rel') { const rel = j.elements.find((e) => e.type === 'relation' && e.tags.type === 'circuit'); only = rel.members.filter((m) => m.type === 'way' && !/pit/.test(m.role)).map((m) => m.ref); }
  else if (allowed && allowed !== 'raceway') only = allowed.split(',').map(Number);
  const c = osmLoop(id, { first: +first, rev: rev === '1', only });
  console.log(id, 'closed', c.closed, 'gap', c.gap && c.gap.toFixed(1), 'L', c.L.toFixed(1), 'ways', c.ways.length);
  for (const w of c.ways) console.log('  ', w.id, w.rev ? 'rev' : '   ', (c.cum[w.from] || 0).toFixed(0), w.name);
}
