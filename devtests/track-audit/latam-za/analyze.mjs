// node devtests/track-audit/latam-za/analyze.mjs <id> [refName]
// Measurements for one circuit from out/game-<id>.json (game-dump.js), out/osm-<id>.json (osm-compare.mjs) and
// out/dem-<id>.json (dem-profiles.mjs) -> out/analysis-<id>.json:
//   per elevation profile (game, every DEM): range, highest / lowest point, steepest climb / descent over 50 m and 100 m
//     windows (where), after a light filter (DSM / SRTM: 5-point median then Gaussian sigma 15 m; contours: sigma 6 m;
//     game: none — it is already smooth)
//   game vs the reference profile: offset (median), RMS and max height difference, correlation, every stretch where
//     the 100 m grade differs by more than 2 percentage points (game flatter / steeper), named by the nearest OSM corner
//   corners of the game line (radius < 150 m) with direction, min radius, the game's bank there
//   OSM bridges / tunnels / covered ways that cross the game centreline (s, what, layer)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
const game = JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8'));
const dem = JSON.parse(readFileSync(resolve(HERE, 'out', `dem-${id}.json`), 'utf8'));
const osmFile = resolve(HERE, '..', 'cache', 'overpass', `${id}.json`);
const osm = existsSync(osmFile) ? JSON.parse(readFileSync(osmFile, 'utf8')) : { elements: [] };
const S = game.samples, N = S.length, L = game.trackLength, step = dem.step, M = dem.s.length;
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const lat0 = game.geo.lat0, lon0 = game.geo.lon0, KX = Math.cos(lat0 * Math.PI / 180) * 111320, KN = 110540;
const P = (lat, lon) => [(lon - lon0) * KX, (lat - lat0) * KN];
const ds = L / M;                                   // spacing of the profile points along the game lap (m)

// ---- corner names: the nearest named OSM raceway way (<= 25 m) of each profile point
const named = osm.elements.filter((e) => e.type === 'way' && e.geometry && e.tags && e.tags.highway === 'raceway' && (e.tags.name || e.tags['raceway:corner_number']) && !/pit|kart|aut[oó]dromo|grand prix circuit/i.test((e.tags.name || '') + (e.tags.sport || '')))
  .map((w) => ({ name: (w.tags['raceway:corner_number'] ? 'T' + w.tags['raceway:corner_number'] + ' ' : '') + (w.tags.name || ''), g: w.geometry.map((q) => P(q.lat, q.lon)) }));
const nameAt = dem.ll.map(([la, lo]) => {
  const p = P(la, lo); let best = { d: 25, n: null };
  for (const w of named) for (let k = 0; k + 1 < w.g.length; k++) {
    const a = w.g[k], b = w.g[k + 1], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / l2)) : 0;
    const d = Math.hypot(a[0] + ex * t - p[0], a[1] + ez * t - p[1]);
    if (d < best.d) best = { d, n: w.name };
  }
  return best.n;
});
const where = (j) => ({ s: r1(dem.s[j]), ll: dem.ll[j], near: nameAt[j] || undefined });

// ---- filters on the closed profile
const wrap = (j) => ((j % M) + M) % M;
function fill(a) {                     // nulls linearly from neighbours
  const h = a.slice();
  for (let j = 0; j < M; j++) if (h[j] === null) {
    let p = j, q = j, dp = 0, dq = 0;
    while (a[wrap(p)] === null && dp < M) { p--; dp++; }
    while (a[wrap(q)] === null && dq < M) { q++; dq++; }
    h[j] = a[wrap(p)] + (a[wrap(q)] - a[wrap(p)]) * dp / (dp + dq);
  }
  return h;
}
function median(a, half) { return a.map((_, j) => { const w = []; for (let k = -half; k <= half; k++) w.push(a[wrap(j + k)]); w.sort((x, y) => x - y); return w[half]; }); }
function gauss(a, sigmaM) {
  const sg = sigmaM / ds, r = Math.ceil(3 * sg), k = []; let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sg) ** 2); k.push(v); sum += v; }
  return a.map((_, j) => { let acc = 0; for (let i = -r; i <= r; i++) acc += k[i + r] * a[wrap(j + i)]; return acc / sum; });
}
const prep = (name, a) => {
  if (name === 'game') return a.slice();
  if (name === 'geosampa') return gauss(fill(a), 6);
  return gauss(median(fill(a), 2), 15);
};

