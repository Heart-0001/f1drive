// node devtests/track-audit/east/osm-compare.mjs <id> [--exclude wayId,...] [--include wayId,...]
// Compares the game centreline (out/game-<id>.json: tracks-data points, original lat/lon) with the OpenStreetMap
// raceway ways (ODbL) cached by osm.mjs (../cache/overpass/east-<id>.json). Everything in TRUE metres (local
// equirectangular projection), not the game's length-rescaled frame; game s (the game's own metres) given beside.
//   coverage   each raceway way: share of its length within 12 m of the game line -> "used" (>= 0.5) or other layouts
//   deviation  game sample -> nearest used way: mean / p95 / max, stretches > 8 m
//   osm loop   the used ways ordered along the game line and oriented in its direction, joined -> OSM lap length,
//              gaps between consecutive ways (should be 0: shared nodes)
//   direction  oneway=yes ways: drawing direction against the game's direction
//   pit        pit-lane ways: where they leave / rejoin (projected ends), side (left / right of the driver)
//   start      nodes tagged raceway=* / named start / finish, projected onto the game line
//   crossings  bridges / tunnels (any highway) crossing the game line; raceway ways tagged bridge / tunnel / covered
// Writes out/osm-<id>.json (the OSM loop included, for the DEM sampling).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EAST, game, projector, cumLoop, nearestOnLoop, signedArea, loopLength, r1, r2 } from './core.mjs';

