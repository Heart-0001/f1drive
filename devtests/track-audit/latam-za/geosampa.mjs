// São Paulo city terrain from GeoSampa (Prefeitura de São Paulo, Mapa Digital da Cidade): 1 m contour lines
// (geoportal:curva_intermediaria + geoportal:curva_mestra, photogrammetric restitution at 1:1000-1:5000, created 2004,
// updated 2015) and spot heights (geoportal:ponto_cotado, cm precision), read from the public WFS
// https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wfs (cached as devtests/track-audit/cache/geosampa/<id>-<layer>.json).
// A bare-earth source: contours describe the ground, not trees or buildings.
// profileFromContours(line, P) -> heights along the polyline from its crossings with the contours (linear in arc
// length between crossings; spot heights within `spotR` m of the line are added as extra knots).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), CACHE = resolve(HERE, '..', 'cache', 'geosampa');
const WFS = 'https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wfs';

export async function geosampaLayer(id, layer, bbox) {
  const file = resolve(CACHE, `${id}-${layer}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(CACHE, { recursive: true });
  const url = `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=geoportal:${layer}&outputFormat=application/json` +
    `&srsName=EPSG:4326&bbox=${bbox.join(',')},urn:ogc:def:crs:EPSG::4326`;
  const r = await fetch(url, { headers: { 'User-Agent': 'F1Drive-track-audit/1 (cached one-off read)' } });
  if (!r.ok) throw new Error('GeoSampa ' + r.status);
  const t = await r.text();
  writeFileSync(file, t);
  return JSON.parse(t);
}

function segX(a, b, c, d) {      // intersection of segments ab and cd: [t on ab, u on cd] or null
  const r0 = b[0] - a[0], r1 = b[1] - a[1], s0 = d[0] - c[0], s1 = d[1] - c[1], den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den, u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  return t >= 0 && t < 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

// line: [[east, north], ...] closed loop (metres); contours: [{z, pts: [[e, n], ...]}]; spots: [{z, p: [e, n]}]
// -> { h: heights at the line's vertices, knots: [{s, z, kind}] }
export function profileFromContours(line, contours, spots, spotR = 4) {
  const n = line.length, cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(line[(i + 1) % n][0] - line[i][0], line[(i + 1) % n][1] - line[i][1]));
  const L = cum[n], knots = [];
  // bounding boxes of the contours for speed
  const cb = contours.map((c) => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const p of c.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } return [x0, x1, y0, y1]; });
  for (let i = 0; i < n; i++) {
    const a = line[i], b = line[(i + 1) % n], bx0 = Math.min(a[0], b[0]), bx1 = Math.max(a[0], b[0]), by0 = Math.min(a[1], b[1]), by1 = Math.max(a[1], b[1]);
    for (let c = 0; c < contours.length; c++) {
      const bb = cb[c];
      if (bb[1] < bx0 || bb[0] > bx1 || bb[3] < by0 || bb[2] > by1) continue;
      const P = contours[c].pts;
      for (let k = 0; k + 1 < P.length; k++) {
        const x = segX(a, b, P[k], P[k + 1]);
        if (x) knots.push({ s: cum[i] + x[0] * (cum[i + 1] - cum[i]), z: contours[c].z, kind: 'contour' });
      }
    }
  }
  for (const sp of spots) {          // nearest point of the line
    let best = { d: Infinity };
    for (let i = 0; i < n; i++) {
      const a = line[i], b = line[(i + 1) % n], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
      const t = l2 ? Math.max(0, Math.min(1, ((sp.p[0] - a[0]) * ex + (sp.p[1] - a[1]) * ez) / l2)) : 0;
      const d = Math.hypot(a[0] + ex * t - sp.p[0], a[1] + ez * t - sp.p[1]);
      if (d < best.d) best = { d, s: cum[i] + t * Math.sqrt(l2) };
    }
    if (best.d <= spotR) knots.push({ s: best.s, z: sp.z, kind: 'spot', d: Math.round(best.d * 10) / 10 });
  }
  knots.sort((p, q) => p.s - q.s);
  // a spot height that contradicts its neighbouring contour crossings by more than 1 m (a kerb, a wall top) is dropped
  const keep = knots.filter((k, j) => {
    if (k.kind !== 'spot') return true;
    let lo = null, hi = null;
    for (let m = j - 1; m >= 0; m--) if (knots[m].kind === 'contour') { lo = knots[m]; break; }
    for (let m = j + 1; m < knots.length; m++) if (knots[m].kind === 'contour') { hi = knots[m]; break; }
    if (!lo || !hi) return true;
    return k.z >= Math.min(lo.z, hi.z) - 1 && k.z <= Math.max(lo.z, hi.z) + 1;
  });
  const h = cum.slice(0, n).map((s) => {
    if (!keep.length) return null;
    let j = keep.findIndex((k) => k.s > s);
    const A = j <= 0 ? keep[keep.length - 1] : keep[j - 1], B = j < 0 ? keep[0] : keep[j];
    let sa = A.s, sb = B.s;
    if (sb <= sa) { if (s >= sa) sb += L; else sa -= L; }
    return sb - sa < 1e-6 ? A.z : A.z + (B.z - A.z) * (s - sa) / (sb - sa);
  });
  return { h, knots: keep, length: L };
}
