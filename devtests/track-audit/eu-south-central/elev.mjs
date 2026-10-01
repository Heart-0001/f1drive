// node devtests/track-audit/eu-south-central/elev.mjs [ids]
// Elevation and cross-slope (banking) of the five circuits against better height models than the game's GLO-90:
// stations every 5 m of game arc length, snapped onto the OpenStreetMap F1 centreline (when within 12 m), sampled in
// the circuit's best model (dem.mjs), plus the F1 live-timing car heights (lt.mjs). Lidar sources also get a cross-section
// every 10 m (offsets -5, -3, 0, +3, +5 m across the road; least-squares slope = road cross-fall / banking, + = left side
// higher, the convention of js/track.js samples' bank). Writes out/elev-<id>.json and prints a summary.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, loadGame, loadOSM, gameLine, osmLayout, proj, wrap } from './lib.mjs';
import * as DEM from './dem.mjs';

const STEP = 5;
const SOURCES = {
  'at-1969': [{ key: 'bev', label: 'BEV ALS DTM 1 m (Austria, airborne laser scanning; 2023 release, CC BY 4.0)', fn: DEM.bev, cross: true, lidar: true }],
  'it-1953': [{ key: 'er', label: 'Regione Emilia-Romagna DTM 0.5 m RER2022 (lidar 2022/23)', fn: (p) => DEM.er(p), cross: true, lidar: true }],
  'it-1914': [
    { key: 'toscDSM', label: 'Regione Toscana DSM 1 m 2021 (lidar surface model; on the asphalt = road surface)', fn: (p) => DEM.toscana(p), cross: true, lidar: true },
    { key: 'toscDTM10', label: 'Regione Toscana DTM 10 m', fn: (p) => DEM.toscana(p, 'rt_morfologia.iddtm.10m.rt', 10), step: 10 },
  ],
  'it-1922': [
    { key: 'tinitaly', label: 'TINITALY 1.1 DEM 10 m (INGV)', fn: (p) => DEM.tinitaly(p, [521300, 5050500, 523800, 5053600]), step: 10 },
    { key: 'eudem', label: 'EU-DEM v1.1 25 m via OpenTopoData', fn: (p) => DEM.otd(p, 'eudem25m'), step: 25 },
  ],
  'hu-1986': [
    { key: 'eudem', label: 'EU-DEM v1.1 25 m via OpenTopoData', fn: (p) => DEM.otd(p, 'eudem25m'), step: 25 },
    { key: 'srtm30', label: 'SRTM GL1 30 m via OpenTopoData', fn: (p) => DEM.otd(p, 'srtm30m'), step: 25 },
  ],
};

function gaussLoop(h, sigma) {
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), (m >> 1) - 1), k = []; let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => { let a = 0; for (let j = -r; j <= r; j++) a += k[j + r] * h[((i + j) % m + m) % m]; return a / sum; });
}
function medianLoop(h, half) {
  const m = h.length;
  return h.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]); w.sort((a, b) => a - b); return w[half]; });
}
function fillLoop(h) {
  const m = h.length, ok = h.map(Number.isFinite), out = h.slice();
  if (!ok.some(Boolean)) return out;
  for (let i = 0; i < m; i++) if (!ok[i]) {
    let a = i, b = i, da = 0, db = 0;
    while (!ok[(a + m) % m]) { a--; da++; } while (!ok[b % m]) { b++; db++; }
    out[i] = h[(a + m) % m] + (h[b % m] - h[(a + m) % m]) * da / (da + db);
  }
  return out;
}
// periodic linear interpolation of (xs, ys) at x
function interp(xs, ys, x, total) {
  const n = xs.length; x = wrap(x, total);
  let lo = 0, hi = n - 1;
  if (x < xs[0] || x >= xs[n - 1]) { const a = n - 1, b = 0, span = total - xs[a] + xs[b], t = wrap(x - xs[a], total) / span; return ys[a] + (ys[b] - ys[a]) * t; }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  return ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / (xs[hi] - xs[lo]);
}
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

