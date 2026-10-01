// Elevation, the cars' driven path, racing direction and the grid from the F1 live-timing positions (2025 sessions).
// The timing frame (X, Y metres; Z metres) is fitted onto the OpenStreetMap centreline (true metres around the game's
// geo origin): mirror x angle brute force, then ICP with a similarity (Umeyama: rotation, scale, translation).
// Profile: pass 1 = moving rows (> 60 km/h from consecutive rows of the same car), within 20 m of the centreline and
// nearer to it than to the OSM pit lane -> median signed lateral offset per 10 m bin (the cars' path); pass 2 = rows
// within 5 m of that path -> median Z per bin (20 cars, ~15 laps each), Gauss sigma 10 m.
import { decodePositions, positionStream } from './livetiming.mjs';
import { resampleLoop, gaussLoop, nearestOnLoop, r1, r2 } from './core.mjs';

const BIN = 10;           // m

export function gridIndex(P, cell) {
  const g = new Map();
  P.forEach((p, i) => { const k = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell); if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
  return {
    near(x, y) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      let bi = -1, bd = Infinity;
      for (let r = 0; r <= 3; r++) {
        for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
          if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
          const c = g.get((cx + a) + ',' + (cy + b));
          if (c) for (const i of c) { const d = (P[i][0] - x) ** 2 + (P[i][1] - y) ** 2; if (d < bd) { bd = d; bi = i; } }
        }
        if (bi >= 0 && Math.sqrt(bd) < r * cell) break;
      }
      return { i: bi, d: Math.sqrt(bd) };
    },
  };
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

// Fit only (used for the grid / other sessions too). rows: [[num, t, X, Y, Z]]; Q: OSM loop resampled at 2 m.
export function fitFrame(rows, Q) {
  const G = gridIndex(Q, 20);
  const cen = (pts) => { const s = new Map(); for (const p of pts) s.set(Math.floor(p[0] / 5) + ',' + Math.floor(p[1] / 5), p); let x = 0, y = 0; for (const p of s.values()) { x += p[0]; y += p[1]; } return [x / s.size, y / s.size]; };
  const cL = cen(rows.map((r) => [r[2], r[3]])), cO = cen(Q);
  const pick = []; for (let k = 0; k < 3000; k++) pick.push(rows[Math.floor((k + 0.5) / 3000 * rows.length)]);
  const tf = (T, X, Y) => { const u = (X - cL[0]) * T.m, v = Y - cL[1], c = Math.cos(T.a) * T.k, s = Math.sin(T.a) * T.k; return [T.tx + c * u - s * v, T.ty + s * u + c * v]; };
  const cost = (T, pts) => { let e = 0; for (const r of pts) { const p = tf(T, r[2], r[3]); e += Math.min(G.near(p[0], p[1]).d, 60); } return e / pts.length; };
  // multi-start: the best (mirror, angle) pairs at the centroid, each with a translation search, then ICP (rigid, then
  // similarity); the start with the lowest final error wins (long thin layouts with parallel legs fool a single start)
  const coarse = pick.filter((_, k) => k % 6 === 0), cand = [];
  for (const m of [1, -1]) for (let deg = 0; deg < 360; deg += 1.5) {
    const T = { m, a: deg * Math.PI / 180, k: 1, tx: cO[0], ty: cO[1] };
    cand.push({ T, e: cost(T, coarse) });
  }
  cand.sort((p, q) => p.e - q.e);
  const starts = [];
  for (const c of cand) { if (starts.length >= 6) break; if (!starts.some((o) => o.T.m === c.T.m && Math.abs(Math.atan2(Math.sin(o.T.a - c.T.a), Math.cos(o.T.a - c.T.a))) < 0.1)) starts.push(c); }
  const fine = pick.filter((_, k) => k % 10 === 0);
  function icp(T0) {
    let T = T0;
    for (let it = 0; it < 45; it++) {
      const P = [], W = [], lim = it < 10 ? 30 : it < 25 ? 15 : 8, free = it >= 30;
      for (const r of pick) { const p = tf(T, r[2], r[3]), n = G.near(p[0], p[1]); if (n.d < lim) { P.push([(r[2] - cL[0]) * T.m, r[3] - cL[1]]); W.push(Q[n.i]); } }
      const n = P.length; if (n < 50) break;
      let pu = 0, pv = 0, qx = 0, qy = 0;
      for (let k = 0; k < n; k++) { pu += P[k][0]; pv += P[k][1]; qx += W[k][0]; qy += W[k][1]; }
      pu /= n; pv /= n; qx /= n; qy /= n;
      let sxx = 0, sxy = 0, spp = 0;
      for (let k = 0; k < n; k++) { const a = P[k][0] - pu, b = P[k][1] - pv, c = W[k][0] - qx, d = W[k][1] - qy; sxx += a * c + b * d; sxy += a * d - b * c; spp += a * a + b * b; }
      const ang = Math.atan2(sxy, sxx), kk = free ? Math.hypot(sxx, sxy) / spp : 1, c = Math.cos(ang) * kk, s = Math.sin(ang) * kk;
      T = { m: T.m, a: ang, k: kk, tx: qx - (c * pu - s * pv), ty: qy - (s * pu + c * pv) };
    }
    return T;
  }
  let T = null, bestE = Infinity;
  for (const st of starts) {
    let bt = st.T, be = Infinity;
    for (let dx = -150; dx <= 150; dx += 15) for (let dy = -150; dy <= 150; dy += 15) {
      const T1 = Object.assign({}, st.T, { tx: cO[0] + dx, ty: cO[1] + dy }), e = cost(T1, fine);
      if (e < be) { be = e; bt = T1; }
    }
    const Tf = icp(bt), e = cost(Tf, pick);
    if (e < bestE) { bestE = e; T = Tf; }
  }
  return { T, tf: (X, Y) => tf(T, X, Y), err: cost(T, pick), G };
}