// ---- profile statistics
function grades(h, W) { const k = Math.max(1, Math.round(W / 2 / ds)); return h.map((_, j) => (h[wrap(j + k)] - h[wrap(j - k)]) / (2 * k * ds)); }
function extremes(g, count, sign) {   // the `count` largest (sign +1) / most negative (-1) separated by >= 150 m
  const idx = g.map((v, j) => j).sort((a, b) => sign * (g[b] - g[a])), picked = [];
  for (const j of idx) {
    if (picked.length >= count || sign * g[j] <= 0) break;
    if (picked.every((p) => Math.min(Math.abs(p - j), M - Math.abs(p - j)) * ds >= 150)) picked.push(j);
  }
  return picked.map((j) => Object.assign({ gradePct: r1(g[j] * 100) }, where(j)));
}
function stats(h) {
  let lo = 0, hi = 0; for (let j = 0; j < M; j++) { if (h[j] < h[lo]) lo = j; if (h[j] > h[hi]) hi = j; }
  const g50 = grades(h, 50), g100 = grades(h, 100);
  return { min: r2(h[lo]), max: r2(h[hi]), range: r2(h[hi] - h[lo]), lowest: where(lo), highest: where(hi),
    climbs50: extremes(g50, 4, 1), descents50: extremes(g50, 4, -1), climbs100: extremes(g100, 4, 1), descents100: extremes(g100, 4, -1) };
}
const profiles = { game: dem.game, ...dem.profiles };
const prepped = {}, st = {};
for (const [k, a] of Object.entries(profiles)) if (a) { prepped[k] = prep(k, a); st[k] = stats(prepped[k]); }

// ---- game vs each reference
function compare(ref) {
  const g = prepped.game, h = prepped[ref], d = h.map((v, j) => v - g[j]);
  const off = [...d].sort((a, b) => a - b)[M >> 1], e = d.map((v) => v - off);
  let rms = 0, mx = 0, mj = 0; e.forEach((v, j) => { rms += v * v; if (Math.abs(v) > Math.abs(mx)) { mx = v; mj = j; } });
  const mg = g.reduce((a, v) => a + v, 0) / M, mh = h.reduce((a, v) => a + v, 0) / M;
  let sxy = 0, sxx = 0, syy = 0; for (let j = 0; j < M; j++) { sxy += (g[j] - mg) * (h[j] - mh); sxx += (g[j] - mg) ** 2; syy += (h[j] - mh) ** 2; }
  const gg = grades(g, 100), gh = grades(h, 100), runs = [];
  for (let j = 0, on = false, a = 0; j <= M; j++) {
    const bad = j < M && Math.abs(gh[j] - gg[j]) > 0.02;
    if (bad && !on) { on = true; a = j; }
    if (!bad && on) {
      on = false; let m = a; for (let k = a; k < j; k++) if (Math.abs(gh[k] - gg[k]) > Math.abs(gh[m] - gg[m])) m = k;
      runs.push({ from_s: r1(dem.s[a]), to_s: r1(dem.s[j - 1]), length: r1((j - a) * ds), at: where(m), refGradePct: r1(gh[m] * 100), gameGradePct: r1(gg[m] * 100),
        diffPp: r1((gh[m] - gg[m]) * 100), what: Math.abs(gg[m]) < Math.abs(gh[m]) ? (Math.sign(gg[m]) !== Math.sign(gh[m]) && Math.abs(gg[m]) > 0.005 ? 'game slope has the wrong sign' : 'game flatter') : 'game steeper / invented slope' });
    }
  }
  return { offsetM: r2(off), rmsM: r2(Math.sqrt(rms / M)), maxDiffM: r2(mx), maxDiffAt: where(mj), correlation: r2(sxy / Math.sqrt(sxx * syy)),
    grade100DiffOver2pp: runs.filter((r) => r.length >= 20) };
}
const refs = Object.keys(prepped).filter((k) => k !== 'game');
const comparisons = Object.fromEntries(refs.map((k) => [k, compare(k)]));
// consensus: stretches where EVERY independent reference differs from the game's 100 m grade by > 2 pp in the same
// direction (mapzen = SRTM outside Mexico's INEGI coverage; it is left out when it repeats srtm30m)
const indep = refs.filter((k) => !(k === 'mapzen' && dem.profiles.srtm30m && dem.profiles.mapzen.every((v, j) => v === dem.profiles.srtm30m[j])));
let consensus = [];
if (indep.length >= 2) {
  const gg = grades(prepped.game, 100), gr = indep.map((k) => grades(prepped[k], 100));
  const flag = gg.map((g, j) => { const ds_ = gr.map((a) => a[j] - g); return ds_.every((v) => v > 0.02) ? 1 : ds_.every((v) => v < -0.02) ? -1 : 0; });
  for (let j = 0, on = 0, a = 0; j <= M; j++) {
    const f = j < M ? flag[j] : 0;
    if (f !== on) {
      if (on) {
        let m = a; for (let k = a; k < j; k++) if (Math.abs(gr[0][k] - gg[k]) > Math.abs(gr[0][m] - gg[m])) m = k;
        if ((j - a) * ds >= 20) consensus.push({ from_s: r1(dem.s[a]), to_s: r1(dem.s[j - 1]), length: r1((j - a) * ds), at: where(m), gameGradePct: r1(gg[m] * 100),
          refGradePct: Object.fromEntries(indep.map((k, q) => [k, r1(gr[q][m] * 100)])), what: on > 0 ? 'game lower grade than every reference (flatter climb / steeper descent)' : 'game higher grade than every reference (steeper climb / flatter descent)' });
      }
      on = f; a = j;
    }
  }
}

