// node devtests/track-audit/eu-south-central/lt.mjs [ids]
// F1 live-timing archive (livetiming.formula1.com/static, the feed FastF1 reads): every car's X / Y / Z (decimetres in a
// circuit-local frame) ~4 times a second. Same method as ../mideast/ltprofile.mjs + grid.mjs, against the GAME centreline:
//  - the qualifying session's Position stream -> frame fit (mirror x angle brute force, then ICP similarity onto the game
//    centreline in UTM metres), the cars' racing direction, and an independent height profile: Z of moving cars (> 60 km/h)
//    within 5 m of their median path, median per 10 m bin of game arc length, Gauss sigma 10 m;
//  - the first 3 MB of the race's Position stream (HTTP Range) -> the cars standing on the grid before the start: pole
//    slot = the most advanced car, just behind the real start line.
// Cached under devtests/track-audit/cache/f1livetiming/. Writes out/lt-<id>.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { HERE, CACHE, loadGame, gameLine, wrap, sdiff, sleep } from './lib.mjs';

export const SESS = {
  'it-1922': { q: '2026/2026-09-06_Italian_Grand_Prix/2026-09-05_Qualifying/', r: '2026/2026-09-06_Italian_Grand_Prix/2026-09-06_Race/' },
  'it-1953': { q: '2025/2025-05-18_Emilia_Romagna_Grand_Prix/2025-05-17_Qualifying/', r: '2025/2025-05-18_Emilia_Romagna_Grand_Prix/2025-05-18_Race/' },
  'it-1914': { q: '2020/2020-09-13_Tuscan_Grand_Prix/2020-09-12_Qualifying/', r: '2020/2020-09-13_Tuscan_Grand_Prix/2020-09-13_Race/' },
  'at-1969': { q: '2026/2026-06-28_Austrian_Grand_Prix/2026-06-27_Qualifying/', r: '2026/2026-06-28_Austrian_Grand_Prix/2026-06-28_Race/' },
  'hu-1986': { q: '2026/2026-07-26_Hungarian_Grand_Prix/2026-07-25_Qualifying/', r: '2026/2026-07-26_Hungarian_Grand_Prix/2026-07-26_Race/' },
};
const BASE = 'https://livetiming.formula1.com/static/', UA = { 'User-Agent': 'F1Drive track audit (devtests; cached one-off read)' };
const DIR = resolve(CACHE, 'f1livetiming');
mkdirSync(DIR, { recursive: true });

async function getFile(path, name, head) {
  const file = resolve(DIR, name);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const h = Object.assign({}, UA); if (head) h.Range = 'bytes=0-' + (head - 1);
  for (let a = 0; ; a++) {
    const r = await fetch(BASE + path, { headers: h });
    if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); writeFileSync(file, b); await sleep(3000); return b.toString('utf8'); }
    if (a > 3) throw new Error('HTTP ' + r.status + ' ' + path);
    await sleep(5000 * 2 ** a);
  }
}

export function decodePositions(txt) {
  const cars = {};
  for (const ln of txt.replace(/^﻿/, '').split(/\r?\n/)) {
    const q = ln.indexOf('"');
    if (q < 0) continue;
    let j;
    try { j = JSON.parse(inflateRawSync(Buffer.from(ln.slice(q + 1, ln.lastIndexOf('"')), 'base64')).toString('utf8')); } catch (e) { continue; }
    for (const p of j.Position || []) {
      const t = Date.parse(p.Timestamp);
      for (const [num, e] of Object.entries(p.Entries || {})) {
        if (e.Status !== 'OnTrack' || (e.X === 0 && e.Y === 0 && e.Z === 0)) continue;
        (cars[num] = cars[num] || []).push([t, e.X / 10, e.Y / 10, e.Z / 10]);
      }
    }
  }
  for (const k of Object.keys(cars)) cars[k].sort((a, b) => a[0] - b[0]);
  return cars;
}

