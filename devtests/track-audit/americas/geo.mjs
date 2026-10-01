// Geometry helpers for the americas track audit: a local metric frame (east / north metres around a reference point),
// nearest-segment queries on polylines, polyline intersections, windows on a closed profile.
export function frame(lat0, lon0) {
  const kN = 110574 + 1110 * Math.sin(lat0 * Math.PI / 180) ** 2;          // m per degree of latitude (approx.)
  const kE = 111320 * Math.cos(lat0 * Math.PI / 180);                    // m per degree of longitude
  return {
    lat0, lon0, kN, kE,
    en: (lat, lon) => [(lon - lon0) * kE, (lat - lat0) * kN],
    ll: (e, n) => [lat0 + n / kN, lon0 + e / kE],
  };
}

// segments: [{a:[e,n], b:[e,n], tag}] -> grid index for nearest queries
export function segIndex(segs, cell = 50) {
  const grid = new Map();
  const key = (i, j) => i + ',' + j;
  segs.forEach((s, idx) => {
    const i0 = Math.floor(Math.min(s.a[0], s.b[0]) / cell), i1 = Math.floor(Math.max(s.a[0], s.b[0]) / cell);
    const j0 = Math.floor(Math.min(s.a[1], s.b[1]) / cell), j1 = Math.floor(Math.max(s.a[1], s.b[1]) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(idx);
    }
  });
  return {
    nearest(p, maxR = 400, filter = null) {
      let best = null;
      for (let r = 0; r * cell <= maxR + cell; r++) {
        const ci = Math.floor(p[0] / cell), cj = Math.floor(p[1] / cell);
        for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          const lst = grid.get(key(i, j));
          if (!lst) continue;
          for (const idx of lst) {
            const s = segs[idx];
            if (filter && !filter(s)) continue;
            const f = foot(p, s.a, s.b);
            if (!best || f.d < best.d) best = { ...f, seg: s, idx };
          }
        }
        if (best && best.d < (r - 1) * cell) break;
      }
      return best;
    },
  };
}
export function foot(p, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2)) : 0;
  const q = [a[0] + ex * t, a[1] + ey * t];
  return { q, t, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
}
// intersection of segments p1-p2 and p3-p4 -> {t, u, q} or null
export function segX(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, q: [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t] };
}
// value of a closed, uniformly sampled profile (step ds) at arc length s (linear)
export function at(h, ds, s) {
  const m = h.length, u = (((s / ds) % m) + m) % m, a = Math.floor(u), t = u - a;
  return h[a] + (h[(a + 1) % m] - h[a]) * t;
}
export function median(arr) { const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; }
export function medianLoop(h, half) {
  const m = h.length;
  return h.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]); return median(w); });
}
// centred grade over a window w (m) on a closed profile sampled every ds: (h(s + w/2) - h(s - w/2)) / w
export function grades(h, ds, w) {
  const m = h.length, k = Math.round(w / 2 / ds);
  return h.map((_, i) => (h[(i + k) % m] - h[((i - k) % m + m) % m]) / (2 * k * ds));
}
export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 100) / 100;
export const r3 = (v) => Math.round(v * 1000) / 1000;