// ---- corners of the game line and their bank
const corners = [];
{
  const R = S.map((q) => (Math.abs(q.curv) > 1e-6 ? 1 / Math.abs(q.curv) : 1e6));
  for (let i = 0, on = false, a = 0; i <= N; i++) {
    const c = i < N && R[i] < 150;
    if (c && !on) { on = true; a = i; }
    if (!c && on) {
      on = false; if ((i - a) * game.ds < 8) continue;
      let m = a, turn = 0, bmax = 0; for (let k = a; k < i; k++) { if (R[k] < R[m]) m = k; turn += S[k].curv * game.ds; if (Math.abs(S[k].bankDeg) > Math.abs(bmax)) bmax = S[k].bankDeg; }
      const j = Math.round(m / step) % M;
      corners.push({ from_s: r1(S[a].s), to_s: r1(S[i - 1].s), dir: turn > 0 ? 'left' : 'right', turnDeg: Math.round(Math.abs(turn) * 180 / Math.PI), minRadiusM: r1(R[m]), at: S[m].ll, near: nameAt[j] || undefined, gameBankDeg: r1(bmax) });
    }
  }
}
// signed turning: total (+ = left)
let totalTurn = 0; for (const q of S) totalTurn += q.curv * game.ds;

// ---- bridges / tunnels crossing the centreline
const G = S.map((q) => P(q.ll[0], q.ll[1]));
function segX(a, b, c, d) {
  const r0 = b[0] - a[0], q0 = b[1] - a[1], s0 = d[0] - c[0], s1 = d[1] - c[1], den = r0 * s1 - q0 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den, u = ((c[0] - a[0]) * q0 - (c[1] - a[1]) * r0) / den;
  return t >= 0 && t < 1 && u >= 0 && u <= 1 ? t : null;
}
const crossings = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type !== 'way' || !e.geometry || t.highway === 'raceway') continue;
  if (!(t.bridge || t.tunnel || t.covered === 'yes' || t.man_made === 'bridge')) continue;
  const g = e.geometry.map((q) => P(q.lat, q.lon)), closed = t.man_made === 'bridge';
  for (let k = 0; k + 1 < g.length; k++) for (let i = 0; i < N; i++) {
    const x = segX(G[i], G[(i + 1) % N], g[k], g[k + 1]);
    if (x !== null) crossings.push({ way: e.id, s: r1(S[i].s + x * game.ds), at: S[i].ll, tags: Object.fromEntries(Object.entries(t).filter(([key]) => /bridge|tunnel|covered|layer|highway|railway|name|man_made|footway|level/.test(key))) });
  }
}
// scenery-data bridges near each crossing (does the game draw a deck there?)
let sceneryBridges = [];
try {
  globalThis.window = globalThis;
  new Function(readFileSync(resolve(HERE, '..', '..', '..', 'scenery-data.js'), 'utf8'))();
  const sc = globalThis.F1_SCENERY && globalThis.F1_SCENERY[id];
  if (sc && sc.buildings) sceneryBridges = sc.buildings.filter((b) => b.k === 'bridge').map((b) => {
    let cx = 0, cz = 0; for (const p of b.p) { cx += p[0]; cz += p[1]; } cx /= b.p.length; cz /= b.p.length;
    let bi = 0, bd = Infinity; S.forEach((q, i) => { const d = Math.hypot(q.x - cx, q.z - cz); if (d < bd) { bd = d; bi = i; } });
    return { s: r1(S[bi].s), distFromCentrelineM: r1(bd), h: b.h };
  });
} catch (e) { sceneryBridges = 'scenery-data.js not read: ' + e.message; }
const out = { id, name: game.name, gameLengthM: game.trackLength, profilePoints: M, profileSpacingM: r2(ds), lineSrc: dem.lineSrc, sources: dem.sources,
  profileFilters: { game: 'none (js/track.js samples)', geosampa: 'Gaussian sigma 6 m', other: '5-point (~25 m) median, then Gaussian sigma 15 m' },
  stats: st, comparisons, consensusRefs: indep, consensus, totalTurnDeg: Math.round(totalTurn * 180 / Math.PI), corners, crossings, sceneryBridges,
  maxGameBankDeg: game.maxBankDeg };
