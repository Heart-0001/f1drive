// node devtests/track-audit/be-nl-de-gb/audit.mjs <id>  -> devtests/track-audit/be-nl-de-gb/out/measure-<id>.json
// Measures the game's circuit (out/game-<id>.json, from dump-game.js = the game's own tracks-data.js + js/track.js)
// against OpenStreetMap (cached Overpass response) and a lidar terrain model sampled along the OSM centreline:
// layout deviation both ways, length, direction, start / finish, pit lane ends and side, elevation profile and
// windowed grades, cross slope (bank) measured from the lidar at +-OFF m, covered / bridged ways crossing the lap.
import { resolve } from 'node:path';
import { HERE, game, osm, proj, cumLen, nearestOn, pointAt, resample, grades, medianLoop, gaussLoop, fillNulls, writeJSON } from './lib.mjs';
import { osmLoop } from './osmline.mjs';
import * as DEM from './dem.mjs';
import { CFG } from './config.mjs';

const id = process.argv[2];
const cfg = CFG[id];
if (!cfg) throw new Error('no config for ' + id);
const G = game(id), J = osm(id);
const STEP = 5;                 // m, DEM sampling along the OSM centreline
const OFF = cfg.crossOff || 4;  // m, cross-slope half base

// ---------------------------------------------------------------- OSM loop
let only = cfg.only || null;
const rel = cfg.rel ? J.elements.find((e) => e.type === 'relation' && e.id === cfg.rel) : null;
if (rel && !only) only = rel.members.filter((m) => m.type === 'way' && !/pit/.test(m.role)).map((m) => m.ref);
const O = osmLoop(id, { first: cfg.first, rev: !!cfg.rev, only, exclude: cfg.exclude, extra: cfg.extra });
if (!O.closed) throw new Error(`${id}: OSM chain not closed (gap ${O.gap.toFixed(1)} m), ways ${O.ways.map((w) => w.id).join(',')}`);
const P = O.P;
const wayAt = (s) => { for (let k = O.ways.length - 1; k >= 0; k--) if (O.cum[O.ways[k].from] <= s + 1e-6) return O.ways[k]; return O.ways[0]; };
const named = (s) => {        // nearest named way (within 150 m) for a readable location
  const L = O.L; let best = null, bd = Infinity;
  for (const w of O.ways) {
    if (!w.name) continue;
    const a = O.cum[w.from], b = w.to >= O.cum.length - 1 ? L : O.cum[w.to];
    const d = s >= a && s <= b ? 0 : Math.min(Math.abs(s - a), Math.abs(s - b), L - Math.abs(s - a), L - Math.abs(s - b));
    if (d < bd) { bd = d; best = w; }
  }
  return best && bd < 150 ? (bd === 0 ? best.name : `${Math.round(bd)} m from ${best.name}`) : '';
};

// ---------------------------------------------------------------- game samples in the same projection
const S = G.samples, N = S.length;
const gxy = S.map((q) => P.fwd(q.lat, q.lon));
const gcum = cumLen(gxy);
const gL = gcum[gcum.length - 1];

// game -> OSM
const g2o = gxy.map((q) => nearestOn(O.xy, O.cum, q));
// OSM (5 m) -> game
const OR = resample(O.xy, STEP);
const o2g = OR.pts.map((q) => nearestOn(gxy, gcum, q));
const stat = (arr) => { const a = arr.slice().sort((p, q) => p - q); return { max: +a[a.length - 1].toFixed(1), mean: +(a.reduce((p, q) => p + q, 0) / a.length).toFixed(2), p95: +a[Math.floor(a.length * 0.95)].toFixed(1) }; };
function worst(dists, sArr, sep, count, label) {
  const idx = [...dists.keys()].sort((a, b) => dists[b] - dists[a]), out = [];
  for (const i of idx) {
    if (dists[i] < 3) break;
    if (out.every((o) => Math.abs(o.i - i) * (sep.ds) >= sep.m)) out.push({ i, d: +dists[i].toFixed(1), at: label(i) });
    if (out.length >= count) break;
  }
  return out.map(({ i, ...r }) => r);
}
const devGame = stat(g2o.map((r) => r.d)), devOsm = stat(o2g.map((r) => r.d));
const worstGame = worst(g2o.map((r) => r.d), null, { ds: G.ds, m: 200 }, 5, (i) => ({ gameS: Math.round(S[i].s), osmS: Math.round(g2o[i].s), near: named(g2o[i].s) }));
const worstOsm = worst(o2g.map((r) => r.d), null, { ds: OR.ds, m: 200 }, 5, (i) => ({ osmS: Math.round(i * OR.ds), gameS: Math.round(o2g[i].s), near: named(i * OR.ds), lat: +P.inv(...OR.pts[i])[0].toFixed(6), lon: +P.inv(...OR.pts[i])[1].toFixed(6) }));