// O0 = OSM loop [[x, y] true metres] with s = 0 at the game's start foot; pit = OSM pit lane polyline (true metres) or null.
export async function ltProfile(id, O0, pit) {
  const { txt, url } = await positionStream(id);
  const { cars } = decodePositions(txt);
  const R = resampleLoop(O0, 2), Q = R.pts, total = R.total;
  const rows = []; for (const [num, rr] of Object.entries(cars)) for (const r of rr) rows.push([num, r[0], r[1], r[2], r[3]]);
  const moving = rows.filter((r, k) => { const p = rows[k - 1]; return p && p[0] === r[0] && r[1] - p[1] < 1500 && Math.hypot(r[2] - p[2], r[3] - p[3]) / ((r[1] - p[1]) / 1000) > 16.7; });
  const F = fitFrame(moving, Q), G = F.G;
  const PG = pit ? gridIndex(resampleLoop(pit, 2).pts, 20) : null;     // pit lane is open: resampleLoop closes it, fine for distances
  const nb = Math.ceil(total / BIN);
  const off = Array.from({ length: nb }, () => []);
  const rec = [];
  let fwd = 0, back = 0;
  for (const [num, rr] of Object.entries(cars)) {
    let prev = null;
    for (const r of rr) {
      const p = F.tf(r[1], r[2]), n = G.near(p[0], p[1]);
      const v = prev && r[0] - prev.t < 1500 ? Math.hypot(r[1] - prev.X, r[2] - prev.Y) / ((r[0] - prev.t) / 1000) : 0;
      const cur = { t: r[0], X: r[1], Y: r[2] };
      if (n.d > 20 || v < 16.7 || (PG && PG.near(p[0], p[1]).d < n.d)) { prev = cur; continue; }
      const i = n.i, a = Q[i], b = Q[(i + 1) % Q.length], tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
      const d = (tx * (p[1] - a[1]) - ty * (p[0] - a[0])) / tl;          // + = left of the OSM direction
      const s = i * R.ds, k = Math.min(nb - 1, Math.floor(s / BIN));
      off[k].push(d); rec.push([k, d, r[3], p[0], p[1]]);
      if (prev && prev.s !== undefined) {
        let ds = s - prev.s; if (ds > total / 2) ds -= total; if (ds < -total / 2) ds += total;
        if (ds > 0.5) fwd++; else if (ds < -0.5) back++;
      }
      cur.s = s; prev = cur;
    }
  }
  const offRaw = off.map(med), offF = gaussLoop(fillLoop(offRaw), 3);
  const zb = Array.from({ length: nb }, () => []), px = new Float64Array(nb), py = new Float64Array(nb), pn = new Float64Array(nb);
  for (const [k, d, z, x, y] of rec) if (Math.abs(d - offF[k]) < 5) { zb[k].push(z); px[k] += x; py[k] += y; pn[k]++; }
  const path = []; for (let k = 0; k < nb; k++) if (pn[k] > 3) path.push([px[k] / pn[k], py[k] / pn[k], k]);
  const zRaw = zb.map(med), z = gaussLoop(fillLoop(zRaw), 1);
  return {
    source: 'F1 live-timing archive (' + url + '): Position Z of all cars (decimetres in the feed), 2025 qualifying; moving rows (> 60 km/h) within 5 m of the cars\' median path, median per ' + BIN + ' m bin of OSM arc length, Gauss sigma 10 m',
    url, fit: { meanErrM: r2(F.err), mirror: F.T.m, rotDeg: r1(F.T.a * 180 / Math.PI), scale: +F.T.k.toFixed(4), rowsUsed: rec.length, rowsTotal: rows.length,
      emptyBins: zRaw.filter((v) => v === null).length, bins: nb, binCountMedian: med(zb.map((b) => b.length)) },
    direction: { forwardSteps: fwd, backwardSteps: back, sameAsOsmWay: fwd > back },
    binM: BIN, s: z.map((_, i) => (i + 0.5) * BIN), z, zRaw, offset: offF, total, path, _F: F,
  };
}
