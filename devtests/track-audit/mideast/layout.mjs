// node devtests/track-audit/mideast/layout.mjs <id>   (prints; audit.mjs uses the exported function)
// Game centreline (tracks-data.js points and the js/track.js samples the car drives on) against the OpenStreetMap raceway
// ways of the layout: lateral deviation both ways, lengths, racing direction, start line, pit lane.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameTrack, buildGame, toLatLon, projector, chainWays, nearestOnLoop, loopLength, signedArea, resampleLoop, r1, r2 } from './core.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));

export const LAYOUT = {
  // relation 284538 "Bahrain Grand Prix Circuit" (type=circuit) = ways 4818385, 881756729, 881756728 (all oneway=yes)
  'bh-2002': { rel: 284538, pitWays: [187123422] },
};

export function layoutAudit(id, cfg) {
  const osm = JSON.parse(readFileSync(resolve(HERE, '..', 'cache', 'overpass', id + '.json'), 'utf8'));
  const els = osm.elements;
  let wayIds = cfg.ways;
  if (!wayIds) { const rel = els.find((e) => e.type === 'relation' && e.id === cfg.rel); wayIds = rel.members.filter((m) => m.type === 'way').map((m) => m.ref); }
  const chain = chainWays(els, wayIds);
  const td = gameTrack(id), g = td.geo;
  const pr = projector(g.lat0, g.lon0);
  const O = chain.ll.map(([la, lo]) => pr.f(la, lo));            // OSM loop, true metres
  const D = td.points.map(([x, z]) => pr.f(...toLatLon(g, x, z))); // dataset points, true metres
  const tr = buildGame(td);
  const S = tr.samples.map((q) => pr.f(...toLatLon(g, q.x, q.z)));  // game samples, true metres
  const osmLen = loopLength(O), dataLen = loopLength(D), sampLen = loopLength(S);
  // align OSM's start with the game's start: s of the OSM foot of game points[0]
  const f0 = nearestOnLoop(O, D[0][0], D[0][1]);
  const osmS = (p) => { const q = nearestOnLoop(O, p[0], p[1], f0.cum); return { d: q.d, s: ((q.s - f0.s) % osmLen + osmLen) % osmLen }; };
  // game samples -> OSM
  const dev = S.map((p, i) => ({ i, s: tr.samples[i].s, d: nearestOnLoop(O, p[0], p[1], f0.cum).d }));
  const sorted = dev.map((q) => q.d).sort((a, b) => a - b), mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const worst = dev.reduce((a, b) => (b.d > a.d ? b : a));
  // runs of samples further than 5 m from OSM
  const runs = []; let cur = null;
  dev.forEach((q) => { if (q.d > 5) { if (!cur) cur = { from: q.s, to: q.s, max: q.d, at: q.s }; cur.to = q.s; if (q.d > cur.max) { cur.max = q.d; cur.at = q.s; } } else if (cur) { runs.push(cur); cur = null; } });
  if (cur) runs.push(cur);
  // OSM vertices -> game samples (a section missing from the game shows here)
  const OR = resampleLoop(O, 5);
  const back = OR.pts.map((p) => nearestOnLoop(S, p[0], p[1]).d), backMax = Math.max(...back);
  // direction: tangent agreement (game sample i vs OSM at its foot)
  let agree = 0;
  for (let i = 0; i < S.length; i += 10) {
    const a = S[i], b = S[(i + 1) % S.length], q = nearestOnLoop(O, a[0], a[1], f0.cum), o0 = O[q.i], o1 = O[(q.i + 1) % O.length];
    agree += Math.sign((b[0] - a[0]) * (o1[0] - o0[0]) + (b[1] - a[1]) * (o1[1] - o0[1]));
  }
  const gameCW = signedArea(D) < 0, osmCW = signedArea(O) < 0;  // x east, y north: negative area = clockwise
  // pit lane ways
  let pit = null;
  if (cfg.pitWays && cfg.pitWays.length) {
    const pw = cfg.pitWays.map((wid) => els.find((e) => e.type === 'way' && e.id === wid));
    const pll = pw.flatMap((w) => w.geometry.map((q) => [q.lat, q.lon]));
    const P = pll.map(([la, lo]) => pr.f(la, lo));
    // where the pit lane leaves / rejoins: first / last pit vertex, projected on the OSM loop (s from the game start)
    const a = osmS(P[0]), b = osmS(P[P.length - 1]);
    // side: lateral sign of the lane's middle relative to the OSM racing direction (+ = left)
    const mid = P[Math.floor(P.length / 2)], mq = nearestOnLoop(O, mid[0], mid[1], f0.cum), o0 = O[mq.i], o1 = O[(mq.i + 1) % O.length];
    const cross = (o1[0] - o0[0]) * (mid[1] - o0[1]) - (o1[1] - o0[1]) * (mid[0] - o0[0]);
    pit = { osmWays: cfg.pitWays, entryLL: pll[0], exitLL: pll[pll.length - 1], entryS: Math.round(a.s), entryOff: r1(a.d), exitS: Math.round(b.s), exitOff: r1(b.d),
      side: cross > 0 ? '+1 (left)' : '-1 (right)', laneLen: Math.round(loopLength(P) - Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1])), midOffset: r1(mq.d) };
  }
  const gp = tr.pit;
  const gamePit = gp ? { side: gp.side > 0 ? '+1 (left)' : '-1 (right)', limitKmh: gp.limitKmh, fromS: Math.round(tr.samples[gp.from].s), entryLineS: Math.round(tr.samples[gp.entry].s),
    exitLineS: Math.round(tr.samples[gp.exit].s), toS: Math.round(tr.samples[gp.to].s), length: Math.round(gp.length) } : null;
  return {
    osm: { relation: cfg.rel || null, ways: chain.wayOrder, nodes: chain.nodes.length, lengthM: Math.round(osmLen) },
    lengths: { gameKm: td.lengthKm, datasetPolylineTrueM: Math.round(dataLen), samplesTrueM: Math.round(sampLen), geoScale: r2(g.kx / (111320 * Math.cos(g.lat0 * Math.PI / 180)) * 1000) / 1000, osmM: Math.round(osmLen) },
    deviation: { maxM: r1(worst.d), maxAtS: Math.round(worst.s), maxAtLL: pr.inv(...S[worst.i]).map((v) => +v.toFixed(6)), meanM: r1(mean), p95M: r1(sorted[Math.floor(sorted.length * 0.95)]),
      over5m: runs.map((r) => ({ fromS: Math.round(r.from), toS: Math.round(r.to), maxM: r1(r.max), atS: Math.round(r.at) })), osmToGameMaxM: r1(backMax) },
    direction: { tangentAgreement: agree, gameClockwise: gameCW, osmClockwise: osmCW },
    start: { gamePoint0LL: toLatLon(g, td.points[0][0], td.points[0][1]).map((v) => +v.toFixed(6)), offOsmM: r1(f0.d) },
    pit, gamePit, corners: corners(tr), _td: td, _O: O, _S: S, _tr: tr, _pr: pr, _f0: f0, _osmS: osmS, _chain: chain,
  };
}

