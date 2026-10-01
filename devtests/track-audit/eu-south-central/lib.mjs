// Shared helpers for the eu-south-central audit (it-1922 it-1953 it-1914 at-1969 hu-1986).
// Game side: out/game-<id>.json (written by game.js: dataset points, built samples ~2 m with lat/lon/y/grade/bankDeg,
// track.pit). OSM side: the Overpass cache (cache/overpass/<id>.json) or the OSM API fallback (cache/osmapi/<id>.json).
// Geometry in UTM metres (utm.js).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE = resolve(HERE, '..', 'cache');
const { toUTM, fromUTM } = require('./utm.js');

export const ZONE = { 'it-1922': 32, 'it-1953': 32, 'it-1914': 32, 'at-1969': 33, 'hu-1986': 34 };
// The F1 layout in OpenStreetMap: the circuit relation's ways minus pit lanes and other-series variants.
export const LAYOUT = {
  'it-1922': { rel: 284565, exclude: [] },
  // Variante Bassa ways 176764793 / 1025616646 / 1025616647 = the motorcycle chicane; cars take the straight bypass
  // (en.wikipedia Imola Circuit: "A bypass to the Variante Bassa chicane was added for cars").
  'it-1953': { rel: 9291096, exclude: [176764793, 1025616646, 1025616647] },
  'it-1914': { rel: 8487163, exclude: [] },
  // MotoGP long-lap loop and the 2022+ MotoGP chicane (OSM way names) are not part of the F1 lap.
  // The relation also lists the pit lane (way 289111668 'Boxenstraße') without a role.
  'at-1969': { rel: 5309181, exclude: [823820476, 1077423714, 289111668], pit: [289111668] },
  'hu-1986': { rel: 284557, exclude: [] },
};
export const MV = { 'it-1922': 'c39-2025', 'it-1953': 'c6-2025', 'at-1969': 'c19-2025', 'hu-1986': 'c4-2025' };

export function loadGame(id) { return JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8')); }
export function loadOSM(id) {
  const a = resolve(CACHE, 'overpass', id + '.json'), b = resolve(CACHE, 'osmapi', id + '.json');
  const j = JSON.parse(readFileSync(existsSync(a) ? a : b, 'utf8'));
  j._file = existsSync(a) ? 'cache/overpass/' + id + '.json (Overpass API)' : 'cache/osmapi/' + id + '.json (OSM API 0.6 /map)';
  return j;
}

export function proj(id) {
  const z = ZONE[id];
  return { to: (lat, lon) => toUTM(lat, lon, z), from: (e, n) => fromUTM(e, n, z), zone: z };
}

// Polyline (array of [x, y]) helpers
export function cumLen(P, closed) {
  const c = [0];
  const n = closed ? P.length : P.length - 1;
  for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % P.length]; c.push(c[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  return c;
}
// Segment index with a uniform grid for fast nearest queries. segs: [[ax, ay, bx, by, meta...]]
export function segIndex(segs, cell = 50) {
  const grid = new Map(), key = (i, j) => i * 100003 + j;
  segs.forEach((s, k) => {
    const i0 = Math.floor(Math.min(s[0], s[2]) / cell), i1 = Math.floor(Math.max(s[0], s[2]) / cell);
    const j0 = Math.floor(Math.min(s[1], s[3]) / cell), j1 = Math.floor(Math.max(s[1], s[3]) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const q = key(i, j); if (!grid.has(q)) grid.set(q, []); grid.get(q).push(k);
    }
  });
  function near(x, y, maxR = 400) {
    let best = { d: Infinity };
    for (let r = 0; r * cell <= maxR + cell; r++) {
      const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        const L = grid.get(key(i, j)); if (!L) continue;
        for (const k of L) {
          const s = segs[k], ex = s[2] - s[0], ey = s[3] - s[1], l2 = ex * ex + ey * ey;
          const t = l2 ? Math.max(0, Math.min(1, ((x - s[0]) * ex + (y - s[1]) * ey) / l2)) : 0;
          const px = s[0] + ex * t, py = s[1] + ey * t, d = Math.hypot(px - x, py - y);
          if (d < best.d) best = { d, k, t, px, py, seg: s };
        }
      }
      if (best.d < (r - 0.5) * cell) break;
    }
    return best;
  }
  return { near };
}

// Game centreline as segments with arc length: samples (lat, lon, s) -> UTM
export function gameLine(id, game) {
  const p = proj(id), S = game.samples, N = S.length;
  const P = S.map((s) => p.to(s.lat, s.lon));
  const segs = [];
  for (let i = 0; i < N; i++) { const a = P[i], b = P[(i + 1) % N]; segs.push([a[0], a[1], b[0], b[1], i]); }
  const total = game.trackLength;
  const idx = segIndex(segs);
  const sAt = (x, y) => {
    const r = idx.near(x, y);
    const i = r.seg[4], s0 = S[i].s, s1 = i + 1 < N ? S[i + 1].s : total;
    return { d: r.d, s: s0 + (s1 - s0) * r.t, i, px: r.px, py: r.py };
  };
  return { P, segs, idx, sAt, total, N, S };
}

// OSM layout ways (with geometry) and their union as segments
export function osmLayout(id, osm) {
  const L = LAYOUT[id], rel = osm.elements.find((e) => e.type === 'relation' && e.id === L.rel);
  const ways = new Map(osm.elements.filter((e) => e.type === 'way').map((e) => [e.id, e]));
  const members = rel.members.filter((m) => m.type === 'way' && !/pit/i.test(m.role || '') && !L.exclude.includes(m.ref));
  const p = proj(id), segs = [], list = [];
  let len = 0;
  for (const m of members) {
    const w = ways.get(m.ref);
    if (!w) { list.push({ id: m.ref, missing: true }); continue; }
    const P = w.geometry.map((g) => p.to(g.lat, g.lon));
    let l = 0;
    for (let i = 0; i + 1 < P.length; i++) { segs.push([P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], w.id, i]); l += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); }
    len += l;
    list.push({ id: w.id, name: w.tags.name || null, ref: w.tags.ref || null, len: l, P, tags: w.tags, nodes: w.nodes });
  }
  // topology check: every way end shared with exactly one other way end -> a simple loop
  const ends = new Map();
  for (const w of list) if (w.nodes) for (const nd of [w.nodes[0], w.nodes[w.nodes.length - 1]]) ends.set(nd, (ends.get(nd) || 0) + 1);
  const loopOK = [...ends.values()].every((c) => c === 2);
  const pit = rel.members.filter((m) => m.type === 'way' && (/pit/i.test(m.role || '') || (L.pit || []).includes(m.ref))).map((m) => ways.get(m.ref)).filter(Boolean);
  return { rel, members: list, segs, idx: segIndex(segs), length: len, loopOK, pit };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function wrap(s, total) { return ((s % total) + total) % total; }
export function sdiff(a, b, total) { let d = wrap(a - b, total); if (d > total / 2) d -= total; return d; }
