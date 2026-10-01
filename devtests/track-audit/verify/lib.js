// Shared helpers for the synthesis verification (devtests/track-audit/verify/*). Read-only on every game file.
// Builds circuits with the game's own code (lib/three.min.js + tracks-data.js + scenery-data.js + js/track.js) so that
// "game" values are what the player drives, and offers projection / OSM / grade helpers.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const AUDIT = path.resolve(__dirname, '..');
const CACHE = path.join(AUDIT, 'cache');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
const D = 180 / Math.PI;

const built = {};
function td(id) { const t = window.F1_TRACKS.find((q) => q.id === id); if (!t) throw new Error('no track ' + id); return t; }
function game(id) {
  if (built[id]) return built[id];
  const T = td(id), g = T.geo, tr = F1.buildTrack(T), S = tr.samples, N = S.length;
  const ll = (x, z) => [g.lat0 + z / g.kz, g.lon0 + x / g.kx];
  const xz = (lat, lon) => [(lon - g.lon0) * g.kx, (lat - g.lat0) * g.kz];
  // arc length of tracks-data points (what the auditors call "game s" for the data line)
  const P = T.points, cum = [0];
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const out = { id, td: T, tr, S, N, L: tr.length, ds: tr.length / N, ll, xz, cum, dataLen: cum[P.length] };
  // nearest built sample to lat/lon: {i, s, dist, side} (side > 0 = driver's left (+n))
  out.project = (lat, lon) => {
    const [x, z] = xz(lat, lon); let best = Infinity, bi = 0;
    for (let i = 0; i < N; i++) { const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2; if (d < best) { best = d; bi = i; } }
    // refine on the two neighbouring segments
    let bs = S[bi].s, bd = Math.sqrt(best);
    for (const j of [bi - 1, bi]) {
      const a = S[(j + N) % N], b = S[(j + 1 + N) % N], ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2)) : 0;
      const d = Math.hypot(a.x + ex * t - x, a.z + ez * t - z);
      if (d < bd) { bd = d; bs = a.s + t * Math.sqrt(l2); if (bs >= out.L) bs -= out.L; }
    }
    const s0 = S[bi], side = (x - s0.x) * s0.nx + (z - s0.z) * s0.nz;
    return { i: bi, s: bs, dist: bd, side };
  };
  out.at = (s) => S[((Math.round(s / out.ds) % N) + N) % N];
  out.y = (s) => { // interpolated built height
    const u = ((s / out.ds) % N + N) % N, a = Math.floor(u), t = u - a;
    return S[a].y + (S[(a + 1) % N].y - S[a].y) * t;
  };
  built[id] = out;
  return out;
}
// grade (%) of a height function h(s) over a window w centred on s
const grade = (h, s, w) => 100 * (h(s + w / 2) - h(s - w / 2)) / w;
// max |grade| of h over [s0, s1] with window w (step 2 m), returns {g, s}
function maxGrade(h, s0, s1, w, sign) {
  let best = { g: sign > 0 ? -Infinity : Infinity, s: s0 };
  for (let s = s0; s <= s1; s += 2) {
    const v = grade(h, s, w);
    if (sign > 0 ? v > best.g : v < best.g) best = { g: v, s };
  }
  return best;
}
function hav(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, r = Math.PI / 180, dl = (lat2 - lat1) * r, dn = (lon2 - lon1) * r;
  const a = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// OSM: loads an Overpass-style JSON ({elements}) and indexes nodes / ways (ways get .coords [[lat, lon]])
function loadOsm(files) {
  const nodes = new Map(), ways = new Map(), rels = new Map();
  for (const f of [].concat(files)) {
    const p = path.isAbsolute(f) ? f : path.join(CACHE, f);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const e of j.elements || []) {
      if (e.type === 'node') nodes.set(e.id, e);
      else if (e.type === 'way') ways.set(e.id, Object.assign(ways.get(e.id) || {}, e));
      else if (e.type === 'relation') rels.set(e.id, e);
    }
  }
  for (const w of ways.values()) {
    if (w.geometry) w.coords = w.geometry.filter(Boolean).map((g) => [g.lat, g.lon]);
    else if (w.nodes) w.coords = w.nodes.map((n) => nodes.get(n)).filter(Boolean).map((n) => [n.lat, n.lon]);
    else w.coords = [];
  }
  return { nodes, ways, rels };
}
function pointInPoly(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if (((p[i][1] > z) !== (p[j][1] > z)) && (x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) c = !c;
  }
  return c;
}
// does segment a-b intersect segment c-d (2D)
function segX(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
module.exports = { ROOT, AUDIT, CACHE, D, td, game, grade, maxGrade, hav, loadOsm, pointInPoly, segX, r1, r2, fs, path };
