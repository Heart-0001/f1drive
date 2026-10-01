// node devtests/track-audit/americas/audit.mjs [ids...]
// Measurements for the americas circuits (us-2012, us-2023, us-2022, us-1909, us-1956, ca-1978), from
//   out/game-<id>.json            (americas/game.js: the game's own build of the circuit, read-only sources)
//   cache/overpass/<id>-*.json    (americas/osm-fetch.mjs: OpenStreetMap, ODbL)
//   USGS 3DEP 1 m lidar DEM (US) / NRCan HRDEM lidar DTM (Canada), sampled along the OpenStreetMap centreline (net.mjs)
//   tools/elevation-cache-usgs3dep.json (read-only: the raw heights the game's build used, along the dataset centreline)
// and writes out/audit-<id>.json: layout deviation, start line, pit lane, elevation profile game vs lidar, grades over 50 /
// 100 m, real cross-slope (banking) from the lidar at +-4 m, bridges / tunnels crossing the line.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { HERE, ROOT, CACHE, usgs3dep, hrdem } from './net.mjs';
import { frame, segIndex, foot, segX, at, median, medianLoop, grades, r1, r2, r3 } from './geo.mjs';

const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['us-2012', 'us-2023', 'us-2022', 'us-1909', 'us-1956', 'ca-1978'];
const STEP = 10;          // m, profile step
const HALF = 4;           // m, cross-slope half width
const D = 180 / Math.PI;
const readJ = (f) => JSON.parse(readFileSync(f, 'utf8'));
const ovp = (name) => { const f = resolve(CACHE, 'overpass', name + '.json'); return existsSync(f) ? readJ(f) : null; };

// Which OpenStreetMap ways make the reference line (the F1 layout's road):
//   raceway ways (minus pit lanes, karting) everywhere; on street circuits also the public roads the track uses.
const isPit = (t) => /pit|puits|voie des stands/i.test([t.name, t['name:en'], t['name:fr']].filter(Boolean).join(' ')) || /pit/i.test(t.raceway || '') || t.service === 'pit_lane' || /pit/i.test(t['service'] || '');
const isKart = (t) => /kart/i.test((t.name || '') + (t.sport || '') + (t.raceway || ''));
function refWays(id) {
  const out = [];
  const j = ovp(id + '-raceway');
  if (j) for (const e of j.elements) {
    if (e.type !== 'way' || !e.geometry) continue;
    const t = e.tags || {};
    if (!(t.highway === 'raceway' || t.raceway) || isPit(t) || isKart(t)) continue;
    if (/^(start-finish|finish|start)$/.test(t.raceway || '') || /start|finish/i.test(t.name || '') || /dirt track/i.test(t.name || '')) continue;
    out.push({ id: e.id, tags: t, g: e.geometry });
  }
  const s = ovp(id + '-streets');            // street circuits: the public roads (osm-streets.mjs)
  if (s) for (const e of s.elements) {
    if (e.type !== 'way' || !e.geometry) continue;
    if (out.some((w) => w.id === e.id)) continue;
    out.push({ id: e.id, tags: e.tags || {}, g: e.geometry, street: true });
  }
  return out;
}
function pitWays(id) {
  const out = [];
  for (const name of [id + '-raceway', id + '-streets']) {
    const j = ovp(name);
    if (!j) continue;
    for (const e of j.elements) if (e.type === 'way' && e.geometry && isPit(e.tags || {}) && !out.some((w) => w.id === e.id)) out.push({ id: e.id, tags: e.tags, g: e.geometry });
  }
  return out;
}

const usgsCache = (() => { const f = resolve(ROOT, 'tools', 'elevation-cache-usgs3dep.json'); return existsSync(f) ? readJ(f) : {}; })();

