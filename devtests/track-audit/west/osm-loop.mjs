// OSM reference centreline of a circuit: the member ways of a circuit relation (cached Overpass "out geom" answer),
// minus the pit lane / penalty / joker roles, chained into a closed loop by endpoint matching, oriented in the game's
// racing direction and started at the point nearest the game's start line.
// node devtests/track-audit/west/osm-loop.mjs <id> <overpass-cache-name> <relationId> [extra way ids to add, comma-separated] [way ids to drop]
// writes devtests/track-audit/west/res/osm-loop-<id>.json {relation, ways, loop: [[lat, lon]], length}
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';
import { loadGame, gameArrays, loadOverpass, r, cumLen, nearestOn } from './lib-audit.mjs';
import { chainWays } from './geo.mjs';

export function buildLoop(idArg, cacheName, relId, extra = [], drop = [], extraCache = null) {
  const id = idArg.split(':')[0], label = idArg.replace(':', '-');
  const g = loadGame(id), A = gameArrays(g), J = loadOverpass(cacheName);
  const rel = J.elements.find((e) => e.type === 'relation' && String(e.id) === String(relId));
  if (!rel) throw new Error('relation not in cache');
  const SKIP = new Set(['pit_lane', 'penalty', 'joker_lap', 'start', 'finish', 'start-finish']);
  let ways = rel.members.filter((m) => m.type === 'way' && !SKIP.has(m.role) && !drop.includes(String(m.ref)) && m.geometry)
    .map((m) => ({ id: m.ref, geom: m.geometry.map((p) => [p.lat, p.lon]) }));
  if (extra.length) {
    const X = loadOverpass(extraCache || cacheName);
    for (const wid of extra) {
      const e = X.elements.find((q) => q.type === 'way' && String(q.id) === String(wid));
      if (e) ways.push({ id: e.id, geom: e.geometry.map((p) => [p.lat, p.lon]) });
      else console.warn('extra way not found', wid);
    }
  }
  // closed single-way loops (first == last vertex) are taken as they are
  let loopXY, seq, gap;
  if (ways.length === 1) {
    loopXY = ways[0].geom.map(([la, lo]) => A.proj.to(la, lo));
    gap = Math.hypot(loopXY[0][0] - loopXY[loopXY.length - 1][0], loopXY[0][1] - loopXY[loopXY.length - 1][1]);
    if (gap < 0.5) loopXY.pop();
    seq = [{ i: 0, rev: false }];
  } else {
    let ch = null;
    try { ch = chainWays(ways.map((w) => w.geom), A.proj, 3); } catch (e) { ch = null; }
    if (ch && ch.closingGap < 3) { loopXY = ch.loop; seq = ch.seq; gap = ch.closingGap; seq.gaps = ['chained']; } else {
    // order the ways along the game's lap (only the ORDER comes from the game: each way's vertices are projected on
    // the game centreline, the way is oriented so its s increases, and the ways are sorted by their start s); the
    // geometry is OSM's own. Gaps between consecutive ways are reported.
    const near = (x, y) => { let b = Infinity, bi = 0; for (let i = 0; i < A.N; i++) { const d = (A.xy[i][0] - x) ** 2 + (A.xy[i][1] - y) ** 2; if (d < b) { b = d; bi = i; } } return A.s[bi]; };
    const L = A.L;
    const items = ways.map((w, wi) => {
      const xy = w.geom.map(([la, lo]) => A.proj.to(la, lo));
      const s0 = near(...xy[0]), s1 = near(...xy[xy.length - 1]);
      const fwd = ((s1 - s0 + L) % L) < L / 2;
      const pts = fwd ? xy : xy.slice().reverse();
      return { wi, pts, start: fwd ? s0 : s1 };
    });
    // the way that contains s = 0 (wraps) goes first only if it starts before the line: sort by start s
    items.sort((a, b) => a.start - b.start);
    loopXY = []; seq = []; const gaps = [];
    for (const it of items) {
      if (loopXY.length) { const e = loopXY[loopXY.length - 1], f = it.pts[0]; const d = Math.hypot(f[0] - e[0], f[1] - e[1]); gaps.push(r(d, 1)); }
      const pts = loopXY.length && Math.hypot(it.pts[0][0] - loopXY[loopXY.length - 1][0], it.pts[0][1] - loopXY[loopXY.length - 1][1]) < 0.5 ? it.pts.slice(1) : it.pts;
      loopXY = loopXY.concat(pts); seq.push({ i: it.wi, rev: false });
    }
    gap = Math.hypot(loopXY[0][0] - loopXY[loopXY.length - 1][0], loopXY[0][1] - loopXY[loopXY.length - 1][1]);
    if (gap < 0.5) loopXY.pop();
    seq.gaps = gaps;
  }}
  // orientation: compare with the game's direction (signed area)
  const area = (P) => P.reduce((a, p, i) => { const q = P[(i + 1) % P.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  const gArea = area(A.xy), oArea = area(loopXY);
  if (Math.sign(gArea) !== Math.sign(oArea)) loopXY.reverse();
  // start at the vertex nearest the game's points[0] (inserting the foot point)
  const c = cumLen(loopXY, true), q = nearestOn(loopXY, c, A.xy[0][0], A.xy[0][1], true);
  const n = loopXY.length, k = q.seg + 1;
  loopXY = [[q.x, q.y]].concat(loopXY.slice(k), loopXY.slice(0, k));
  const len = cumLen(loopXY, true);
  const out = { id, relation: relId, ways: seq.map((s) => ways[s.i].id), joinGapsM: seq.gaps || [], maxJoinGapM: Math.max(0, ...(seq.gaps || []).filter(Number.isFinite)),
    closingGapM: r(gap, 2), gameArea: r(gArea, 0), osmArea: r(oArea, 0),
    reversed: Math.sign(gArea) !== Math.sign(oArea), length: r(len[len.length - 1], 1), startFootDistM: r(q.d, 1),
    loop: loopXY.map(([x, y]) => A.proj.from(x, y).map((v) => +v.toFixed(7))) };
  writeFileSync(resolve(HERE, 'res', 'osm-loop-' + label + '.json'), JSON.stringify(out));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('osm-loop.mjs')) {
  const [id, cacheName, relId, extra = '', drop = '', extraCache = ''] = process.argv.slice(2);
  const o = buildLoop(id, cacheName, relId, extra ? extra.split(',') : [], drop ? drop.split(',') : [], extraCache || null);
  const { loop, ...b } = o;
  console.log(JSON.stringify(b), 'vertices', loop.length);
}