writeFileSync(resolve(HERE, 'out', `analysis-${id}.json`), JSON.stringify(out, null, 1));
// ---- console summary
console.log(`${id} ${game.name}: ${M} points every ${r1(ds)} m; total turning ${out.totalTurnDeg} deg (${out.totalTurnDeg > 0 ? 'anticlockwise' : 'clockwise'})`);
for (const [k, v] of Object.entries(st)) console.log(`  ${k.padEnd(9)} range ${String(v.range).padStart(6)} m  low s ${v.lowest.s} (${v.lowest.near || ''})  high s ${v.highest.s} (${v.highest.near || ''})  ` +
  `climb100 ${v.climbs100.slice(0, 2).map((c) => c.gradePct + '%@' + c.s + (c.near ? ' ' + c.near : '')).join(', ')}  descent100 ${v.descents100.slice(0, 2).map((c) => c.gradePct + '%@' + c.s + (c.near ? ' ' + c.near : '')).join(', ')}`);
for (const [k, c] of Object.entries(comparisons)) {
  console.log(`  game vs ${k}: offset ${c.offsetM} m, RMS ${c.rmsM} m, max ${c.maxDiffM} m at s ${c.maxDiffAt.s} (${c.maxDiffAt.near || ''}), r ${c.correlation}`);
  for (const r of c.grade100DiffOver2pp) console.log(`     grade100 diff: s ${r.from_s}..${r.to_s} (${r.length} m) ${r.what}: ref ${r.refGradePct}% game ${r.gameGradePct}% at s ${r.at.s} ${r.at.near || ''}`);
}
for (const c of consensus) console.log(`  CONSENSUS s ${c.from_s}..${c.to_s} (${c.length} m) ${c.what}: game ${c.gameGradePct}% refs ${JSON.stringify(c.refGradePct)} at s ${c.at.s} ${c.at.near || ''}`);
console.log(`  corners (R<150): ${corners.length}; bank |max| ${game.maxBankDeg} deg; crossings: ${crossings.length}; scenery bridges: ${Array.isArray(sceneryBridges) ? sceneryBridges.length : sceneryBridges}`);
for (const c of crossings) console.log(`     crossing s ${c.s} way ${c.way} ${JSON.stringify(c.tags)}`);