// direction: game tangent vs OSM segment direction at the nearest point
let agree = 0;
for (let i = 0; i < N; i++) {
  const a = gxy[i], b = gxy[(i + 1) % N], tx = b[0] - a[0], ty = b[1] - a[1];
  if (tx * g2o[i].tx + ty * g2o[i].ty > 0) agree++;
}
// OSM s of the game's s = 0, and the mapping game s -> OSM s (unwrapped, monotone where directions agree)
const osmS0 = g2o[0].s;
const toOsmS = (gs) => { const i = Math.round(gs / G.ds) % N; return g2o[(i + N) % N].s; };
const rel0 = (s) => { let d = s - osmS0; d = ((d % O.L) + O.L) % O.L; return d > O.L / 2 ? d - O.L : d; };  // OSM s relative to the game's line

// ---------------------------------------------------------------- start / finish nodes
const sfNodes = J.elements.filter((e) => e.type === 'node' && e.tags && (/start|finish/i.test(e.tags.raceway || '') || /^(start|finish|start\/finish|start-finish|finish line|start line)$/i.test(e.tags.name || '')));
if (rel) for (const m of rel.members) if (m.type === 'node' && /start|finish/i.test(m.role) && !sfNodes.some((n) => n.id === m.ref)) sfNodes.push({ id: m.ref, lat: m.lat, lon: m.lon, tags: { relationRole: m.role } });
const startFinish = sfNodes.map((n) => {
  const q = P.fwd(n.lat, n.lon), og = nearestOn(gxy, gcum, q), oo = nearestOn(O.xy, O.cum, q);
  let d = og.s; if (d > gL / 2) d -= gL;
  return { node: n.id, tags: n.tags, lat: n.lat, lon: n.lon, offTrackM: +og.d.toFixed(1), gameS: +d.toFixed(1), osmS: +oo.s.toFixed(1),
    note: `${Math.abs(d).toFixed(0)} m ${d >= 0 ? 'after' : 'before'} the game's line (game s = 0)` };
});

// ---------------------------------------------------------------- pit lane ways (OSM)
const pitRole = new Set(rel ? rel.members.filter((m) => m.type === 'way' && /pit/i.test(m.role)).map((m) => m.ref) : []);
const PITRE = /(^|[\s_-])pit([\s_-]|$)|pit ?lane|boxengasse|pitstraat|pitstrasse/i;
const pitWays = J.elements.filter((e) => e.type === 'way' && e.geometry && e.tags && (cfg.pitWays ? cfg.pitWays.includes(e.id) :
  (pitRole.has(e.id) || ((PITRE.test(e.tags.name || '') || PITRE.test(e.tags['name:en'] || '') || /pit/i.test(e.tags.service || '') || /pit/i.test(e.tags.raceway || '')) &&
    (e.tags.highway || e.tags.raceway) && !/kart/i.test(e.tags.sport || '')))));