// corners of the game track: runs where the radius (js/track.js samples, curvature from the tangents) is below 300 m;
// apex = smallest radius; bank = js/track.js bank there (deg, + = the car's left side up).
export function corners(tr) {
  const S = tr.samples, N = S.length, ds = tr.length / N, k = 3, out = [];
  const curv = S.map((q, i) => { const a = S[(i - k + N) % N], b = S[(i + k) % N]; const da = Math.atan2(b.tz, b.tx) - Math.atan2(a.tz, a.tx); return Math.atan2(Math.sin(da), Math.cos(da)) / (2 * k * ds); });
  let cur = null;
  for (let i = 0; i <= N; i++) {
    const c = curv[i % N], on = Math.abs(c) > 1 / 300 && (!cur || Math.sign(c) === cur.sign);
    if (on) { if (!cur) cur = { i0: i, sign: Math.sign(c), best: i, turn: 0 }; if (Math.abs(c) > Math.abs(curv[cur.best % N])) cur.best = i; cur.turn += c * ds; cur.i1 = i; }
    else { if (cur && Math.abs(cur.turn) > 0.35) out.push(cur); cur = Math.abs(c) > 1 / 300 ? { i0: i, sign: Math.sign(c), best: i, turn: c * ds, i1: i } : null; }
  }
  // x east, z = -north: a left turn (anticlockwise seen from above, north up) has d(heading in x,z)/ds < 0
  return out.map((c) => { const b = c.best % N; return { fromS: Math.round(S[c.i0 % N].s), apexS: Math.round(S[b].s), toS: Math.round(S[c.i1 % N].s),
    dir: c.sign < 0 ? 'L' : 'R', turnDeg: Math.round(Math.abs(c.turn) * 180 / Math.PI), minRadiusM: Math.round(1 / Math.abs(curv[b])),
    gameBankDeg: Math.round(S[b].bank * 1800 / Math.PI) / 10 }; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  const r = layoutAudit(id, LAYOUT[id]);
  for (const k of Object.keys(r)) if (!k.startsWith('_')) console.log(k, JSON.stringify(r[k]));
}
