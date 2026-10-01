// node devtests/track-audit/eu-south-central/layout.mjs [ids]
// Layout / length / direction / start line / pit lane / bridges+tunnels of the game centreline against OpenStreetMap
// (the circuit relation's F1 ways) and the MultiViewer circuit data (F1 live-timing positions of a real lap: outline,
// corner numbers and positions). Writes out/layout-<id>.json and prints a summary.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, CACHE, loadGame, loadOSM, gameLine, osmLayout, proj, MV, wrap, sdiff, segIndex } from './lib.mjs';

const IDS = (process.argv[2] || 'it-1922,it-1953,it-1914,at-1969,hu-1986').split(',');

function zones(arr, pred, total, minLen = 0) {     // contiguous runs (by sample) where pred holds -> [{from, to, max}]
  const out = []; let cur = null;
  for (const a of arr) {
    if (pred(a)) { if (!cur) cur = { from: a.s, to: a.s, max: a.v, at: a.s }; cur.to = a.s; if (a.v > cur.max) { cur.max = a.v; cur.at = a.s; } }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  if (out.length > 1 && out[0].from === arr[0].s && out[out.length - 1].to === arr[arr.length - 1].s) {   // wrap-around
    const l = out.pop(); out[0].from = l.from; if (l.max > out[0].max) { out[0].max = l.max; out[0].at = l.at; }
  }
  return out.filter((z) => wrap(z.to - z.from, total) >= minLen);
}

// Umeyama similarity fit: dst ~ s R src + t (2D), optional reflection allowed
function simFit(src, dst, allowReflect) {
  const n = src.length; let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let a = 0, b = 0, c = 0, d = 0, vs = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - nx, v = dst[i][1] - ny;
    a += u * x; b += u * y; c += v * x; d += v * y; vs += x * x + y * y;
  }
  // rotation (proper) maximising trace(R^T M), M = [[a b],[c d]]
  const th = Math.atan2(c - b, a + d), tr = Math.cos(th) * (a + d) + Math.sin(th) * (c - b);
  let R = [[Math.cos(th), -Math.sin(th)], [Math.sin(th), Math.cos(th)]], best = tr;
  if (allowReflect) {
    const th2 = Math.atan2(c + b, a - d), tr2 = Math.cos(th2) * (a - d) + Math.sin(th2) * (b + c);
    if (tr2 > best) { best = tr2; R = [[Math.cos(th2), Math.sin(th2)], [Math.sin(th2), -Math.cos(th2)]]; }
  }
  const s = best / vs;
  const t = [nx - s * (R[0][0] * mx + R[0][1] * my), ny - s * (R[1][0] * mx + R[1][1] * my)];
  return (p) => [s * (R[0][0] * p[0] + R[0][1] * p[1]) + t[0], s * (R[1][0] * p[0] + R[1][1] * p[1]) + t[1]];
}