function fitFrame(rows, gl) {
  // bounding-box centres (time-weighted or cell centroids are biased by the pit lane / slow corners; the frame is metric)
  const bb = (xs) => { let lo = Infinity, hi = -Infinity; for (const v of xs) { if (v < lo) lo = v; if (v > hi) hi = v; } return (lo + hi) / 2; };
  const gx = bb(gl.P.map((p) => p[0])), gy = bb(gl.P.map((p) => p[1]));
  const cx = bb(rows.map((r) => r[2])), cy = bb(rows.map((r) => r[3]));
  const pick = []; for (let k = 0; k < 3000; k++) pick.push(rows[Math.floor((k + 0.5) / 3000 * rows.length)]);
  const tf = (T, X, Y) => { const u = (X - cx) * T.m, v = Y - cy, c = Math.cos(T.a) * T.k, s = Math.sin(T.a) * T.k; return [T.tx + c * u - s * v, T.ty + s * u + c * v]; };
  const cost = (T, pts) => { let e = 0; for (const r of pts) { const p = tf(T, r[2], r[3]); e += Math.min(gl.idx.near(p[0], p[1], 80).d, 60); } return e / pts.length; };
  let best = null;
  const coarse = pick.filter((_, k) => k % 6 === 0);
  for (const m of [1, -1]) for (let deg = 0; deg < 360; deg += 1.5) {
    const T = { m, a: deg * Math.PI / 180, k: 1, tx: gx, ty: gy }, e = cost(T, coarse);
    if (!best || e < best.e) best = { T, e };
  }
  let T = best.T;
  for (let it = 0; it < 40; it++) {
    const P = [], W = [], lim = it < 10 ? 30 : 8;
    for (const r of pick) { const p = tf(T, r[2], r[3]), n = gl.idx.near(p[0], p[1], 80); if (n.d < lim) { P.push([(r[2] - cx) * T.m, r[3] - cy]); W.push([n.px, n.py]); } }
    const n = P.length; let pu = 0, pv = 0, qx = 0, qy = 0;
    for (let k = 0; k < n; k++) { pu += P[k][0]; pv += P[k][1]; qx += W[k][0]; qy += W[k][1]; }
    pu /= n; pv /= n; qx /= n; qy /= n;
    let sxx = 0, sxy = 0, spp = 0;
    for (let k = 0; k < n; k++) { const a = P[k][0] - pu, b = P[k][1] - pv, c = W[k][0] - qx, d = W[k][1] - qy; sxx += a * c + b * d; sxy += a * d - b * c; spp += a * a + b * b; }
    const ang = Math.atan2(sxy, sxx), kk = Math.hypot(sxx, sxy) / spp, c = Math.cos(ang) * kk, s = Math.sin(ang) * kk;
    T = { m: T.m, a: ang, k: kk, tx: qx - (c * pu - s * pv), ty: qy - (s * pu + c * pv) };
  }
  return { T, tf: (X, Y) => tf(T, X, Y), err: cost(T, pick) };
}
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
function fillLoop(raw) {
  const nb = raw.length, z = raw.slice();
  for (let i = 0; i < nb; i++) if (z[i] === null) {
    let a = i, b = i;
    while (raw[(a - 1 + nb) % nb] === null && a > i - nb) a--;
    while (raw[(b + 1) % nb] === null && b < i + nb) b++;
    const za = raw[(a - 1 + nb) % nb], zb = raw[(b + 1) % nb], t = (i - a + 1) / (b - a + 2); z[i] = za + (zb - za) * t;
  }
  return z;
}
function gaussLoop(h, sigma) {
  const m = h.length, r = Math.ceil(sigma * 3), k = []; let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => { let a = 0; for (let j = -r; j <= r; j++) a += k[j + r] * h[((i + j) % m + m) % m]; return a / sum; });
}

