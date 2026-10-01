// node devtests/track-audit/mideast/audit.mjs <id> [<id> ...]   ->  devtests/track-audit/mideast/out/<id>-measure.json
// Measurements of the Middle-East audit (bh-2002, sa-2021, qa-2004, ae-2009); findings.mjs merges them with the
// sourced findings into devtests/track-audit/<id>.json. Read-only on the game files (tracks-data.js, js/track.js,
// scenery-data.js are loaded in node exactly as the game builds the track).
// References: OpenStreetMap raceway ways of the layout (cache/overpass, ODbL); F1 live-timing positions of the 2025
// qualifying (Z = road height of F1's track model) and the first 3 MB of the 2025 race (the grid); Copernicus GLO-30.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutAudit, loadOsm } from './layout.mjs';
import { elevAudit } from './elev.mjs';
import { ltProfile, gridIndex } from './ltprofile.mjs';
import { raceHead, gridFromHead } from './grid.mjs';
import { resampleLoop, nearestOnLoop, gradeWindows, corr, r1, r2, toLatLon } from './core.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));

export const CFG = {
  // relation 284538 "Bahrain Grand Prix Circuit" (type=circuit) = ways 4818385, 881756729, 881756728 (oneway, racing direction)
  'bh-2002': { rel: 284538, pitWays: [187123422], officialKm: 5.412 },
  // F1 lap = way 1007989410 + the southern ways (the "Formula E version" / chicane alternatives 1359884764, 1359884765 and the
  // FE hairpin 1359884755 left out; 1257884699 is the only way between its end nodes, so it is part of every layout)
  'sa-2021': { ways: [1007989410, 1359884757, 1257884699, 1359884761, 1359884760, 1359884759, 1359884758, 1359884756, 1359884762],
    pitWays: [1121870473, 1257884704, 1257884703], officialKm: 6.174 },
  // closed way 152483595 = the full circuit (MotoGP and F1 share it); F1 pit entry way 1037707300 + pit lane 196193732
  'qa-2004': { ways: [152483595], pitWays: [1037707300, 196193732], officialKm: 5.419 },
  'ae-2009': null,   // filled in once cache/overpass/ae-2009.json exists (see ae-cfg.json)
};
try { CFG['ae-2009'] = JSON.parse(readFileSync(resolve(HERE, 'ae-cfg.json'), 'utf8')); } catch (e) { /* not yet */ }

const BIN = 10;
const mmin = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity), mmax = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);