function mvFit(id, gl) {
  const f = resolve(CACHE, 'multiviewer', MV[id] + '.json');
  if (!MV[id] || !existsSync(f)) return null;
  const mv = JSON.parse(readFileSync(f, 'utf8'));
  const src = mv.x.map((x, i) => [x / 10, mv.y[i] / 10]);
  let cx = 0, cy = 0; src.forEach((p) => { cx += p[0]; cy += p[1]; }); cx /= src.length; cy /= src.length;
  let gx = 0, gy = 0; gl.P.forEach((p) => { gx += p[0]; gy += p[1]; }); gx /= gl.P.length; gy /= gl.P.length;
  const sub = src.filter((_, i) => i % 3 === 0);
  let best = null;
  for (const mir of [1, -1]) for (let deg = 0; deg < 360; deg += 2) {
    const r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const T = (p) => { const x = (p[0] - cx) * mir, y = p[1] - cy; return [gx + cs * x - sn * y, gy + sn * x + cs * y]; };
    let e = 0; for (const p of sub) { const q = T(p); e += Math.min(gl.idx.near(q[0], q[1], 200).d, 200); }
    if (!best || e < best.e) best = { e, T };
  }
  let T = best.T;
  for (let it = 0; it < 30; it++) {
    const pairs = src.map((p) => { const q = T(p), r = gl.idx.near(q[0], q[1], 300); return [p, [r.px, r.py], r.d]; });
    const ds = pairs.map((q) => q[2]).sort((a, b) => a - b), cut = Math.max(5, ds[Math.floor(ds.length * 0.9)]);
    const use = pairs.filter((q) => q[2] <= cut);
    T = simFit(use.map((q) => q[0]), use.map((q) => q[1]), true);
  }
  const res = src.map((p) => { const q = T(p); return gl.idx.near(q[0], q[1], 300).d; }).sort((a, b) => a - b);
  const q0 = T(src[0]), s0 = gl.sAt(q0[0], q0[1]);
  let mvLen = 0; for (let i = 1; i < src.length; i++) { const a = T(src[i - 1]), b = T(src[i]); mvLen += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  const corners = mv.corners.map((c) => {
    const q = T([c.trackPosition.x / 10, c.trackPosition.y / 10]), r = gl.sAt(q[0], q[1]);
    return { number: c.number, letter: c.letter || '', mvLengthM: +(c.length / 10).toFixed(1), gameS: +r.s.toFixed(1), d: +r.d.toFixed(1),
      gameSfromMvStart: +wrap(r.s - s0.s, gl.total).toFixed(1) };
  });
  return {
    source: `https://api.multiviewer.app/api/v1/circuits/${mv.circuitKey}/${MV[id].split('-')[1]} (F1 live-timing positions; data year ${mv.year}, candidate lap ${JSON.stringify(mv.candidateLap || {}).slice(0, 160)})`,
    year: mv.year, fitResidual: { median: +res[Math.floor(res.length / 2)].toFixed(1), p90: +res[Math.floor(res.length * 0.9)].toFixed(1), max: +res[res.length - 1].toFixed(1) },
    firstPointGameS: +s0.s.toFixed(1), firstPointD: +s0.d.toFixed(1), outlineLengthM: +mvLen.toFixed(0), corners,
  };
}

function segInter(a, b, c, d) {     // segment ab vs cd -> t on ab or null
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

for (const id of IDS) {
  const game = loadGame(id), osm = loadOSM(id), gl = gameLine(id, game), lay = osmLayout(id, osm), p = proj(id);
  const total = gl.total;
  // game -> OSM layout distance per sample
  const g2o = gl.P.map((q, i) => ({ s: gl.S[i].s, v: lay.idx.near(q[0], q[1], 500).d }));
  const vals = g2o.map((a) => a.v).sort((a, b) => a - b);
  const g2oStats = { mean: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2), median: +vals[vals.length >> 1].toFixed(2),
    p95: +vals[Math.floor(vals.length * 0.95)].toFixed(2), max: +vals[vals.length - 1].toFixed(2),
    maxAt: g2o.reduce((m, a) => (a.v > m.v ? a : m)).s };
  const g2oZones = zones(g2o, (a) => a.v > 5, total).map((z) => ({ from: +z.from.toFixed(0), to: +z.to.toFixed(0), maxM: +z.max.toFixed(1), at: +z.at.toFixed(0) }));
  // OSM layout -> game distance (every ~2 m along the ways)
  const o2g = [];
  for (const sgm of lay.segs) {
    const L = Math.hypot(sgm[2] - sgm[0], sgm[3] - sgm[1]), k = Math.max(1, Math.ceil(L / 2));
    for (let j = 0; j < k; j++) {
      const t = j / k, x = sgm[0] + (sgm[2] - sgm[0]) * t, y = sgm[1] + (sgm[3] - sgm[1]) * t, r = gl.sAt(x, y);
      o2g.push({ d: r.d, s: r.s, way: sgm[4] });
    }
  }
  o2g.sort((a, b) => b.d - a.d);
  const o2gMax = o2g[0], farOSM = o2g.filter((a) => a.d > 5);
  // direction: each OSM way's travel direction vs the game's
  const dir = lay.members.filter((w) => w.P).map((w) => {
    let agree = 0, tot = 0;
    for (let i = 0; i + 1 < w.P.length; i++) {
      const a = w.P[i], b = w.P[i + 1], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], r = gl.sAt(m[0], m[1]);
      const g0 = gl.P[r.i], g1 = gl.P[(r.i + 1) % gl.N], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const dot = (b[0] - a[0]) * (g1[0] - g0[0]) + (b[1] - a[1]) * (g1[1] - g0[1]);
      if (dot > 0) agree += L; tot += L;
    }
    return { id: w.id, name: w.name, oneway: w.tags.oneway || null, agreeFrac: tot ? agree / tot : null, len: w.len };
  });
  const onewayAgree = dir.filter((d) => d.oneway === 'yes').reduce((a, d) => a + d.agreeFrac * d.len, 0) /
    Math.max(1, dir.filter((d) => d.oneway === 'yes').reduce((a, d) => a + d.len, 0));
  // named corners (OSM way names / refs) -> s ranges on the game line
  const corners = lay.members.filter((w) => w.P && (w.name || w.ref)).map((w) => {
    const a = gl.sAt(...w.P[0]), b = gl.sAt(...w.P[w.P.length - 1]), mid = gl.sAt(...w.P[w.P.length >> 1]);
    return { name: w.name, ref: w.ref, from: +a.s.toFixed(0), to: +b.s.toFixed(0), mid: +mid.s.toFixed(0) };
  }).sort((x, y) => x.mid - y.mid);
  // start / finish: OSM nodes (relation roles start / finish, raceway=* nodes, names)
  const nodesById = new Map(osm.elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const sf = [];
  for (const m of lay.rel.members.filter((m) => m.type === 'node')) {
    let nd = nodesById.get(m.ref);
    const f = resolve(CACHE, 'osmapi', `node-${m.ref}.json`);
    if (!nd && existsSync(f)) nd = JSON.parse(readFileSync(f, 'utf8')).elements[0];
    if (nd) sf.push({ id: nd.id, role: m.role, lat: nd.lat, lon: nd.lon, tags: nd.tags || {} });
  }
  for (const nd of osm.elements.filter((e) => e.type === 'node' && e.tags && (e.tags.raceway || /start|finish/i.test(e.tags.name || ''))))
    if (!sf.some((q) => q.id === nd.id)) sf.push({ id: nd.id, role: null, lat: nd.lat, lon: nd.lon, tags: nd.tags });
  for (const q of sf) { const r = gl.sAt(...p.to(q.lat, q.lon)); q.gameS = +r.s.toFixed(1); q.d = +r.d.toFixed(1); q.offsetFromGameLineM = +sdiff(r.s, 0, total).toFixed(1); }
  // pit lane(s): OSM pit ways of the relation (+ named pit raceways) vs track.pit
  const pitWays = lay.pit.length ? lay.pit : osm.elements.filter((e) => e.type === 'way' && /pit|box/i.test((e.tags && (e.tags.name + ' ' + (e.tags['name:en'] || ''))) || '') && e.tags.highway === 'raceway');
  const pits = pitWays.map((w) => {
    const P = w.geometry.map((g) => p.to(g.lat, g.lon));
    const a = gl.sAt(...P[0]), b = gl.sAt(...P[P.length - 1]);
    // side: signed distance of the middle third of the lane to the left normal of the track
    let sum = 0, cnt = 0, len = 0, maxOff = 0;
    for (let i = 0; i + 1 < P.length; i++) len += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    for (let i = Math.floor(P.length / 3); i < Math.ceil(2 * P.length / 3); i++) {
      const r = gl.sAt(...P[i]), g0 = gl.P[r.i], g1 = gl.P[(r.i + 1) % gl.N];
      const tx = g1[0] - g0[0], ty = g1[1] - g0[1], tl = Math.hypot(tx, ty), nx = -ty / tl, ny = tx / tl;   // left normal
      const off = (P[i][0] - r.px) * nx + (P[i][1] - r.py) * ny; sum += Math.sign(off); cnt++; maxOff = Math.max(maxOff, Math.abs(off));
    }
    return { id: w.id, name: w.tags.name || null, maxspeed: w.tags.maxspeed || null, lengthM: +len.toFixed(0),
      entryGameS: +a.s.toFixed(0), entryD: +a.d.toFixed(1), exitGameS: +b.s.toFixed(0), exitD: +b.d.toFixed(1),
      entryBeforeLineM: +(-sdiff(a.s, 0, total)).toFixed(0), exitAfterLineM: +sdiff(b.s, 0, total).toFixed(0),
      side: sum > 0 ? 1 : -1, sideWord: sum > 0 ? 'left of the racing direction' : 'right of the racing direction', laneOffsetM: +maxOff.toFixed(1) };
  });
  const gp = game.pit;
  const gamePit = gp ? { side: gp.side, sideWord: gp.side > 0 ? 'left' : 'right', limitKmh: gp.limitKmh, laneLengthM: +gp.length.toFixed(0),
    entryGameS: +gp.entryS.toFixed(0), exitGameS: +gp.exitS.toFixed(0), fromS: +gp.fromS.toFixed(0), toS: +gp.toS.toFixed(0),
    entryBeforeLineM: +(-sdiff(gp.entryS, 0, total)).toFixed(0), exitAfterLineM: +sdiff(gp.exitS, 0, total).toFixed(0) } : null;
  // bridges / tunnels / covered: layout ways carrying such tags, and other ways crossing the game line
  const covers = [];
  for (const w of lay.members.filter((w) => w.P && (w.tags.bridge || w.tags.tunnel || w.tags.covered)))
    covers.push({ kind: 'layout way', id: w.id, tags: w.tags, from: +gl.sAt(...w.P[0]).s.toFixed(0), to: +gl.sAt(...w.P[w.P.length - 1]).s.toFixed(0) });
  const layIds = new Set(lay.members.map((w) => w.id));
  for (const e of osm.elements.filter((e) => e.type === 'way' && !layIds.has(e.id) && e.geometry && e.tags && (e.tags.bridge || e.tags.tunnel || e.tags.covered || e.tags.man_made === 'bridge'))) {
    const P = e.geometry.map((g) => p.to(g.lat, g.lon));
    for (let i = 0; i + 1 < P.length; i++) for (let k = 0; k < gl.N; k++) {
      const g0 = gl.P[k], g1 = gl.P[(k + 1) % gl.N];
      if (Math.max(P[i][0], P[i + 1][0]) < Math.min(g0[0], g1[0]) - 1 || Math.min(P[i][0], P[i + 1][0]) > Math.max(g0[0], g1[0]) + 1) continue;
      const t = segInter(P[i], P[i + 1], g0, g1);
      if (t !== null) covers.push({ kind: 'crossing', id: e.id, tags: e.tags, gameS: +gl.S[k].s.toFixed(0) });
    }
  }
  const mv = mvFit(id, gl);
  const out = {
    id, name: game.name, osmSource: osm._file, osmRelation: lay.rel.id, osmLayoutWays: lay.members.length, osmLayoutLoopOK: lay.loopOK,
    lengths: { gameDatasetKm: game.lengthKm, gameBuiltM: +total.toFixed(0), osmLayoutM: +lay.length.toFixed(0) },
    gameToOsm: g2oStats, gameOffOsmZones: g2oZones,
    osmToGameMax: { d: +o2gMax.d.toFixed(1), gameS: +o2gMax.s.toFixed(0), way: o2gMax.way }, osmFarFromGameM: farOSM.length * 2,
    direction: { onewayLengthAgreeingFrac: +onewayAgree.toFixed(3), ways: dir.map((d) => ({ ...d, agreeFrac: d.agreeFrac === null ? null : +d.agreeFrac.toFixed(2), len: +d.len.toFixed(0) })) },
    corners, startFinish: sf, pitOSM: pits, pitGame: gamePit, coveredAndCrossings: covers, multiviewer: mv,
  };
  writeFileSync(resolve(HERE, 'out', `layout-${id}.json`), JSON.stringify(out, null, 1));
  console.log(`\n== ${id} ${game.name}: game ${total.toFixed(0)} m, OSM layout ${lay.length.toFixed(0)} m (loop ${lay.loopOK}), ` +
    `game->OSM mean ${g2oStats.mean} p95 ${g2oStats.p95} max ${g2oStats.max} m @s ${g2oStats.maxAt.toFixed(0)}; OSM->game max ${o2gMax.d.toFixed(1)} m @s ${o2gMax.s.toFixed(0)} (way ${o2gMax.way}), OSM >5 m off: ${farOSM.length * 2} m; oneway agree ${onewayAgree.toFixed(3)}`);
  if (g2oZones.length) console.log('  game off OSM >5 m:', JSON.stringify(g2oZones));
  console.log('  S/F:', JSON.stringify(sf.map((q) => ({ role: q.role, tags: q.tags, s: q.gameS, d: q.d, off: q.offsetFromGameLineM }))));
  console.log('  pit OSM:', JSON.stringify(pits));
  console.log('  pit game:', JSON.stringify(gamePit));
  console.log('  covered/crossings:', JSON.stringify(covers.map((c) => ({ k: c.kind, id: c.id, s: c.gameS ?? c.from + '-' + c.to, t: Object.fromEntries(Object.entries(c.tags).filter(([k]) => /bridge|tunnel|covered|highway|name|layer|building/.test(k))) }))));
  if (mv) console.log('  MV:', JSON.stringify({ res: mv.fitResidual, x0s: mv.firstPointGameS, x0d: mv.firstPointD, len: mv.outlineLengthM, corners: mv.corners.map((c) => `${c.number}${c.letter}: mv ${c.mvLengthM} game ${c.gameS} (from mv0 ${c.gameSfromMvStart}) d ${c.d}`) }));
  console.log('  corners:', corners.map((c) => `${c.ref || ''}${c.name ? ' ' + c.name : ''} ${c.from}-${c.to}`).join(' | '));
}
