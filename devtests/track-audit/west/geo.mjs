// Geometry helpers for the west-European track audit.
export const R_EARTH = 6371008.8;

// Local tangent-plane projection around (lat0, lon0): x east, y north, metres.
export function projector(lat0, lon0) {
  const kx = Math.cos(lat0 * Math.PI / 180) * Math.PI / 180 * R_EARTH, ky = Math.PI / 180 * R_EARTH;
  return {
    to: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    from: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

export function cumLen(P, closed) {
  const c = [0];
  const n = P.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) { const a = P[i], b = P[(i + 1) % n]; c.push(c[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  return c;
}

// Uniform resampling (step metres) of a polyline [[x, y, ...extra]] (closed: wraps). Returns [{x, y, s, i, t}].
export function resample(P, step, closed) {
  const c = cumLen(P, closed), total = c[c.length - 1], m = Math.max(2, Math.round(total / step)), ds = total / m, out = [];
  const n = P.length;
  for (let k = 0, i = 0; k < (closed ? m : m + 1); k++) {
    const s = Math.min(k * ds, total);
    while (i < c.length - 2 && c[i + 1] <= s) i++;
    const a = P[i], b = P[(i + 1) % n], t = (s - c[i]) / ((c[i + 1] - c[i]) || 1);
    out.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, s, i, t });
  }
  return { pts: out, ds, total };
}

// Nearest point on a polyline (closed or open) to (x, y): {d, s (arc length), seg, t, x, y}
export function nearestOn(P, c, x, y, closed) {
  let best = { d: Infinity };
  const n = P.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = P[i], b = P[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0;
    const qx = a[0] + ex * t, qy = a[1] + ey * t, d = Math.hypot(qx - x, qy - y);
    if (d < best.d) best = { d, s: c[i] + t * Math.sqrt(l2), seg: i, t, x: qx, y: qy };
  }
  return best;
}

// Signed lateral offset of (x, y) from the polyline at its nearest point: > 0 = left of the direction of travel.
export function signedOffset(P, c, x, y, closed) {
  const q = nearestOn(P, c, x, y, closed), n = P.length;
  const a = P[q.seg], b = P[(q.seg + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1];
  const cr = ex * (y - a[1]) - ey * (x - a[0]);
  return Object.assign(q, { side: cr > 0 ? 1 : -1 });
}

// Ways ([[lat, lon], ...] each) -> ordered closed loop by endpoint matching; `order` gives the way indices in
// sequence (each reversed as needed). Throws when two consecutive ways do not touch (gap > tol metres).
export function chainWays(ways, proj, tol = 3) {
  const used = new Set(), seq = [];
  let cur = ways[0].map(([la, lo]) => proj.to(la, lo));
  used.add(0); seq.push({ i: 0, rev: false });
  const end = () => cur[cur.length - 1];
  for (let guard = 0; guard < ways.length * 2 && used.size < ways.length; guard++) {
    let best = null;
    for (let i = 0; i < ways.length; i++) {
      if (used.has(i)) continue;
      const w = ways[i].map(([la, lo]) => proj.to(la, lo));
      const e = end(), d0 = Math.hypot(w[0][0] - e[0], w[0][1] - e[1]), d1 = Math.hypot(w[w.length - 1][0] - e[0], w[w.length - 1][1] - e[1]);
      if (!best || Math.min(d0, d1) < best.d) best = { i, d: Math.min(d0, d1), rev: d1 < d0, w };
    }
    if (!best || best.d > tol) throw new Error(`chainWays: gap ${best ? best.d.toFixed(1) : '?'} m after way #${seq[seq.length - 1].i}`);
    const w = best.rev ? best.w.slice().reverse() : best.w;
    cur = cur.concat(w.slice(1));
    used.add(best.i); seq.push({ i: best.i, rev: best.rev });
  }
  const gap = Math.hypot(cur[0][0] - end()[0], cur[0][1] - end()[1]);
  if (gap < 0.5) cur.pop();
  return { loop: cur, seq, closingGap: gap };
}

// lat/lon (WGS84 ~ ETRS89) -> UTM easting / northing for a given zone (Krüger series, mm accuracy).
export function toUTM(lat, lon, zone) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;
  const n = f / (2 - f), A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
  const phi = lat * Math.PI / 180, lam = (lon - (zone * 6 - 183)) * Math.PI / 180;
  const e2 = 2 * Math.sqrt(n) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e2 * Math.atanh(e2 * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 3; j++) { E += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); N += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); }
  return [500000 + k0 * A * E, k0 * A * N];
}

// Grades over a window (metres) of a uniformly sampled closed profile h (spacing ds): max climb / descent and where.
export function gradeExtremes(h, ds, win, closed = true) {
  const m = h.length, k = Math.max(1, Math.round(win / ds));
  let up = { g: -Infinity }, dn = { g: Infinity };
  const lim = closed ? m : m - k;
  for (let i = 0; i < lim; i++) {
    const j = (i + k) % m, g = (h[j] - h[i]) / (k * ds);
    if (g > up.g) up = { g, i, j };
    if (g < dn.g) dn = { g, i, j };
  }
  return { up, dn, win: k * ds };
}

export function median(arr, half) {
  const m = arr.length;
  return arr.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(arr[((i + j) % m + m) % m]); w.sort((a, b) => a - b); return w[half]; });
}
export function gauss(h, sigma) {
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), Math.floor((m - 1) / 2)), k = [];
  let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => { let acc = 0; for (let j = -r; j <= r; j++) acc += k[j + r] * h[((i + j) % m + m) % m]; return acc / sum; });
}