export function osmCompare(id, opts = {}) {
  const G = game(id), S = G.samples, N = S.length;
  const osm = JSON.parse(readFileSync(resolve(EAST, '..', 'cache', 'overpass', `east-${opts.osm || id}.json`), 'utf8'));
  const pr = projector(G.geo.lat0, G.geo.lon0);
  const GP = S.map((q) => pr.f(q.lat, q.lon)), gcum = cumLoop(GP), LEN = gcum[N];
  const gameS = (trueS) => { // true metres along the game line -> the game's own s
    let i = 0; while (i < N - 1 && gcum[i + 1] < trueS) i++;
    const t = (trueS - gcum[i]) / ((gcum[i + 1] - gcum[i]) || 1); return S[i].s + t * (G.builtLength / N);
  };
  const onGame = (p) => { const q = nearestOnLoop(GP, p[0], p[1], gcum); return { d: r1(q.d), trueS: Math.round(q.s), gameS: Math.round(gameS(q.s)), side: q.side > 0 ? 'left' : 'right' }; };
  const els = osm.elements;
  const isPit0 = (t) => /pit|box|stands/i.test(t.name || '') || t.service === 'driveway' || /pit/i.test(t.raceway || '') || /pit/i.test(t.service || '') || t.pit_lane === 'yes';
  // opts.rel: a cached Overpass answer 'rel(id); out body; way(r); out body geom;' -> the relation's member ways are the track
  const REL = opts.rel ? JSON.parse(readFileSync(resolve(EAST, '..', 'cache', 'overpass', 'east-' + opts.rel + '.json'), 'utf8')) : null;
  const relRole = {}; if (REL) for (const r of REL.elements.filter((e) => e.type === 'relation')) for (const m of r.members) if (m.type === 'way') relRole[m.ref] = m.role || 'track';
  const ways = (REL ? REL.elements.filter((e) => e.type === 'way' && e.geometry && relRole[e.id] && !(e.tags || {}).footway) : els.filter((e) => e.type === 'way' && e.geometry && (e.tags || {}).highway === 'raceway' && !/kart|motocross/i.test(e.tags.sport || '') && e.tags.area !== 'yes'))
    .map((w) => {
      const P = w.geometry.map((q) => pr.f(q.lat, q.lon));
      return { id: w.id, role: relRole[w.id], tags: w.tags, nodes: w.nodes, P, len: P.reduce((a, p, i) => a + (i ? Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1]) : 0), 0) };
    });
  const isPit = (t, w) => (REL ? /pit/.test(relRole[w.id] || '') : isPit0(t));
  const pitWays = ways.filter((w) => isPit(w.tags, w) && !(opts.include || []).includes(w.id));
  const race = ways.filter((w) => !pitWays.includes(w));
  // coverage (densified every 2 m)
  for (const w of race) {
    let inside = 0, tot = 0, ss = [];
    for (let i = 0; i + 1 < w.P.length; i++) {
      const a = w.P[i], b = w.P[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(l / 2));
      for (let j = 0; j < k; j++) {
        const p = [a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k], q = nearestOnLoop(GP, p[0], p[1], gcum);
        tot += l / k; if (q.d <= 12) inside += l / k; ss.push(q.s);
      }
    }
    w.coverage = inside / (tot || 1);
    // orientation against the game direction: mean of the game-s steps along the way (unwrapped)
    let fwd = 0; for (let i = 1; i < ss.length; i++) { let d = ss[i] - ss[i - 1]; if (d > LEN / 2) d -= LEN; if (d < -LEN / 2) d += LEN; fwd += d; }
    w.forward = fwd >= 0;
    const st = nearestOnLoop(GP, ...(w.forward ? w.P[0] : w.P[w.P.length - 1]), gcum);
    w.startS = st.s;
  }
  const used = race.filter((w) => (opts.exclude || []).indexOf(w.id) < 0 && w.coverage >= (opts.minCov || 0.75));
  const other = race.filter((w) => used.indexOf(w) < 0);
  // deviation of the game line from the used ways
  const lines = used.map((w) => w.P);
  const dev = GP.map((p) => {
    let best = Infinity;
    for (const L of lines) for (let i = 0; i + 1 < L.length; i++) {
      const a = L[i], b = L[i + 1], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2)) : 0;
      best = Math.min(best, Math.hypot(a[0] + ex * t - p[0], a[1] + ey * t - p[1]));
    }
    return best;
  });
  const sorted = dev.slice().sort((a, b) => a - b), mean = dev.reduce((a, v) => a + v, 0) / N;
  const runs = [];
  for (let i = 0, a = -1; i <= N; i++) {
    const on = i < N && dev[i] > 8;
    if (on && a < 0) a = i;
    if (!on && a >= 0) {
      let mi = a; for (let k = a; k < i; k++) if (dev[k] > dev[mi]) mi = k;
      runs.push({ fromGameS: Math.round(S[a].s), toGameS: Math.round(S[i - 1].s), maxM: r1(dev[mi]), at: [S[mi].lat, S[mi].lon] });
      a = -1;
    }
  }
  // OSM loop: used ways in game order, oriented forward, joined
  const ord = used.slice().sort((a, b) => a.startS - b.startS);
  const loop = [], gaps = [];
  for (const w of ord) {
    const P = w.forward ? w.P : w.P.slice().reverse();
    if (loop.length) {
      const e = loop[loop.length - 1], gp = Math.hypot(P[0][0] - e[0], P[0][1] - e[1]);
      if (gp > 0.5) {
        // the next way branches off inside the previous one (a shared node before its end): cut the loop back to it
        let cut = -1; for (let k = loop.length - 1; k >= Math.max(0, loop.length - 60); k--) if (Math.hypot(loop[k][0] - P[0][0], loop[k][1] - P[0][1]) < 1) { cut = k; break; }
        if (cut >= 0) { gaps.push({ before: w.id, name: w.tags.name, m: r1(gp), trimmedBackM: r1(gp) }); loop.length = cut + 1; }
        else gaps.push({ before: w.id, name: w.tags.name, m: r1(gp) });
      }
    }
    for (let i = loop.length && Math.hypot(P[0][0] - loop[loop.length - 1][0], P[0][1] - loop[loop.length - 1][1]) < 0.5 ? 1 : 0; i < P.length; i++) loop.push(P[i]);
  }
  if (loop.length > 2 && Math.hypot(loop[0][0] - loop[loop.length - 1][0], loop[0][1] - loop[loop.length - 1][1]) < 0.5) loop.pop();
  else if (loop.length) gaps.push({ before: 'close', m: r1(Math.hypot(loop[0][0] - loop[loop.length - 1][0], loop[0][1] - loop[loop.length - 1][1])) });
  const osmLen = loopLength(loop);
  // start the OSM loop at the foot of the game's points[0]
  const f0 = nearestOnLoop(loop, GP[0][0], GP[0][1]);
  // direction (oneway ways)
  let agree = 0, against = 0;
  for (const w of used) if (w.tags.oneway === 'yes') { if (w.forward) agree += w.len; else against += w.len; }
  // pit lanes
  const pits = pitWays.map((w) => {
    const a = onGame(w.P[0]), b = onGame(w.P[w.P.length - 1]);
    let sideVotes = 0; for (const p of w.P) { const q = nearestOnLoop(GP, p[0], p[1], gcum); if (q.d > 3) sideVotes += q.side; }
    return { id: w.id, name: w.tags.name || null, tags: w.tags, lengthM: Math.round(w.len), first: a, last: b, side: sideVotes > 0 ? 'left' : 'right',
      firstLL: w.P[0] && pr.inv(...w.P[0]).map((v) => +v.toFixed(6)), lastLL: pr.inv(...w.P[w.P.length - 1]).map((v) => +v.toFixed(6)) };
  });
  // start / finish candidates
  const starts = els.filter((e) => e.type === 'node' && e.tags && (e.tags.raceway || /start|finish|meta|partida|chegada|largada/i.test(e.tags.name || '')))
    .map((e) => ({ id: e.id, tags: e.tags, ll: [e.lat, e.lon], on: onGame(pr.f(e.lat, e.lon)) }));
  // crossings: any bridge / tunnel way whose line crosses the game line; raceway ways with bridge / tunnel / covered
  const cross = [];
  const segX = (a, b, c, d) => { const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0]; if (!den) return null;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den; return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + r[0] * t, a[1] + r[1] * t] : null; };
  for (const e of els) {
    if (e.type !== 'way' || !e.geometry || !e.tags) continue;
    const t = e.tags; if (!(t.bridge || t.tunnel || t.covered === 'yes')) continue;
    const P = e.geometry.map((q) => pr.f(q.lat, q.lon));
    if (t.highway === 'raceway') {
      const q = onGame(P[Math.floor(P.length / 2)]);
      if (q.d < 25) cross.push({ id: e.id, kind: 'raceway itself ' + (t.bridge ? 'bridge=' + t.bridge : t.tunnel ? 'tunnel=' + t.tunnel : 'covered'), name: t.name, at: q, layer: t.layer });
      continue;
    }
    for (let i = 0; i + 1 < P.length; i++) for (let k = 0; k < N; k++) {
      const x = segX(P[i], P[i + 1], GP[k], GP[(k + 1) % N]);
      if (x) cross.push({ id: e.id, kind: (t.bridge ? 'bridge=' + t.bridge : 'tunnel=' + (t.tunnel || t.covered)) + ' ' + t.highway, name: t.name || null, layer: t.layer || null,
        at: { trueS: Math.round(gcum[k]), gameS: Math.round(S[k].s), ll: [S[k].lat, S[k].lon] } });
    }
  }
  const rel = els.filter((e) => e.type === 'relation').map((r) => ({ id: r.id, tags: r.tags, members: r.members.length }));
  return {
    id, osmBase: osm.osm3s && osm.osm3s.timestamp_osm_base, relations: rel,
    gameTrueLengthM: Math.round(LEN), gameLengthM: Math.round(G.builtLength), gameScale: r2(G.builtLength / LEN * 1000) / 1000,
    osmLoopLengthM: Math.round(osmLen), osmLoopGaps: gaps,
    deviation: { meanM: r1(mean), p95M: r1(sorted[Math.floor(N * 0.95)]), maxM: r1(sorted[N - 1]), over8m: runs },
    used: ord.map((w) => ({ id: w.id, name: w.tags.name || null, lengthM: Math.round(w.len), coverage: r2(w.coverage), forward: w.forward, startGameS: Math.round(gameS(w.startS)) })),
    other: other.map((w) => ({ id: w.id, name: w.tags.name || null, lengthM: Math.round(w.len), coverage: r2(w.coverage), nearGameS: Math.round(gameS(w.startS)) })),
    direction: { onewayAgreeM: Math.round(agree), onewayAgainstM: Math.round(against), gameSignedAreaM2: Math.round(signedArea(GP)), gameSense: signedArea(GP) > 0 ? 'anticlockwise' : 'clockwise' },
    pits, starts, crossings: cross,
    gamePit: G.pit, gameStart: [S[0].lat, S[0].lon],
    _loop: loop, _f0: f0, _pr: pr,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(EAST, 'osm-compare.mjs')) {
  const id = process.argv[2];
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1].split(',').map(Number) : []; };
  const ri = process.argv.indexOf('--rel');
  const o = osmCompare(id, { exclude: arg('--exclude'), include: arg('--include'), rel: ri > 0 ? process.argv[ri + 1] : null, osm: process.argv.indexOf('--osm') > 0 ? process.argv[process.argv.indexOf('--osm') + 1] : null });
  const { _loop, _f0, _pr, ...save } = o;
  save.osmLoopLL = _loop.map((p) => _pr.inv(p[0], p[1]).map((v) => +v.toFixed(7)));
  save.osmLoopStartTrueS = Math.round(_f0.s);
  writeFileSync(resolve(EAST, 'out', `osm-${id}.json`), JSON.stringify(save, null, 1));
  const { osmLoopLL, ...show } = save;
  console.log(JSON.stringify(show, null, 1));
}