function gradeStats(h, total, names) {      // h at STEP spacing; grades over 50 / 100 m (central)
  const n = h.length, out = {};
  for (const W of [50, 100]) {
    const k = Math.round(W / 2 / STEP), g = h.map((_, i) => (h[(i + k) % n] - h[(i - k + n) % n]) / (2 * k * STEP));
    let mx = 0, mi = 0; g.forEach((v, i) => { if (v > g[mx]) mx = i; if (v < g[mi]) mi = i; });
    out['g' + W] = g;
    out['maxClimb' + W] = { pct: r1(g[mx] * 100), s: mx * STEP, at: names(mx * STEP) };
    out['maxDescent' + W] = { pct: r1(g[mi] * 100), s: mi * STEP, at: names(mi * STEP) };
  }
  return out;
}

for (const id of (process.argv[2] || 'it-1922,it-1953,it-1914,at-1969,hu-1986').split(',')) {
  const game = loadGame(id), osm = loadOSM(id), gl = gameLine(id, game), lay = osmLayout(id, osm), p = proj(id), total = gl.total;
  const layout = JSON.parse(readFileSync(resolve(HERE, 'out', `layout-${id}.json`), 'utf8'));
  const names = (s) => {
    let best = null;
    for (const c of layout.corners) {
      const len = wrap(c.to - c.from, total), d = wrap(s - c.from, total);
      if (d <= len + 30 || wrap(c.from - s, total) <= 30) { const dd = Math.min(Math.abs(wrap(s - c.mid, total)), Math.abs(wrap(c.mid - s, total))); if (!best || dd < best.dd) best = { dd, n: (c.ref ? 'T' + c.ref + ' ' : '') + (c.name || '') }; }
    }
    // official turn numbers: MultiViewer corners (F1 timing data) mapped onto the game line, else OSM refs
    const T = layout.multiviewer ? layout.multiviewer.corners.map((c) => ({ n: 'T' + c.number + (c.letter || ''), s: c.gameS }))
      : layout.corners.filter((c) => c.ref).map((c) => ({ n: 'T' + c.ref, s: c.mid }));
    let tb = null;
    for (const c of T) { const d = ((s - c.s) % total + total * 1.5) % total - total / 2; if (!tb || Math.abs(d) < Math.abs(tb.d)) tb = { d, n: c.n }; }
    const tn = tb ? (Math.abs(tb.d) <= 40 ? tb.n : Math.round(Math.abs(tb.d)) + ' m ' + (tb.d < 0 ? 'before ' : 'after ') + tb.n) : null;
    const on = best ? best.n.trim() : null;
    return [tn, on && !/^Td/.test(on) ? on : null].filter(Boolean).join(' / ') || null;
  };
  const S = gl.S, gs = S.map((q) => q.s), gy = S.map((q) => q.y), gb = S.map((q) => q.bankDeg);
  const M = Math.floor(total / STEP), st = [];
  for (let k = 0; k < M; k++) {
    const s = k * STEP, x = interp(gs, gl.P.map((q) => q[0]), s, total), y = interp(gs, gl.P.map((q) => q[1]), s, total);
    const xa = interp(gs, gl.P.map((q) => q[0]), s - 5, total), ya = interp(gs, gl.P.map((q) => q[1]), s - 5, total);
    const xb = interp(gs, gl.P.map((q) => q[0]), s + 5, total), yb = interp(gs, gl.P.map((q) => q[1]), s + 5, total);
    const tl = Math.hypot(xb - xa, yb - ya), nx = -(yb - ya) / tl, ny = (xb - xa) / tl;    // left normal
    const sn = lay.idx.near(x, y, 50), use = sn.d < 12 ? [sn.px, sn.py] : [x, y];
    st.push({ s, c: use, n: [nx, ny], snapD: sn.d, gy: interp(gs, gy, s, total), gb: interp(gs, gb, s, total) });
  }
  const res = { id, name: game.name, stepM: STEP, totalM: r1(total), sources: {}, game: {} };
  // game profile (built track, what the player drives)
  const G = st.map((q) => q.gy), gmin = Math.min(...G);
  res.game = { rangeM: r1(Math.max(...G) - gmin), datasetElevRangeM: r1(Math.max(...game.points.map((q) => q[3])) - Math.min(...game.points.map((q) => q[3]))) };
  const gG = gradeStats(G, total, names);
  Object.assign(res.game, { maxClimb50: gG.maxClimb50, maxDescent50: gG.maxDescent50, maxClimb100: gG.maxClimb100, maxDescent100: gG.maxDescent100 });
  const refs = {};
  for (const src of SOURCES[id]) {
    const every = Math.round((src.step || STEP) / STEP), idxs = st.map((_, i) => i).filter((i) => i % every === 0);
    const pts = idxs.map((i) => p.from(...st[i].c));
    let raw = await src.fn(pts);
    let h = new Array(M).fill(NaN);
    idxs.forEach((i, k) => { h[i] = raw[k]; });
    const holes = raw.filter((v) => !Number.isFinite(v)).length;
    // smoothing: lidar 1 m: median 25 m (kerbs, a drain, a stray return) + Gauss sigma 10 m; coarse grids: interpolate + Gauss sigma 15 m
    if (src.lidar) h = gaussLoop(medianLoop(fillLoop(h), 2), 10 / STEP);
    else h = gaussLoop(fillLoop(h), 15 / STEP);
    refs[src.key] = h;
    const hmin = Math.min(...h), gr = gradeStats(h, total, names);
    const entry = { label: src.label, stepM: src.step || STEP, holes, absMinM: r1(hmin), absMaxM: r1(Math.max(...h)), rangeM: r1(Math.max(...h) - hmin),
      maxClimb50: gr.maxClimb50, maxDescent50: gr.maxDescent50, maxClimb100: gr.maxClimb100, maxDescent100: gr.maxDescent100 };
    // cross-section (banking / cross-fall)
    if (src.cross) {
      const ci = st.map((_, i) => i).filter((i) => i % 2 === 0), offs = [-4, -3, -2, -1, 1, 2, 3, 4], cp = [];
      for (const i of ci) for (const o of offs) cp.push(p.from(st[i].c[0] + st[i].n[0] * o, st[i].c[1] + st[i].n[1] * o));
      const cv = await src.fn(cp);
      const slope = ci.map((i, k) => {
        const hs = offs.map((o, j) => [o, cv[k * 8 + j]]); hs.splice(4, 0, [0, raw[idxs.indexOf(i)]]);
        const ok = hs.filter((q) => Number.isFinite(q[1]));
        if (ok.length < 6) return NaN;
        // Theil-Sen (median of pairwise slopes): robust to a kerb, a drain or a stray return in the lidar
        const sl = []; for (let a = 0; a < ok.length; a++) for (let b = a + 1; b < ok.length; b++) sl.push((ok[b][1] - ok[a][1]) / (ok[b][0] - ok[a][0]));
        sl.sort((x, y) => x - y);
        const m = sl[sl.length >> 1], c = ok.map((q) => q[1] - m * q[0]).sort((x, y) => x - y)[ok.length >> 1];
        const resid = ok.map((q) => Math.abs(q[1] - (c + m * q[0]))).sort((x, y) => x - y);
        if (resid[Math.floor(resid.length * 0.75)] > 0.15) return NaN;     // not a plane (structure, ditch, edge): no reading
        return Math.atan(m) * 180 / Math.PI;
      });
      const sl = gaussLoop(medianLoop(fillLoop(slope), 1), 1);
      entry.crossSlope = { stepM: 2 * STEP, offsetsM: [-4, -3, -2, -1, 0, 1, 2, 3, 4], method: 'Theil-Sen slope; stations whose 75th-percentile residual exceeds 0.15 m are dropped', deg: sl.map(r2) };
      // per named corner: mean real cross-fall vs mean game bank (signed; + = left side higher)
      entry.crossSlope.droppedStations = slope.filter((v) => !Number.isFinite(v)).length;
      // per corner: official turn numbers (MultiViewer) +-40 m, else the OSM ways with a ref / name
      const cw = layout.multiviewer ? layout.multiviewer.corners.map((c) => ({ ref: c.number + (c.letter || ''), name: names(c.gameS), from: wrap(c.gameS - 40, total), to: wrap(c.gameS + 40, total) }))
        : layout.corners.filter((c) => c.ref || c.name);
      entry.cornerBanking = cw.map((c) => {
        const len = wrap(c.to - c.from, total), rs = [], gsv = [];
        ci.forEach((i, k) => { const d = wrap(st[i].s - c.from, total); if (d <= len && Number.isFinite(slope[k])) { rs.push(sl[k]); gsv.push(st[i].gb); } });
        if (!rs.length) return null;
        const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, ext = (a) => a.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
        return { corner: (c.ref ? 'T' + c.ref + ' ' : '') + (c.name && !String(c.name).startsWith('T') ? c.name : ''), from: c.from, to: c.to, realMeanDeg: r1(mean(rs)), realMaxAbsDeg: r1(ext(rs)), gameMeanDeg: r1(mean(gsv)), gameMaxAbsDeg: r1(ext(gsv)) };
      }).filter(Boolean);
      // whole-lap comparison
      const pairs = ci.map((i, k) => [sl[k], st[i].gb]).filter((q) => Number.isFinite(q[0]));
      const absR = pairs.map((q) => Math.abs(q[0])).sort((a, b) => a - b), absG = pairs.map((q) => Math.abs(q[1])).sort((a, b) => a - b);
      const opp = pairs.filter((q) => Math.abs(q[0]) > 1.5 && Math.abs(q[1]) > 1.5 && Math.sign(q[0]) !== Math.sign(q[1])).length;
      entry.crossSummary = { realAbsMedianDeg: r1(absR[absR.length >> 1]), realAbsP95Deg: r1(absR[Math.floor(absR.length * 0.95)]), realAbsMaxDeg: r1(absR[absR.length - 1]),
        gameAbsMedianDeg: r1(absG[absG.length >> 1]), gameAbsP95Deg: r1(absG[Math.floor(absG.length * 0.95)]), gameAbsMaxDeg: r1(absG[absG.length - 1]),
        oppositeSignStationsOver1p5Deg: opp, stations: pairs.length };
      const top = ci.map((i, k) => ({ s: st[i].s, real: sl[k], game: st[i].gb })).filter((q) => Number.isFinite(q.real));
      top.sort((a, b) => Math.abs(b.real) - Math.abs(a.real));
      entry.steepestCrossFall = [];
      for (const q of top) { if (entry.steepestCrossFall.length >= 8) break; if (entry.steepestCrossFall.some((o) => Math.abs(wrap(o.s - q.s + total / 2, total) - total / 2) < 60)) continue; entry.steepestCrossFall.push({ s: q.s, at: names(q.s), realDeg: r1(q.real), gameDeg: r1(q.game) }); }
    }
    res.sources[src.key] = entry;
  }
  // F1 live-timing car heights
  const ltf = resolve(HERE, 'out', `lt-${id}.json`);
  if (existsSync(ltf)) {
    const L = JSON.parse(readFileSync(ltf, 'utf8'));
    const h = st.map((q) => interp(L.s, L.z, q.s, total));
    refs.lt = h;
    const hmin = Math.min(...h), gr = gradeStats(h, total, names);
    res.sources.lt = { label: 'F1 live-timing car heights (Position Z, median of all cars, ' + L.source + ')', fit: L.fit, rangeM: r1(Math.max(...h) - hmin),
      maxClimb50: gr.maxClimb50, maxDescent50: gr.maxDescent50, maxClimb100: gr.maxClimb100, maxDescent100: gr.maxDescent100 };
  }
  // comparisons: game vs each reference (offset-free), and references against each other
  const cmp = (A, B) => {
    const d = A.map((v, i) => v - B[i]), mean = d.reduce((a, b) => a + b, 0) / d.length, dd = d.map((v) => v - mean);
    const rms = Math.sqrt(dd.reduce((a, b) => a + b * b, 0) / dd.length);
    let mi = 0; dd.forEach((v, i) => { if (Math.abs(v) > Math.abs(dd[mi])) mi = i; });
    const out = { rmsM: r2(rms), maxAbsM: r1(Math.abs(dd[mi])), maxAt: { s: mi * STEP, at: names(mi * STEP), sign: dd[mi] > 0 ? 'first higher' : 'first lower' } };
    for (const W of [50, 100]) {
      const k = Math.round(W / 2 / STEP), n = A.length;
      const gA = A.map((_, i) => (A[(i + k) % n] - A[(i - k + n) % n]) / (2 * k * STEP)), gB = B.map((_, i) => (B[(i + k) % n] - B[(i - k + n) % n]) / (2 * k * STEP));
      const dg = gA.map((v, i) => (v - gB[i]) * 100), absd = dg.map(Math.abs).sort((a, b) => a - b);
      out['grade' + W] = { rmsPP: r2(Math.sqrt(dg.reduce((a, b) => a + b * b, 0) / dg.length)), p95PP: r1(absd[Math.floor(absd.length * 0.95)]), maxPP: r1(absd[absd.length - 1]) };
      if (W === 100) {        // zones where |grade difference| > 2 pp for >= 50 m
        const z = []; let cur = null;
        dg.forEach((v, i) => {
          if (Math.abs(v) > 2) { if (!cur) cur = { from: i * STEP, to: i * STEP, max: v, at: i }; cur.to = i * STEP; if (Math.abs(v) > Math.abs(cur.max)) { cur.max = v; cur.at = i; } }
          else if (cur) { z.push(cur); cur = null; }
        });
        if (cur) z.push(cur);
        out.zonesOver2pp100m = z.filter((q) => q.to - q.from >= 50).map((q) => ({ from: q.from, to: q.to, at: names(q.at * STEP), firstPct: r1(gA[q.at] * 100), secondPct: r1(gB[q.at] * 100), diffPP: r1(q.max) }));
      }
    }
    return out;
  };
  res.compare = {};
  for (const [k, h] of Object.entries(refs)) res.compare['game_vs_' + k] = cmp(G, h);
  const keys = Object.keys(refs);
  for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) res.compare[keys[a] + '_vs_' + keys[b]] = cmp(refs[keys[a]], refs[keys[b]]);
  // profile table every 25 m (normalised: min 0)
  const norm = (h) => { const m = Math.min(...h); return h.map((v) => v - m); };
  const NR = Object.fromEntries(Object.entries(refs).map(([k, h]) => [k, norm(h)])), NG = norm(G);
  res.profile25m = st.filter((_, i) => i % 5 === 0).map((q, j) => {
    const i = j * 5, row = { s: q.s, game: r1(NG[i]) };
    for (const k of keys) row[k] = r1(NR[k][i]);
    return row;
  });
  res.snapToOsm = { stationsSnapped: st.filter((q) => q.snapD < 12).length, stations: st.length, maxSnapD: r1(Math.max(...st.map((q) => q.snapD))) };
  // every 10 m: [s, lat, lon, game y, <each reference, smoothed, absolute m>] (OSM-snapped station positions)
  res.stations10m = { columns: ['s', 'lat', 'lon', 'game', ...keys], rows: st.filter((_, i) => i % 2 === 0).map((q, j) => {
    const ll = p.from(...q.c), i = j * 2;
    return [q.s, +ll[0].toFixed(7), +ll[1].toFixed(7), r2(G[i]), ...keys.map((k) => r2(refs[k][i]))];
  }) };
  writeFileSync(resolve(HERE, 'out', `elev-${id}.json`), JSON.stringify(res, null, 1));
  console.log(`\n== ${id} ${game.name}: game range ${res.game.rangeM} m (dataset ${res.game.datasetElevRangeM}); climb50 ${res.game.maxClimb50.pct}% @${res.game.maxClimb50.s} ${res.game.maxClimb50.at}; descent50 ${res.game.maxDescent50.pct}% @${res.game.maxDescent50.s} ${res.game.maxDescent50.at}; climb100 ${res.game.maxClimb100.pct}% @${res.game.maxClimb100.s} ${res.game.maxClimb100.at}; descent100 ${res.game.maxDescent100.pct}% @${res.game.maxDescent100.s} ${res.game.maxDescent100.at}`);
  for (const [k, e] of Object.entries(res.sources)) {
    console.log(`  ${k}: range ${e.rangeM} m${e.absMinM !== undefined ? ` (${e.absMinM}..${e.absMaxM} ASL, holes ${e.holes})` : ''}; climb50 ${e.maxClimb50.pct}% @${e.maxClimb50.s} ${e.maxClimb50.at}; climb100 ${e.maxClimb100.pct}% @${e.maxClimb100.s} ${e.maxClimb100.at}; descent50 ${e.maxDescent50.pct}% @${e.maxDescent50.s} ${e.maxDescent50.at}; descent100 ${e.maxDescent100.pct}% @${e.maxDescent100.s} ${e.maxDescent100.at}`);
    if (e.crossSummary) console.log('    cross:', JSON.stringify(e.crossSummary), '\n    steepest:', JSON.stringify(e.steepestCrossFall));
  }
  for (const [k, c] of Object.entries(res.compare)) console.log(`  ${k}: rms ${c.rmsM} m max ${c.maxAbsM} m @${c.maxAt.s} ${c.maxAt.at} (${c.maxAt.sign}); grade100 rms ${c.grade100.rmsPP} p95 ${c.grade100.p95PP} max ${c.grade100.maxPP} pp; grade50 rms ${c.grade50.rmsPP} max ${c.grade50.maxPP}; zones>2pp: ${JSON.stringify(c.zonesOver2pp100m)}`);
}