export async function lt(id, S = SESS[id], tag = '') {
  const game = loadGame(id), gl = gameLine(id, game), total = gl.total;
  const qName = id + '-' + S.q.split('/')[2] + '-Position.z.jsonStream';
  const qtxt = await getFile(S.q + 'Position.z.jsonStream', qName);
  const cars = decodePositions(qtxt);
  const rows = []; for (const [num, rr] of Object.entries(cars)) for (const r of rr) rows.push([num, r[0], r[1], r[2], r[3]]);
  const moving = rows.filter((r, k) => { const p = rows[k - 1]; return p && p[0] === r[0] && r[1] - p[1] < 1500 && Math.hypot(r[2] - p[2], r[3] - p[3]) / ((r[1] - p[1]) / 1000) > 16.7; });
  const F = fitFrame(moving, gl);
  const BIN = 10, nb = Math.ceil(total / BIN), off = Array.from({ length: nb }, () => []), rec = [];
  let fwd = 0, back = 0;
  for (const [num, rr] of Object.entries(cars)) {
    let prev = null;
    for (const r of rr) {
      const p = F.tf(r[1], r[2]), n = gl.sAt(p[0], p[1]);
      const v = prev && r[0] - prev.t < 1500 ? Math.hypot(r[1] - prev.X, r[2] - prev.Y) / ((r[0] - prev.t) / 1000) : 0;
      const cur = { t: r[0], X: r[1], Y: r[2] };
      if (n.d > 20 || v < 16.7) { prev = cur; continue; }
      const a = gl.P[n.i], b = gl.P[(n.i + 1) % gl.N], tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
      const d = (tx * (p[1] - a[1]) - ty * (p[0] - a[0])) / tl;      // + = left of the racing direction
      const k = Math.min(nb - 1, Math.floor(n.s / BIN));
      off[k].push(d); rec.push([k, d, r[3]]);
      if (prev && prev.s !== undefined) { const ds = sdiff(n.s, prev.s, total); if (ds > 0.5) fwd++; else if (ds < -0.5) back++; }
      cur.s = n.s; prev = cur;
    }
  }
  const offF = gaussLoop(fillLoop(off.map(med)), 3);
  const zb = Array.from({ length: nb }, () => []);
  for (const [k, d, z] of rec) if (Math.abs(d - offF[k]) < 5) zb[k].push(z);
  const zRaw = zb.map(med), z = gaussLoop(fillLoop(zRaw), 1);
  // grid
  let grid = null;
  try {
    const rName = id + '-' + S.r.split('/')[2] + '-head3MB-Position.z.jsonStream';
    const rtxt = await getFile(S.r + 'Position.z.jsonStream', rName, 3000000);
    const rc = decodePositions(rtxt), spells = [];
    for (const [num, rr] of Object.entries(rc)) {
      let a = 0;
      for (let k = 1; k <= rr.length; k++) {
        const moved = k === rr.length || Math.hypot(rr[k][1] - rr[a][1], rr[k][2] - rr[a][2]) > 0.6;
        if (moved) {
          if (rr[k - 1][0] - rr[a][0] >= 5000) {
            const p = F.tf(rr[a][1], rr[a][2]), q = gl.sAt(p[0], p[1]);
            if (q.d < 12) spells.push({ num, t0: rr[a][0], t1: rr[k - 1][0], s: q.s, d: q.d });
          }
          a = k;
        }
      }
    }
    spells.sort((x, y) => x.t1 - y.t1);
    let best = null;
    for (const e of spells) {
      const grp = spells.filter((o) => Math.abs(o.t1 - e.t1) < 3000), nums = new Set(grp.map((o) => o.num));
      if (nums.size >= 15 && (!best || nums.size > best.n || (nums.size === best.n && e.t1 > best.t1))) best = { n: nums.size, t1: e.t1, grp };
    }
    if (best) {
      const slots = [...new Map(best.grp.map((o) => [o.num, o])).values()].map((o) => ({ car: o.num, s: +sdiff(o.s, 0, total).toFixed(1) }));
      slots.sort((x, y) => y.s - x.s);
      grid = { url: BASE + S.r + 'Position.z.jsonStream (first 3 MB)', startUtc: new Date(best.t1).toISOString(), cars: slots.length,
        poleSlotFromGameLineM: slots[0].s, lastSlotFromGameLineM: slots[slots.length - 1].s, slots };
    }
  } catch (e) { grid = { error: String(e.message) }; }
  const out = {
    id, source: BASE + S.q + 'Position.z.jsonStream', method: 'Z of moving cars (> 60 km/h) within 5 m of their median path, median per 10 m bin of game arc length, Gauss sigma 10 m',
    fit: { meanErrM: +F.err.toFixed(2), mirror: F.T.m, rotDeg: +(F.T.a * 180 / Math.PI).toFixed(2), scale: +F.T.k.toFixed(4), rowsUsed: rec.length, rowsTotal: rows.length,
      emptyBins: zRaw.filter((v) => v === null).length, bins: nb, binCountMedian: med(zb.map((b) => b.length)) },
    direction: { forwardSteps: fwd, backwardSteps: back, sameAsGame: fwd > back },
    binM: BIN, s: z.map((_, i) => (i + 0.5) * BIN), z: z.map((v) => +v.toFixed(2)), zRaw: zRaw.map((v) => (v === null ? null : +v.toFixed(2))),
    pathOffsetM: offF.map((v) => +v.toFixed(2)), grid,
  };
  writeFileSync(resolve(HERE, 'out', `lt-${id}${tag}.json`), JSON.stringify(out));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE, 'lt.mjs')) {
  for (const id of (process.argv[2] || 'it-1922,it-1953,it-1914,at-1969,hu-1986').split(',')) {
    const o = await lt(id);
    const zr = Math.max(...o.z) - Math.min(...o.z);
    console.log(`${id}: fit ${JSON.stringify(o.fit)} dir ${JSON.stringify(o.direction)} Z range ${zr.toFixed(1)} m; grid ${o.grid ? JSON.stringify({ ...o.grid, slots: undefined }) : 'none'}`);
  }
}