for (const id of IDS) {
  const G = readJ(resolve(HERE, 'out', 'game-' + id + '.json'));
  const S = G.samples, N = S.length, L = G.builtLength, gds = L / N;
  const F = frame(G.geo.lat0, G.geo.lon0);
  const P = S.map((q) => F.en(q.lat, q.lon));
  // game tangent / left normal per sample (east / north frame)
  const T = P.map((p, i) => { const a = P[(i - 1 + N) % N], b = P[(i + 1) % N], l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; });
  const gameSeg = P.map((p, i) => ({ a: p, b: P[(i + 1) % N], i }));
  const gIdx = segIndex(gameSeg, 40);
  const sOf = (p) => { const f = gIdx.nearest(p, 2000); const i = f.seg.i; return { s: S[i].s + f.t * gds, d: f.d, i, side: Math.sign(-T[i][1] * (p[0] - P[i][0]) + T[i][0] * (p[1] - P[i][1])) }; };

  // ---------------------------------------------------------------- layout: deviation from the OSM centreline
  const ways = refWays(id);
  const segs = [], ssegs = [];
  for (const w of ways) for (let k = 0; k + 1 < w.g.length; k++) (w.street ? ssegs : segs).push({ a: F.en(w.g[k].lat, w.g[k].lon), b: F.en(w.g[k + 1].lat, w.g[k + 1].lon), way: w });
  const rIdx = segIndex(segs, 40), sIdx = segIndex(ssegs, 40);
  const M = Math.round(L / STEP), ds = L / M;
  const prof = [];
  let onStreet = 0;
  for (let k = 0; k < M; k++) {
    const s = k * ds, u = s / gds, i = Math.floor(u) % N, t = u - Math.floor(u), j = (i + 1) % N;
    const p = [P[i][0] + (P[j][0] - P[i][0]) * t, P[i][1] + (P[j][1] - P[i][1]) * t];
    // raceway ways first; a public road only where no raceway way is within 12 m (and the road is closer)
    let f = segs.length ? rIdx.nearest(p, 300) : null;
    if (ssegs.length && (!f || f.d > 12)) { const g2 = sIdx.nearest(p, 300); if (g2 && (!f || g2.d < f.d)) { f = g2; onStreet++; } }
    prof.push({ s, p, i, gy: S[i].y + (S[j].y - S[i].y) * t, gbank: S[i].bank + (S[j].bank - S[i].bank) * t, gk: S[i].k,
      d: f ? f.d : null, q: f ? f.q : p, way: f ? f.seg.way : null, segIdx: f ? f.idx : -1 });
  }
  const dev = prof.map((r) => r.d).filter((v) => v !== null);
  const devSorted = dev.slice().sort((a, b) => a - b);
  const runs = [];      // contiguous stretches > 12 m off
  for (let k = 0; k < M; k++) {
    const r = prof[k];
    if (r.d === null || r.d <= 12) continue;
    const last = runs[runs.length - 1];
    if (last && last.k1 === k - 1) { last.k1 = k; if (r.d > last.max) { last.max = r.d; last.at = k; } }
    else runs.push({ k0: k, k1: k, max: r.d, at: k });
  }
  const layout = {
    osmWays: ways.length, osmStreetWays: ways.filter((w) => w.street).length, fractionMatchedToStreets: r2(onStreet / M),
    deviation: segs.length ? { mean: r1(dev.reduce((a, b) => a + b, 0) / dev.length), median: r1(devSorted[devSorted.length >> 1]),
      p95: r1(devSorted[Math.floor(devSorted.length * 0.95)]), max: r1(devSorted[devSorted.length - 1]),
      maxAt: (() => { let kk = 0; prof.forEach((r, k) => { if (r.d !== null && r.d > prof[kk].d) kk = k; }); return { s: Math.round(prof[kk].s), at: F.ll(...prof[kk].p).map((v) => +v.toFixed(6)), way: prof[kk].way ? prof[kk].way.id + ' ' + (prof[kk].way.tags.name || '') : null }; })() } : null,
    offStretches: runs.map((u) => ({ s0: Math.round(prof[u.k0].s), s1: Math.round(prof[u.k1].s), maxDev: r1(u.max),
      at: F.ll(...prof[u.at].p).map((v) => +v.toFixed(6)), nearestWay: prof[u.at].way ? prof[u.at].way.id + ' ' + (prof[u.at].way.tags.name || '') : null })),
  };
  // OSM raceway ways (not street) that the game line does not follow (other layouts or a changed layout)
  const uncovered = [];
  for (const w of ways.filter((x) => !x.street)) {
    let far = 0, tot = 0, maxD = 0, mid = null;
    for (let k = 0; k + 1 < w.g.length; k++) {
      const a = F.en(w.g[k].lat, w.g[k].lon), b = F.en(w.g[k + 1].lat, w.g[k + 1].lon), l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(l / 5));
      for (let m = 0; m < n; m++) {
        const p = [a[0] + (b[0] - a[0]) * (m + 0.5) / n, a[1] + (b[1] - a[1]) * (m + 0.5) / n];
        const g = gIdx.nearest(p, 400);
        const d = g ? g.d : 400;
        tot += l / n;
        if (d > 15) { far += l / n; if (d > maxD) { maxD = d; mid = p; } }
      }
    }
    if (far > 20) uncovered.push({ way: w.id, name: w.tags.name || null, lengthM: Math.round(tot), offM: Math.round(far), maxDev: r1(maxD),
      at: mid ? F.ll(...mid).map((v) => +v.toFixed(6)) : null });
  }
  layout.osmWaysNotFollowed = uncovered;
  // racing direction: OpenStreetMap oneway=yes raceway ways (digitised in the driving direction) vs the game's order
  let agree = 0, against = 0;
  const onewayWays = [];
  for (const w of ways.filter((x) => !x.street && x.tags.oneway === 'yes')) {
    let a1 = 0, a2 = 0;
    for (let k = 0; k + 1 < w.g.length; k++) {
      const a = F.en(w.g[k].lat, w.g[k].lon), b = F.en(w.g[k + 1].lat, w.g[k + 1].lon), l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1) continue;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], g = gIdx.nearest(mid, 30);
      if (!g || g.d > 8) continue;
      const t = T[g.seg.i], dot = ((b[0] - a[0]) * t[0] + (b[1] - a[1]) * t[1]) / l;
      if (dot > 0.5) a1 += l; else if (dot < -0.5) a2 += l;
    }
    if (a1 + a2 > 0) onewayWays.push({ way: w.id, name: w.tags.name || null, sameM: Math.round(a1), oppositeM: Math.round(a2) });
    agree += a1; against += a2;
  }
  layout.onewayCheck = { sameDirectionM: Math.round(agree), oppositeM: Math.round(against), ways: onewayWays };
  // length of the OSM centreline along the game's order (foot points every 10 m; chord sum)
  let osmLen = 0;
  for (let k = 0; k < M; k++) { const a = prof[k].q, b = prof[(k + 1) % M].q; osmLen += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  layout.osmFootPathLengthM = Math.round(osmLen);

  // ---------------------------------------------------------------- start / finish
  const sfNodes = [];
  for (const name of [id + '-raceway', id + '-streets']) {
    const j = ovp(name);
    if (!j) continue;
    for (const e of j.elements) if (e.type === 'node' && e.tags && (/start|finish/i.test(e.tags.raceway || '') || /start|finish|ligne|départ|arrivée/i.test(e.tags.name || ''))) {
      const p = F.en(e.lat, e.lon), q = sOf(p), sw = q.s > L / 2 ? q.s - L : q.s;
      sfNodes.push({ node: e.id, tags: e.tags, lat: e.lat, lon: e.lon, gameS: r1(sw), lateral: r1(q.d) });
    }
    // painted lines mapped as short ways across the track (e.g. "IMS Start-Finish Line"): where they cross the game line
    for (const e of j.elements) if (e.type === 'way' && e.geometry && /start|finish|ligne d'arrivée|ligne de départ/i.test((e.tags || {}).name || '') && !isPit(e.tags)) {
      const g = e.geometry.map((q) => F.en(q.lat, q.lon));
      for (let k = 0; k + 1 < g.length; k++) for (let i = 0; i < N; i++) {
        const x = segX(g[k], g[k + 1], P[i], P[(i + 1) % N]);
        if (!x) continue;
        const s = S[i].s + x.u * gds, sw = s > L / 2 ? s - L : s, ll = F.ll(...x.q);
        sfNodes.push({ way: e.id, tags: e.tags, lat: +ll[0].toFixed(7), lon: +ll[1].toFixed(7), gameS: r1(sw), lateral: 0 });
      }
    }
  }

  // ---------------------------------------------------------------- pit lane
  const pw = pitWays(id);
  const pit = { game: G.pit, osm: [] };
  for (const w of pw) {
    const ss = w.g.map((g) => { const p = F.en(g.lat, g.lon), q = sOf(p); return { s: q.s, d: q.d, side: q.side }; });
    if (Math.min(...ss.map((q) => q.d)) > 250) continue;
    // order along the lap, unwrapped around the line
    const sw = ss.map((q) => (q.s > L / 2 ? q.s - L : q.s));
    const sides = ss.filter((q) => q.d > 6).map((q) => q.side);
    const sideSum = sides.reduce((a, b) => a + b, 0);
    let len = 0;
    for (let k = 0; k + 1 < w.g.length; k++) { const a = F.en(w.g[k].lat, w.g[k].lon), b = F.en(w.g[k + 1].lat, w.g[k + 1].lon); len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    pit.osm.push({ way: w.id, tags: w.tags, lengthM: Math.round(len), firstNodeS: r1(sw[0]), lastNodeS: r1(sw[sw.length - 1]),
      minS: r1(Math.min(...sw)), maxS: r1(Math.max(...sw)), maxLateral: r1(Math.max(...ss.map((q) => q.d))),
      side: sideSum > 0 ? 'left' : sideSum < 0 ? 'right' : '?', first: [w.g[0].lat, w.g[0].lon], last: [w.g[w.g.length - 1].lat, w.g[w.g.length - 1].lon] });
  }

  // ---------------------------------------------------------------- elevation (lidar) along the OSM centreline
  // tangent of the foot path -> left normal; points at -HALF / 0 / +HALF m
  const pts = [], cross = [];
  for (let k = 0; k < M; k++) {
    const a = prof[(k - 1 + M) % M].q, b = prof[(k + 1) % M].q;
    let tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz);
    if (l < 1) { tx = T[prof[k].i][0]; tz = T[prof[k].i][1]; l = 1; }
    tx /= l; tz /= l;
    const nL = [-tz, tx], q = prof[k].q;
    pts.push(F.ll(q[0], q[1]));
    cross.push([F.ll(q[0] + nL[0] * HALF, q[1] + nL[1] * HALF), F.ll(q[0] - nL[0] * HALF, q[1] - nL[1] * HALF)]);
  }
  const src = id.startsWith('ca-') ? 'hrdem' : 'usgs3dep';
  const sampler = src === 'hrdem' ? hrdem : usgs3dep;
  const all = [...pts, ...cross.map((c) => c[0]), ...cross.map((c) => c[1])].map(([la, lo]) => [+la.toFixed(6), +lo.toFixed(6)]);
  const hv = await sampler(all);
  const h0 = hv.slice(0, M), hL = hv.slice(M, 2 * M), hR = hv.slice(2 * M);
  const holes = h0.filter((v) => v === null || !Number.isFinite(v)).length;
  // fill holes linearly (closed loop)
  const fill = (h) => { const m = h.length, o = h.slice(); for (let i = 0; i < m; i++) if (!Number.isFinite(o[i])) { let a = i, b = i, da = 0, db = 0; while (!Number.isFinite(h[a]) && da < m) { a = (a - 1 + m) % m; da++; } while (!Number.isFinite(h[b]) && db < m) { b = (b + 1) % m; db++; } o[i] = h[a] + (h[b] - h[a]) * da / (da + db); } return o; };
  const real = medianLoop(fill(h0), 1);                                 // 30 m median: kerb / drain / verge picks
  // the game's own raw heights (its build fetched them along the dataset centreline): nearest cache key within 6 m
  let buildRaw = null;
  if (src === 'usgs3dep') {
    const keys = Object.keys(usgsCache).map((k) => { const [la, lo] = k.split(',').map(Number); return { la, lo, v: usgsCache[k], p: F.en(la, lo) }; })
      .filter((o) => Math.abs(o.p[0]) < 5000 && Math.abs(o.p[1]) < 5000 && o.v !== null);
    const kIdx = segIndex(keys.map((o) => ({ a: o.p, b: o.p, o })), 40);
    buildRaw = prof.map((r) => { const f = kIdx.nearest(r.p, 30); return f && f.d < 8 ? f.seg.o.v : null; });
  }
  const game = prof.map((r) => r.gy);
  const meanOff = real.reduce((a, b) => a + b, 0) / M - game.reduce((a, b) => a + b, 0) / M;
  const diff = game.map((v, k) => v + meanOff - real[k]);
  const rng = (h) => { let mn = Infinity, mx = -Infinity, imn = 0, imx = 0; h.forEach((v, k) => { if (v < mn) { mn = v; imn = k; } if (v > mx) { mx = v; imx = k; } }); return { range: r1(mx - mn), min: r1(mn), max: r1(mx), sMin: Math.round(imn * ds), sMax: Math.round(imx * ds) }; };
  function gradeStats(h, w) {
    const g = grades(h, ds, w);
    let imx = 0, imn = 0;
    g.forEach((v, k) => { if (v > g[imx]) imx = k; if (v < g[imn]) imn = k; });
    return { g, maxClimb: { pct: r1(g[imx] * 100), s: Math.round(imx * ds), at: pts[imx].map((v) => +v.toFixed(6)) },
      maxDescent: { pct: r1(g[imn] * 100), s: Math.round(imn * ds), at: pts[imn].map((v) => +v.toFixed(6)) } };
  }
  const grd = {};
  for (const w of [50, 100]) {
    const R = gradeStats(real, w), Gm = gradeStats(game, w);
    // stretches where |game - real| > 2 percentage points (merged when < 30 m apart)
    const bad = [];
    for (let k = 0; k < M; k++) {
      const e = (Gm.g[k] - R.g[k]) * 100;
      if (Math.abs(e) <= 2) continue;
      const last = bad[bad.length - 1];
      if (last && k - last.k1 <= 3 && Math.sign(e) === last.sign) { last.k1 = k; if (Math.abs(e) > Math.abs(last.e)) { last.e = e; last.at = k; } }
      else bad.push({ k0: k, k1: k, e, at: k, sign: Math.sign(e) });
    }
    grd['w' + w] = {
      real: { maxClimb: R.maxClimb, maxDescent: R.maxDescent }, game: { maxClimb: Gm.maxClimb, maxDescent: Gm.maxDescent },
      rmsDiffPct: r2(Math.sqrt(Gm.g.reduce((a, v, k) => a + ((v - R.g[k]) * 100) ** 2, 0) / M)),
      mismatches: bad.filter((b) => (b.k1 - b.k0 + 1) * ds >= 20).map((b) => ({ s0: Math.round(b.k0 * ds), s1: Math.round(b.k1 * ds),
        worstAtS: Math.round(b.at * ds), realPct: r1(R.g[b.at] * 100), gamePct: r1(Gm.g[b.at] * 100), at: pts[b.at].map((v) => +v.toFixed(6)) })),
    };
  }
  let buildRawStats = null;
  if (buildRaw) {
    const ok = buildRaw.filter((v) => v !== null).length;
    const br = fill(buildRaw);
    buildRawStats = { coverage: r2(ok / M), ...rng(br), maxClimb50: r1(Math.max(...grades(medianLoop(br, 1), ds, 50)) * 100),
      maxDescent50: r1(Math.min(...grades(medianLoop(br, 1), ds, 50)) * 100),
      rmsVsOsmLine: r2(Math.sqrt(br.reduce((a, v, k) => a + (v - real[k]) ** 2, 0) / M)) };
  }
  const elevation = {
    source: src === 'hrdem' ? 'NRCan HRDEM mosaic DTM (lidar, 1 m grid; WCS datacube.services.geo.ca)' : 'USGS 3DEP bare-earth DEM (1 m lidar; ImageServer getSamples)',
    holes, real: rng(real), game: rng(game), buildRawAlongDatasetLine: buildRawStats,
    rmsDiffM: r2(Math.sqrt(diff.reduce((a, v) => a + v * v, 0) / M)),
    correlation: (() => { const mr = real.reduce((a, b) => a + b, 0) / M, mg = game.reduce((a, b) => a + b, 0) / M; let sxy = 0, sxx = 0, syy = 0;
      for (let k = 0; k < M; k++) { sxy += (real[k] - mr) * (game[k] - mg); sxx += (real[k] - mr) ** 2; syy += (game[k] - mg) ** 2; } return r3(sxy / Math.sqrt(sxx * syy)); })(),
    maxAbsDiff: (() => { let k = 0; diff.forEach((v, j) => { if (Math.abs(v) > Math.abs(diff[k])) k = j; }); return { m: r1(diff[k]), s: Math.round(k * ds), at: pts[k].map((v) => +v.toFixed(6)) }; })(),
    grades: grd,
  };

  // ---------------------------------------------------------------- banking: real cross-slope at +-HALF m vs game bank
  // tilt > 0 = left side higher (the game's bank sign: js/track.js lowers the +n = left side for a negative bank)
  const tilt = prof.map((_, k) => (Number.isFinite(hL[k]) && Number.isFinite(hR[k]) ? Math.atan((hL[k] - hR[k]) / (2 * HALF)) * D : null));
  // corners from the game curvature (radius < 250 m), merged across gaps < 30 m
  const kAbs = prof.map((r) => Math.abs(r.gk));
  const corners = [];
  for (let k = 0; k < M; k++) {
    if (kAbs[k] < 1 / 250) continue;
    const dir = Math.sign(prof[k].gk);
    const last = corners[corners.length - 1];
    if (last && k - last.k1 <= 3 && last.dir === dir) last.k1 = k; else corners.push({ k0: k, k1: k, dir });
  }
  const bankRows = corners.filter((c) => (c.k1 - c.k0 + 1) * ds >= 20).map((c) => {
    const ks = []; for (let k = c.k0; k <= c.k1; k++) ks.push(k);
    const inside = (v) => -c.dir * v;           // inside-lower positive
    const rt = ks.map((k) => tilt[k]).filter((v) => v !== null).map(inside), gt = ks.map((k) => inside(prof[k].gbank));
    const minR = 1 / Math.max(...ks.map((k) => kAbs[k]));
    const mid = ks[ks.length >> 1];
    return { s0: Math.round(c.k0 * ds), s1: Math.round(c.k1 * ds), dir: c.dir > 0 ? 'L' : 'R', minRadius: Math.round(minR),
      at: pts[mid].map((v) => +v.toFixed(6)), way: prof[mid].way ? (prof[mid].way.tags.name || prof[mid].way.id) : null,
      realInsideLowerDeg: { median: r1(median(rt)), max: r1(Math.max(...rt)), min: r1(Math.min(...rt)) },
      gameInsideLowerDeg: { median: r1(median(gt)), max: r1(Math.max(...gt)) } };
  });
  const straightT = prof.map((r, k) => (kAbs[k] < 1 / 1000 ? tilt[k] : null)).filter((v) => v !== null);
  const banking = { method: `lidar heights at +-${HALF} m across the OSM centreline every ${STEP} m; tilt = atan((hLeft - hRight) / ${2 * HALF} m)`,
    straightsAbsTiltMedianDeg: r1(median(straightT.map(Math.abs))), corners: bankRows,
    gameOverrides: G.bankOverrides, gameMaxAbsBankDeg: r1(Math.max(...S.map((q) => Math.abs(q.bank)))) };

  // ---------------------------------------------------------------- bridges / tunnels crossing or carrying the line
  const tb = ovp(id + '-tunnels-bridges');
  const crossings = [];
  if (tb) for (const e of tb.elements) {
    if (e.type !== 'way' || !e.geometry) continue;
    const t = e.tags || {};
    const g = e.geometry.map((q) => F.en(q.lat, q.lon));
    // along the line (the track itself on a bridge / in a tunnel): >= 60 % of its vertices within 10 m of the line
    const near = g.map((p) => gIdx.nearest(p, 100)).map((f) => (f ? f.d : 999));
    let len = 0; for (let k = 0; k + 1 < g.length; k++) len += Math.hypot(g[k + 1][0] - g[k][0], g[k + 1][1] - g[k][1]);
    if (near.filter((d) => d < 10).length >= 0.6 * g.length && len > 8) {
      const ss = g.map((p) => sOf(p).s);
      crossings.push({ kind: 'along', way: e.id, tags: t, lengthM: Math.round(len), s0: r1(Math.min(...ss)), s1: r1(Math.max(...ss)) });
      continue;
    }
    for (let k = 0; k + 1 < g.length; k++) {
      const a = g[k], b = g[k + 1];
      for (let i = 0; i < N; i++) {
        const c = P[i], dd = P[(i + 1) % N];
        if (Math.max(a[0], b[0]) < Math.min(c[0], dd[0]) - 1 || Math.min(a[0], b[0]) > Math.max(c[0], dd[0]) + 1) continue;
        if (Math.max(a[1], b[1]) < Math.min(c[1], dd[1]) - 1 || Math.min(a[1], b[1]) > Math.max(c[1], dd[1]) + 1) continue;
        const x = segX(a, b, c, dd);
        if (x) crossings.push({ kind: 'crosses', way: e.id, tags: t, s: r1(S[i].s + x.u * gds), at: F.ll(...x.q).map((v) => +v.toFixed(6)) });
      }
    }
  }
  // the game's scenery bridges (scenery-data.js man_made=bridge polygons, drawn as decks) that the line passes under
  let sceneryBridges = [];
  try {
    global.window = global;
    if (!global.F1_SCENERY) createRequire(import.meta.url)(resolve(ROOT, 'scenery-data.js'));
    const sc = global.F1_SCENERY && global.F1_SCENERY[id];
    if (sc) for (const b of sc.buildings) if (b.k === 'bridge') {
      const poly = b.p.map(([x, z]) => F.en(G.geo.lat0 + z / G.geo.kz, G.geo.lon0 + x / G.geo.kx));
      const inside = [];
      for (let i = 0; i < N; i += 2) {
        let c = false; const p = P[i];
        for (let a = 0, bb = poly.length - 1; a < poly.length; bb = a++) {
          if ((poly[a][1] > p[1]) !== (poly[bb][1] > p[1]) && p[0] < (poly[bb][0] - poly[a][0]) * (p[1] - poly[a][1]) / (poly[bb][1] - poly[a][1]) + poly[a][0]) c = !c;
        }
        if (c) inside.push(S[i].s);
      }
      const cen = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
      sceneryBridges.push({ centre: F.ll(...cen).map((v) => +v.toFixed(6)), overLine: inside.length > 0, lineInsideM: inside.length * 2 * gds,
        s: inside.length ? r1(inside[0]) : null, h: b.h });
    }
  } catch (e) { sceneryBridges = 'error ' + e.message; }

  const out = { id, name: G.name, builtLengthM: r1(L), direction: G.direction, layout, startFinish: { gameStart: [S[0].lat, S[0].lon], osmNodes: sfNodes },
    pit, elevation, banking, crossings, sceneryBridges,
    profile: { step: r2(ds), note: 's from the game line; real = lidar on the OSM foot point (30 m median); game = js/track.js sample y; tilt = lidar cross-slope (deg, + = left higher); gBank = game bank (deg, same sign)',
      rows: prof.map((r, k) => [Math.round(r.s), +pts[k][0].toFixed(6), +pts[k][1].toFixed(6), r2(real[k]), r2(r.gy + meanOff), r.d === null ? null : r1(r.d),
        tilt[k] === null ? null : r1(tilt[k]), r1(r.gbank), buildRaw && buildRaw[k] !== null ? r2(buildRaw[k]) : null]),
      columns: ['s', 'lat', 'lon', 'realH', 'gameH(offset to real mean)', 'osmDev', 'realTiltDeg', 'gameBankDeg', 'buildRawH'] } };
  writeFileSync(resolve(HERE, 'out', 'audit-' + id + '.json'), JSON.stringify(out, null, 1));
  console.log(`${id}: dev ${JSON.stringify(layout.deviation)} off ${layout.offStretches.length} notFollowed ${uncovered.length} | elev real ${JSON.stringify(elevation.real)} game ${JSON.stringify(elevation.game)} rms ${elevation.rmsDiffM} | ` +
    `climb50 real ${elevation.grades.w50.real.maxClimb.pct} game ${elevation.grades.w50.game.maxClimb.pct} desc50 real ${elevation.grades.w50.real.maxDescent.pct} game ${elevation.grades.w50.game.maxDescent.pct} | corners ${bankRows.length} | crossings ${crossings.length}`);
}