const pit = pitWays.map((w) => {
  const g = w.geometry, a = P.fwd(g[0].lat, g[0].lon), b = P.fwd(g[g.length - 1].lat, g[g.length - 1].lon);
  const mid = P.fwd(g[g.length >> 1].lat, g[g.length >> 1].lon);
  const na = nearestOn(gxy, gcum, a), nb = nearestOn(gxy, gcum, b), nm = nearestOn(gxy, gcum, mid);
  const wrap = (s) => (s > gL / 2 ? s - gL : s);
  let len = 0; for (let k = 1; k < g.length; k++) { const p = P.fwd(g[k - 1].lat, g[k - 1].lon), q = P.fwd(g[k].lat, g[k].lon); len += Math.hypot(q[0] - p[0], q[1] - p[1]); }
  return { way: w.id, tags: w.tags, lengthM: Math.round(len), startGameS: Math.round(wrap(na.s)), startOffM: +na.d.toFixed(1), endGameS: Math.round(wrap(nb.s)), endOffM: +nb.d.toFixed(1),
    midSide: nm.side > 0 ? 'left' : 'right', midOffM: +nm.d.toFixed(1), midGameS: Math.round(wrap(nm.s)) };
});
const gp = G.pit ? { side: G.pit.side > 0 ? 'left' : 'right', limitKmh: G.pit.limitKmh, laneFromS: Math.round(G.pit.fromS > gL / 2 ? G.pit.fromS - gL : G.pit.fromS),
  laneToS: Math.round(G.pit.toS > gL / 2 ? G.pit.toS - gL : G.pit.toS), entryS: Math.round(G.pit.entryS > gL / 2 ? G.pit.entryS - gL : G.pit.entryS),
  exitS: Math.round(G.pit.exitS > gL / 2 ? G.pit.exitS - gL : G.pit.exitS), boxes: G.pit.boxes } : null;