function segInter(a, b, c, d) {          // proper intersection of segments ab and cd -> t along ab or null
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

// distance of every point of P to the open/closed polyline Q (grid accelerated, Q densified to 2 m)
function distTo(P, Q) {
  const D = resampleLoop(Q, 2).pts, G = gridIndex(D, 20);
  return P.map((p) => G.near(p[0], p[1]).d);
}
function runsOver(vals, sAt, lim, minLen) {
  const out = []; let cur = null;
  vals.forEach((v, i) => {
    if (v > lim) { if (!cur) cur = { from: sAt(i), to: sAt(i), max: v, at: sAt(i) }; cur.to = sAt(i); if (v > cur.max) { cur.max = v; cur.at = sAt(i); } }
    else if (cur) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out.filter((r) => r.to - r.from >= minLen).map((r) => ({ fromS: Math.round(r.from), toS: Math.round(r.to), maxM: r1(r.max), atS: Math.round(r.at) }));
}
const stats = (a) => { const b = a.slice().sort((x, y) => x - y), n = b.length; return { meanM: r1(b.reduce((x, y) => x + y, 0) / n), p95M: r1(b[Math.floor(n * 0.95)]), maxM: r1(b[n - 1]) }; };

export async function audit(id) {
  const cfg = CFG[id];
  if (!cfg) throw new Error('no config for ' + id);
  const L = layoutAudit(id, cfg), pr = L._pr, tr = L._tr, td = L._td, g = td.geo;
  const els = loadOsm(id, cfg);
  // OSM loop at 2 m, s = 0 at the foot of the game's points[0]
  const R2 = resampleLoop(L._O, 2), k0 = Math.round(L._f0.s / R2.ds) % R2.pts.length;
  const O0 = R2.pts.slice(k0).concat(R2.pts.slice(0, k0)), total = R2.total;
  const cum = [0]; for (let i = 0; i < O0.length; i++) { const a = O0[i], b = O0[(i + 1) % O0.length]; cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const toS = (x, y) => { const q = nearestOnLoop(O0, x, y, cum), a = O0[q.i], b = O0[(q.i + 1) % O0.length]; return { s: q.s, d: q.d, side: ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1) }; };
  const atS = (s) => O0[Math.floor((((s % total) + total) % total) / R2.ds) % O0.length];
  const llAt = (s) => pr.inv(...atS(s)).map((v) => +v.toFixed(6));
  const pit = (cfg.pitWays || []).flatMap((w) => els.find((e) => e.id === w).geometry.map((q) => pr.f(q.lat, q.lon)));

  // ---- live timing
  const LT = await ltProfile(id, O0, pit.length ? pit : null);
  const { txt: head } = await raceHead(id);
  const grid = gridFromHead(head, LT._F, toS, total);

  // ---- geometry against F1's own reference line (LT path) and OSM
  const ltPath = LT.path.map((p) => [p[0], p[1]]);
  const gameToLt = distTo(L._S, ltPath), osmToLt = distTo(O0.filter((_, i) => i % 5 === 0), ltPath);
  const gS = (i) => tr.samples[i].s, oS = (i) => i * 5 * R2.ds;
  const geometry = {
    note: 'LT path = mean position per 10 m bin of the 2025 qualifying rows (F1 timing reference line, fitted to OSM by a similarity: see fit); distances in metres',
    fit: LT.fit,
    gameSamplesToLtPath: Object.assign(stats(gameToLt), { over10m: runsOver(gameToLt, gS, 10, 10) }),
    osmToLtPath: Object.assign(stats(osmToLt), { over10m: runsOver(osmToLt, oS, 10, 10) }),
    ltPathLengthM: Math.round(LT.path.reduce((a, p, i) => { const q = LT.path[(i + 1) % LT.path.length]; return a + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0)),
  };

  // ---- elevation: common 10 m bins along OSM from the game's start
  const E = await elevAudit(id, L);                                   // GLO-30 along the same OSM loop (E._s from the same start)
  const nb = LT.z.length, sB = LT.s;
  const interp = (S, H, s) => { const n = S.length, ds = S[1] - S[0]; let f = (s - S[0]) / ds; f = ((f % n) + n) % n; const i = Math.floor(f) % n, t = f - Math.floor(f); return H[i] + (H[(i + 1) % n] - H[i]) * t; };
  const glo = sB.map((s) => interp(E._s, E._clean, s));
  const gameY = sB.map((s) => { const p = atS(s); return tr.samples[nearestOnLoop(L._S, p[0], p[1]).i].y; });
  const lt = LT.z;
  const rel = (a) => { const m = mmin(a); return a.map((v) => r2(v - m)); };
  const prof = (h) => {
    const lo = mmin(h), hi = mmax(h), il = h.indexOf(lo), ih = h.indexOf(hi);
    return { rangeM: r1(hi - lo), lowest: { s: Math.round(sB[il]), ll: llAt(sB[il]) }, highest: { s: Math.round(sB[ih]), ll: llAt(sB[ih]) },
      grade50: gradeWindows(sB, h, nb * BIN, 50), grade100: gradeWindows(sB, h, nb * BIN, 100) };
  };
  const cmp = (a, b) => { const off = a.reduce((x, v, i) => x + v - b[i], 0) / nb; let w = { d: 0, s: 0 }; a.forEach((v, i) => { const d = v - b[i] - off; if (Math.abs(d) > Math.abs(w.d)) w = { d, s: sB[i] }; });
    return { correlation: r2(corr(a, b)), rmsAfterOffsetM: r2(Math.sqrt(a.reduce((x, v, i) => x + (v - b[i] - off) ** 2, 0) / nb)), worstDiffM: r1(w.d), worstAtS: Math.round(w.s), worstLL: llAt(w.s) }; };
  // grade differences over centred 100 m windows (game vs LT), sections over 2 percentage points
  const k5 = Math.round(50 / BIN), grad = (h) => h.map((_, i) => (h[(i + k5) % nb] - h[(i - k5 + nb) % nb]) / (2 * k5 * BIN) * 100);
  const gG = grad(gameY), gL = grad(lt), gO = grad(glo);
  const off = gameY.reduce((x, v, i) => x + v - lt[i], 0) / nb;
  const sections = []; let cur = null;
  for (let i = 0; i <= nb; i++) {
    const k = i % nb, d = gG[k] - gL[k], on = i < nb && Math.abs(d) > 2;
    if (on) { if (!cur) cur = { i0: i, max: d, at: i }; if (Math.abs(d) > Math.abs(cur.max)) { cur.max = d; cur.at = i; } cur.i1 = i; }
    else if (cur) { sections.push(cur); cur = null; }
  }
  const gradeDiffs = sections.filter((c) => (c.i1 - c.i0 + 1) * BIN >= 30).map((c) => {
    const k = c.at % nb, kind = Math.abs(gL[k]) < 1 && Math.abs(gG[k]) > 2 ? 'invented slope' : Math.sign(gG[k]) !== Math.sign(gL[k]) && Math.abs(gL[k]) > 1 ? 'reversed' : Math.abs(gG[k]) < Math.abs(gL[k]) ? 'flattened' : 'steepened';
    return { fromS: Math.round(sB[c.i0]), toS: Math.round(sB[c.i1 % nb]), atS: Math.round(sB[k]), atLL: llAt(sB[k]), gameGradePct: r1(gG[k]), ltGradePct: r1(gL[k]), glo30GradePct: r1(gO[k]), diffPP: r1(c.max), kind,
      gameMinusLtHeightM: r1(gameY[k] - lt[k] - off) };
  });
  const elevation = {
    binM: BIN, sNote: 's = metres along the OSM centreline from the foot of the game\'s points[0] (racing direction)',
    sources: { lt: LT.source, glo30: E.source, game: 'js/track.js samples (y) built from tracks-data.js elev (Copernicus GLO-90 via Open-Meteo, build-tracks smoothing), nearest sample to each OSM point' },
    lt: prof(lt), glo30: prof(glo), game: prof(gameY),
    gameVsLt: cmp(gameY, lt), glo30VsLt: cmp(glo, lt), gameVsGlo30: cmp(gameY, glo),
    gradeDiffsOver2pp: gradeDiffs,
    srtm30AlongGameLine: E.srtm30AlongGameLine,
    profile: { s: sB.map((v) => Math.round(v)), lt: rel(lt), glo30: rel(glo), game: rel(gameY), ltGrade100Pct: gL.map(r1), gameGrade100Pct: gG.map(r1) },
  };

  // ---- corners (game) with their place on the OSM lap and the game's bank
  const N = tr.samples.length, dsG = tr.length / N;
  const corners = L.corners.map((c) => { const i = Math.round(c.apexS / dsG) % N, q = toS(...L._S[i]); return Object.assign({ osmApexS: Math.round(q.s), apexLL: pr.inv(...L._S[i]).map((v) => +v.toFixed(6)) }, c); });

  // ---- bridges / tunnels / covered ways crossing the lap or the pit lane (OSM), and the game's scenery bridges
  const crossings = [];
  for (const e of els) {
    if (e.type !== 'way' || !e.geometry) continue;
    const t = e.tags || {};
    if (!(t.bridge || t.tunnel || t.covered || t.man_made === 'bridge' || t['building:part'] || (t.layer && t.highway !== 'raceway'))) continue;
    if ((cfg.ways && cfg.ways.includes(e.id)) || (cfg.pitWays || []).includes(e.id)) continue;
    const P = e.geometry.map((q) => pr.f(q.lat, q.lon));
    const closed = e.nodes && e.nodes[0] === e.nodes[e.nodes.length - 1];
    for (const [what, line] of [['lap', O0], ['pit lane', pit]]) {
      if (!line.length) continue;
      const nL = what === 'lap' ? line.length : line.length - 1;
      for (let a = 0; a < P.length - 1; a++) for (let b = 0; b < nL; b++) {
        const t2 = segInter(line[b], line[(b + 1) % line.length], P[a], P[a + 1]);
        if (t2 === null) continue;
        const x = line[b][0] + (line[(b + 1) % line.length][0] - line[b][0]) * t2, y = line[b][1] + (line[(b + 1) % line.length][1] - line[b][1]) * t2;
        crossings.push({ crosses: what, osmWay: e.id, tags: Object.fromEntries(Object.entries(t).filter(([k]) => /highway|bridge|tunnel|layer|covered|man_made|name|building|service|access/.test(k))),
          closedArea: !!closed, s: what === 'lap' ? Math.round(toS(x, y).s) : null, ll: pr.inv(x, y).map((v) => +v.toFixed(6)) });
      }
    }
  }
  const seen = new Set(), cross = crossings.filter((c) => { const k = c.osmWay + c.crosses + Math.round((c.s || 0) / 20); if (seen.has(k)) return false; seen.add(k); return true; });
  const scen = (() => { try { const w = {}; new Function('window', readFileSync(resolve(HERE, '..', '..', '..', 'scenery-data.js'), 'utf8'))(w); return w.F1_SCENERY[id]; } catch (e) { return null; } })();
  const sceneryBridges = (scen && scen.buildings || []).filter((b) => b.k === 'bridge').map((b) => {
    const P = b.p.map(([x, z]) => pr.f(...toLatLon(g, x, z)));
    const c = P.reduce((a, p) => [a[0] + p[0] / P.length, a[1] + p[1] / P.length], [0, 0]), q = toS(c[0], c[1]);
    return { h: b.h, centreLL: pr.inv(...c).map((v) => +v.toFixed(6)), nearestLapS: Math.round(q.s), distToLapCentreM: r1(q.d) };
  });

  // ---- start / grid
  const start = {
    gamePoint0LL: L.start.gamePoint0LL, gamePoint0OffOsmM: L.start.offOsmM,
    gamePoleBox: 'js/track.js: pole box front bar 8 m behind points[0], on the driver\'s LEFT (+n); boxes every 8 m, alternating sides',
    realGrid2025: grid && { startUtc: grid.startUtc, cars: grid.cars, poleS: grid.slots[0].sFromGameStartM, poleLL: llAt(grid.slots[0].sFromGameStartM), lastS: grid.slots[grid.slots.length - 1].sFromGameStartM,
      meanGapM: r1((grid.slots[0].sFromGameStartM - grid.slots[grid.slots.length - 1].sFromGameStartM) / (grid.slots.length - 1)), slots: grid.slots.map((q) => q.sFromGameStartM),
      note: 'timing positions lie on F1\'s 1-D reference line (no lateral information); s of each car standing on its grid slot just before lights out, 2025 race',
      proposedLineS: r1(grid.slots[0].sFromGameStartM + 8), proposedLineLL: llAt(grid.slots[0].sFromGameStartM + 8),
      proposedLineNote: 'js/track.js puts the pole box front bar 8 m behind the line: a line 8 m ahead of the 2025 pole car puts the game\'s pole box where the real pole car stood (+-5 m: the timing reference point on the car is not published)' },
  };

  // ---- elevation override per dataset point (LT Z relative to its lowest point), for tools/build-tracks.mjs
  const perPoint = td.points.map(([x, z]) => { const p = pr.f(...toLatLon(g, x, z)), q = toS(p[0], p[1]); return r1(interp(sB, lt, q.s) - mmin(lt)); });

  const out = {
    id, name: td.name, generated: new Date().toISOString(),
    layout: { osm: L.osm, lengths: Object.assign({}, L.lengths, { officialKm: cfg.officialKm, ltPathM: geometry.ltPathLengthM }), deviationGameVsOsm: L.deviation, direction: Object.assign({}, L.direction, { liveTiming: LT.direction }) },
    geometry, start, pit: { osm: L.pit, game: L.gamePit }, elevation, corners, crossings: cross, sceneryBridges,
    proposedElevPerPoint: { source: 'F1 live timing Z (2025 qualifying), relative to its lowest point, at each tracks-data.js point (index-aligned with points)', elev: perPoint },
  };
  mkdirSync(resolve(HERE, 'out'), { recursive: true });
  writeFileSync(resolve(HERE, 'out', id + '-measure.json'), JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const id of process.argv.slice(2)) {
    const o = await audit(id);
    const e = o.elevation;
    console.log(`== ${id} ${o.name}`);
    console.log('layout', JSON.stringify(o.layout));
    console.log('geometry', JSON.stringify(o.geometry));
    console.log('start', JSON.stringify(Object.assign({}, o.start, { realGrid2025: o.start.realGrid2025 && Object.assign({}, o.start.realGrid2025, { slots: undefined }) })));
    console.log('pit', JSON.stringify(o.pit));
    for (const k of ['lt', 'glo30', 'game']) console.log('elev', k, JSON.stringify(e[k]));
    console.log('cmp gameVsLt', JSON.stringify(e.gameVsLt), 'glo30VsLt', JSON.stringify(e.glo30VsLt));
    console.log('gradeDiffs'); console.table(e.gradeDiffsOver2pp);
    console.table(o.corners.map((c) => ({ osmS: c.osmApexS, dir: c.dir, turn: c.turnDeg, R: c.minRadiusM, bank: c.gameBankDeg })));
    console.log('crossings'); console.table(o.crossings.map((c) => ({ way: c.osmWay, crosses: c.crosses, s: c.s, tags: JSON.stringify(c.tags).slice(0, 90) })));
    console.log('sceneryBridges', JSON.stringify(o.sceneryBridges));
  }
}