// ---------------------------------------------------------------- bridges / tunnels crossing or carrying the lap
function segX(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d, u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
const loopIds = new Set(O.ways.map((w) => w.id));
const structures = [];
for (const w of J.elements) {
  if (w.type !== 'way' || !w.geometry || !w.tags) continue;
  const t = w.tags, isStruct = t.bridge || t.tunnel || t.covered === 'yes' || t.man_made === 'bridge' || t.building === 'bridge';
  if (!isStruct) continue;
  const g = w.geometry.map((p) => P.fwd(p.lat, p.lon));
  if (loopIds.has(w.id)) { structures.push({ way: w.id, tags: t, kind: 'the lap itself', osmS: Math.round(nearestOn(O.xy, O.cum, g[0]).s) }); continue; }
  for (let k = 0; k + 1 < g.length; k++) for (let i = 0; i < O.xy.length; i++) {
    const tt = segX(O.xy[i], O.xy[(i + 1) % O.xy.length], g[k], g[k + 1]);
    if (tt === null) continue;
    const s = O.cum[i] + tt * (O.cum[i + 1] - O.cum[i]);
    if (!structures.some((x) => x.way === w.id)) structures.push({ way: w.id, tags: t, kind: (t.layer && +t.layer < 0) || t.tunnel ? 'passes under the lap' : 'crosses over the lap', osmS: Math.round(s), near: named(s), gameS: Math.round(rel0(s)) });
  }
}

// ---------------------------------------------------------------- elevation
const ll = OR.pts.map(([x, y]) => P.inv(x, y));
const M = OR.pts.length;
const tang = OR.pts.map((p, i) => { const a = OR.pts[(i - 1 + M) % M], b = OR.pts[(i + 1) % M], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; });
const left = OR.pts.map((p, i) => P.inv(p[0] - tang[i][1] * OFF, p[1] + tang[i][0] * OFF));
const right = OR.pts.map((p, i) => P.inv(p[0] + tang[i][1] * OFF, p[1] - tang[i][0] * OFF));
const sampler = DEM[cfg.dem];
const rawC = await sampler(ll);
let rawL = null, rawR = null;
if (cfg.cross !== false) {
  const every = cfg.crossEvery || 2;     // cross-slope every `every` samples
  const pick = (arr) => arr.filter((_, i) => i % every === 0);
  const hl = await sampler(pick(left)), hr = await sampler(pick(right));
  rawL = new Array(M).fill(null); rawR = new Array(M).fill(null);
  pick([...Array(M).keys()]).forEach((i, k) => { rawL[i] = hl[k]; rawR[i] = hr[k]; });
}
// covered / bridged stretches of the lap where a DTM reads the wrong surface: straight between ends
const holes = rawC.filter((v) => v === null || !Number.isFinite(v)).length;
let hc = fillNulls(rawC);
const coveredNotes = [];
for (const c of cfg.covered || []) {
  const a = Math.round(c.fromS / OR.ds), b = Math.round(c.toS / OR.ds);
  const ya = hc[(a - 1 + M) % M], yb = hc[(b + 1) % M];
  for (let i = a; i <= b; i++) hc[i % M] = ya + (yb - ya) * (i - a) / (b - a);
  coveredNotes.push(c);
}
const real = gaussLoop(medianLoop(hc, 2), 1.0);     // 25 m median (kerbs, drains, a verge sample) + sigma 5 m
const realMin = Math.min(...real), realMax = Math.max(...real);
// game height on the OSM grid: nearest game sample's y (interpolated along the game polyline)
const gameY = o2g.map((r) => { const f = r.s / G.ds, i0 = Math.floor(f) % N, t = f - Math.floor(f); return S[i0].y + (S[(i0 + 1) % N].y - S[i0].y) * t; });
const off = real.reduce((a, v, i) => a + v - gameY[i], 0) / M;
const diff = real.map((v, i) => gameY[i] + off - v);
const gameMin = Math.min(...gameY), gameMax = Math.max(...gameY);
const gr = {};
for (const w of [50, 100]) {
  const r = grades(real, OR.ds, w), g = grades(gameY, OR.ds, w);
  const top = (arr, sign, count = 4) => {
    const idx = [...arr.keys()].sort((a, b) => sign * (arr[b] - arr[a])), out = [];
    for (const i of idx) { if (out.every((j) => Math.min(Math.abs(i - j), M - Math.abs(i - j)) * OR.ds >= 200)) out.push(i); if (out.length >= count) break; }
    return out.map((i) => ({ osmS: Math.round(i * OR.ds), fromLine: Math.round(rel0(i * OR.ds)), near: named(i * OR.ds), realPct: +(r[i] * 100).toFixed(1), gamePct: +(g[i] * 100).toFixed(1) }));
  };
  gr[w] = { realMaxPct: +(Math.max(...r) * 100).toFixed(1), realMinPct: +(Math.min(...r) * 100).toFixed(1), gameMaxPct: +(Math.max(...g) * 100).toFixed(1), gameMinPct: +(Math.min(...g) * 100).toFixed(1),
    steepestClimbsReal: top(r, 1), steepestDescentsReal: top(r, -1), steepestClimbsGame: top(g, 1).map((o) => ({ ...o })), steepestDescentsGame: top(g, -1) };
  // flattened / invented: runs where |game - real| > 2 percentage points (100 m window only)
  if (w === 100) {
    const runs = []; let cur = null;
    for (let i = 0; i <= M; i++) {
      const k = i % M, dlt = (g[k] - r[k]) * 100, bad = i < M && Math.abs(dlt) > 2;
      if (bad && !cur) cur = { a: i, worst: dlt, wi: i };
      else if (bad && cur) { if (Math.abs(dlt) > Math.abs(cur.worst)) { cur.worst = dlt; cur.wi = i; } }
      else if (!bad && cur) { cur.b = i - 1; runs.push(cur); cur = null; }
    }
    gr.mismatchRuns = runs.filter((q) => (q.b - q.a + 1) * OR.ds >= 30).map((q) => ({ osmFrom: Math.round(q.a * OR.ds), osmTo: Math.round(q.b * OR.ds), fromLine: Math.round(rel0(q.a * OR.ds)), lengthM: Math.round((q.b - q.a + 1) * OR.ds),
      near: named(q.wi * OR.ds), worstPP: +q.worst.toFixed(1), real: +(r[q.wi] * 100).toFixed(1), game: +(g[q.wi] * 100).toFixed(1), kind: Math.abs(g[q.wi]) < Math.abs(r[q.wi]) ? 'flattened' : 'steeper / invented' }));
  }
}
// named features: real vs game height change and max grade over each named OSM way (+-0)
const features = O.ways.filter((w) => w.name).map((w) => {
  const a = Math.round(O.cum[w.from] / OR.ds), b = Math.round((w.to >= O.cum.length - 1 ? O.L : O.cum[w.to]) / OR.ds);
  const r50 = grades(real, OR.ds, 50), g50 = grades(gameY, OR.ds, 50);
  let rmx = -1, rmn = 1, gmx = -1, gmn = 1;
  for (let i = a; i <= b; i++) { const k = i % M; rmx = Math.max(rmx, r50[k]); rmn = Math.min(rmn, r50[k]); gmx = Math.max(gmx, g50[k]); gmn = Math.min(gmn, g50[k]); }
  return { name: w.name, way: w.id, osmFrom: Math.round(a * OR.ds), lengthM: Math.round((b - a) * OR.ds), realRise: +(real[b % M] - real[a % M]).toFixed(1), gameRise: +(gameY[b % M] - gameY[a % M]).toFixed(1),
    real50MaxPct: +(rmx * 100).toFixed(1), real50MinPct: +(rmn * 100).toFixed(1), game50MaxPct: +(gmx * 100).toFixed(1), game50MinPct: +(gmn * 100).toFixed(1) };
});

// cross slope (lidar) vs game bank
let cross = null;
if (rawL) {
  const meas = [], cmp = [];
  for (let i = 0; i < M; i++) {
    if (rawL[i] === null || rawR[i] === null || !Number.isFinite(rawL[i]) || !Number.isFinite(rawR[i])) continue;
    const deg = Math.atan((rawL[i] - rawR[i]) / (2 * OFF)) * 180 / Math.PI;   // < 0: left side lower (game convention)
    const gi = Math.round(o2g[i].s / G.ds) % N, gb = S[gi].bank;
    meas.push({ i, deg, gb });
  }
  // smooth over 3 measurements (median) to drop single kerb / verge hits
  const md = meas.map((m, k) => { const w = [meas[(k - 1 + meas.length) % meas.length].deg, m.deg, meas[(k + 1) % meas.length].deg].sort((p, q) => p - q); return { ...m, md: w[1] }; });
  // list the stretches where either the lidar or the game has more than 3 deg
  const runs = []; let cur = null;
  for (const m of md) {
    const hit = Math.abs(m.md) >= 3 || Math.abs(m.gb) >= 3;
    if (hit && !cur) cur = { a: m.i, b: m.i, maxReal: m.md, maxGame: m.gb, sumR: m.md, sumG: m.gb, n: 1 };
    else if (hit && cur && m.i - cur.b <= 4) { cur.b = m.i; cur.n++; cur.sumR += m.md; cur.sumG += m.gb; if (Math.abs(m.md) > Math.abs(cur.maxReal)) cur.maxReal = m.md; if (Math.abs(m.gb) > Math.abs(cur.maxGame)) cur.maxGame = m.gb; }
    else if (cur) { runs.push(cur); cur = hit ? { a: m.i, b: m.i, maxReal: m.md, maxGame: m.gb, sumR: m.md, sumG: m.gb, n: 1 } : null; }
  }
  if (cur) runs.push(cur);
  cross = { halfBaseM: OFF, note: 'lidar cross slope = atan((h(left) - h(right)) / (2 * halfBase)), negative = left side lower; game bank = samples[i].bank (same sign convention); median of 3 measurements',
    stretches: runs.filter((q) => (q.b - q.a + 1) * OR.ds >= 20).map((q) => ({ osmFrom: Math.round(q.a * OR.ds), osmTo: Math.round(q.b * OR.ds), fromLine: Math.round(rel0(q.a * OR.ds)), near: named(((q.a + q.b) / 2) * OR.ds),
      realMeanDeg: +(q.sumR / q.n).toFixed(1), realMaxDeg: +q.maxReal.toFixed(1), gameMeanDeg: +(q.sumG / q.n).toFixed(1), gameMaxDeg: +q.maxGame.toFixed(1) })),
    realAbsMaxDeg: +Math.max(...md.map((m) => Math.abs(m.md))).toFixed(1), gameAbsMaxDeg: +Math.max(...S.map((q) => Math.abs(q.bank))).toFixed(1),
    series: { columns: ["osmS", "fromLine", "lidarDeg", "gameDeg"], rows: md.map((m) => [Math.round(m.i * OR.ds), Math.round(rel0(m.i * OR.ds)), +m.md.toFixed(1), +m.gb.toFixed(1)]) } };
}

// sparse profile for the record (every 25 m): osm s, metres from the game's line, real height (ASL), game height (+off)
const profile = [];
for (let i = 0; i < M; i += 5) profile.push([Math.round(i * OR.ds), Math.round(rel0(i * OR.ds)), +real[i].toFixed(2), +(gameY[i] + off).toFixed(2)]);

const out = {
  id, name: G.name, generated: new Date().toISOString(),
  osm: { loopWays: O.ways.map((w) => ({ id: w.id, name: w.name, osmS: Math.round(O.cum[w.from]) })), lengthM: +O.L.toFixed(1), relation: rel ? { id: rel.id, tags: rel.tags } : null },
  game: { lengthKm: G.lengthKm, builtLengthM: +G.builtLength.toFixed(1), samples: N, osmSOfGameLine: Math.round(osmS0) },
  layout: { gameToOsm: devGame, osmToGame: devOsm, worstGameSamples: worstGame, worstOsmPoints: worstOsm },
  direction: { agreeFraction: +(agree / N).toFixed(3), note: 'fraction of game samples whose direction agrees with the OSM oneway raceway direction' },
  startFinish, pitOsm: pit, pitGame: gp, structures,
  elevation: { dem: cfg.demLabel, stepM: OR.ds, samples: M, holes, covered: coveredNotes, realRangeM: +(realMax - realMin).toFixed(1), realMinASL: +realMin.toFixed(1), realMaxASL: +realMax.toFixed(1),
    rawRangeM: +(Math.max(...hc) - Math.min(...hc)).toFixed(1), gameRangeM: +(gameMax - gameMin).toFixed(1), rmsDiffM: +Math.sqrt(diff.reduce((a, v) => a + v * v, 0) / M).toFixed(2),
    maxDiffM: +Math.max(...diff.map(Math.abs)).toFixed(1), maxDiffAt: (() => { const i = diff.map(Math.abs).indexOf(Math.max(...diff.map(Math.abs))); return { osmS: Math.round(i * OR.ds), fromLine: Math.round(rel0(i * OR.ds)), near: named(i * OR.ds), gameMinusReal: +diff[i].toFixed(1) }; })(),
    grades50: gr[50], grades100: gr[100], mismatchRuns100: gr.mismatchRuns, features, profile25m: profile, realMinAt: { osmS: Math.round(real.indexOf(realMin) * OR.ds), near: named(real.indexOf(realMin) * OR.ds) }, realMaxAt: { osmS: Math.round(real.indexOf(realMax) * OR.ds), near: named(real.indexOf(realMax) * OR.ds) } },
  cross,
};
writeJSON(resolve(HERE, 'out', `measure-${id}.json`), out, true);
// also the full-resolution real profile (5 m) for a profile override
writeJSON(resolve(HERE, 'out', `profile-${id}.json`), { id, dem: cfg.demLabel, stepM: OR.ds, osmLengthM: O.L, osmSOfGameLine: osmS0, note: 'h[i] = lidar height (m ASL, 25 m median + 5 m gauss) at OSM arc length i * stepM from the start of the first OSM way; lat/lon of each sample given',
  h: Array.from(real, (v) => +v.toFixed(2)), ll: ll.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]) });
console.log(JSON.stringify({ id, layout: out.layout.gameToOsm, osmToGame: out.layout.osmToGame, osmL: out.osm.lengthM, gameL: out.game.builtLengthM, dir: out.direction.agreeFraction,
  sf: startFinish.map((s) => s.note), elev: { real: out.elevation.realRangeM, game: out.elevation.gameRangeM, rms: out.elevation.rmsDiffM, max: out.elevation.maxDiffM },
  g50: [gr[50].realMaxPct, gr[50].gameMaxPct, gr[50].realMinPct, gr[50].gameMinPct], g100: [gr[100].realMaxPct, gr[100].gameMaxPct, gr[100].realMinPct, gr[100].gameMinPct] }, null, 0));
