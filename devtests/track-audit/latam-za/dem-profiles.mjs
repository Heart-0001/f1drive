// node devtests/track-audit/latam-za/dem-profiles.mjs <id> [--no-net]
// Samples better / independent elevation models along the circuit's OpenStreetMap centreline (out/osm-<id>.json
// `snapped`: the game's samples snapped onto the OSM raceway ways, every 3rd sample ~ 6 m; for Jacarepaguá, demolished
// in 2012 and absent from OSM, the game's own centreline) and writes out/dem-<id>.json:
//   s            game arc length (m) of each profile point (index j = game sample j * step)
//   ll           [lat, lon] of the point sampled
//   game         the game's surface height there (js/track.js samples, relative)
//   glo30        Copernicus GLO-30 (30 m DSM, AWS open data COGs, bilinear)
//   srtm30m      NASA SRTM GL1 (30 m, Feb 2000) via OpenTopoData, every 4th point, linear in between
//   mapzen       (mx-1962 only) Mapzen terrain tiles via OpenTopoData = INEGI CEM in Mexico
//   geosampa     (br-1940 only) GeoSampa 1 m contours + spot heights (bare earth)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glo30Window, sampleGrid } from './glo30.mjs';
import { otd } from './otd.mjs';
import { geosampaLayer, profileFromContours } from './geosampa.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const id = process.argv[2], NONET = process.argv.includes('--no-net');
const game = JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8'));
const S = game.samples, N = S.length, step = Math.max(1, Math.round(5 / game.ds));
let line, lineSrc;
try {
  const osm = JSON.parse(readFileSync(resolve(HERE, 'out', `osm-${id}.json`), 'utf8'));
  line = osm.snapped; lineSrc = 'OpenStreetMap raceway ways (game samples snapped onto them), out/osm-' + id + '.json';
} catch (e) {
  line = S.filter((_, i) => i % step === 0).map((q) => q.ll); lineSrc = 'the game centreline (no OSM raceway ways: circuit demolished)';
}
const M = line.length;
if (Math.abs(M - Math.ceil(N / step)) > 1) throw new Error(`profile length ${M} vs ${Math.ceil(N / step)}`);
const out = { id, step, lineSrc, s: [], ll: line, game: [], profiles: {}, sources: {} };
for (let j = 0; j < M; j++) { out.s.push(S[j * step].s); out.game.push(S[j * step].y); }

// --- GLO-30
{
  let s = 90, n = -90, w = 180, e = -180;
  for (const [la, lo] of line) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  const pad = 0.002, wins = [];
  // one window per 1-degree tile the loop touches
  for (let la = Math.floor(s - pad); la <= Math.floor(n + pad); la++) {
    for (let lo = Math.floor(w - pad); lo <= Math.floor(e + pad); lo++) {
      const bb = [Math.max(s - pad, la + 1e-6), Math.max(w - pad, lo + 1e-6), Math.min(n + pad, la + 1 - 1e-6), Math.min(e + pad, lo + 1 - 1e-6)];
      if (bb[0] < bb[2] && bb[1] < bb[3]) wins.push(await glo30Window(`${id}-${la}_${lo}`, bb));
    }
  }
  // bilinear inside a window; a point in the seam between two 1-degree tiles (within 1.5 px of a window edge) takes the
  // nearest pixel of the closest window
  const clampNearest = (g, la, lo) => { const fx = (lo - g.lonC0) / g.dlon, fy = (g.latC0 - la) / g.dlat;
    if (fx < -1.5 || fy < -1.5 || fx > g.w + 0.5 || fy > g.h + 0.5) return null;
    const x = Math.min(g.w - 1, Math.max(0, Math.round(fx))), y = Math.min(g.h - 1, Math.max(0, Math.round(fy))); return g.z[y * g.w + x]; };
  out.profiles.glo30 = line.map(([la, lo]) => { for (const g of wins) { const v = sampleGrid(g, la, lo); if (v !== null && Number.isFinite(v)) return +v.toFixed(2); }
    for (const g of wins) { const v = clampNearest(g, la, lo); if (v !== null && Number.isFinite(v)) return +v.toFixed(2); } return null; });
  out.sources.glo30 = { label: 'Copernicus DEM GLO-30 (DSM, TanDEM-X 2011-2015), AWS open data COG, bilinear', files: wins.map((g) => g.source) };
}
// --- OpenTopoData
async function otdProfile(ds) {
  const idx = []; for (let j = 0; j < M; j += 4) idx.push(j);
  const pts = idx.map((j) => line[j]);
  const h = NONET ? null : await otd(ds, id, pts);
  if (!h) return null;
  const full = new Array(M).fill(null);
  for (let k = 0; k < idx.length; k++) {
    const a = idx[k], b = k + 1 < idx.length ? idx[k + 1] : M, ha = h[k], hb = h[(k + 1) % idx.length];
    for (let j = a; j < b; j++) full[j] = ha === null || hb === null ? ha : +(ha + (hb - ha) * (j - a) / (b - a)).toFixed(2);
  }
  return full;
}
out.profiles.srtm30m = await otdProfile('srtm30m');
out.sources.srtm30m = { label: 'NASA SRTM GL1 v3 30 m (C-band radar DSM, Feb 2000) via OpenTopoData api.opentopodata.org/v1/srtm30m, every 4th point (~24 m), bilinear' };
if (id === 'mx-1962') {
  out.profiles.mapzen = await otdProfile('mapzen');
  out.sources.mapzen = { label: 'Mapzen / Tilezen terrain tiles via OpenTopoData (in Mexico from INEGI Continuo de Elevaciones Mexicano), every 4th point' };
}
// --- GeoSampa (Interlagos)
if (id === 'br-1940') {
  const bb = [-23.70776, -46.70201, -23.69563, -46.69256];
  const lat0 = game.geo.lat0, lon0 = game.geo.lon0, KX = Math.cos(lat0 * Math.PI / 180) * 111320, KN = 110540;
  const P = (lat, lon) => [(lon - lon0) * KX, (lat - lat0) * KN];
  const contours = [];
  for (const L of ['curva_intermediaria', 'curva_mestra']) {
    const j = await geosampaLayer(id, L, bb);
    for (const f of j.features) {
      const z = +f.properties.cd_numero_isovalor, g = f.geometry;
      const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const c of parts) contours.push({ z, pts: c.map(([lo, la]) => P(la, lo)) });
    }
  }
  const sj = await geosampaLayer(id, 'ponto_cotado', bb);
  const spots = sj.features.map((f) => ({ z: +f.properties.cd_altitude, p: P(f.geometry.coordinates[1], f.geometry.coordinates[0]) }));
  const r = profileFromContours(line.map(([la, lo]) => P(la, lo)), contours, spots, 4);
  out.profiles.geosampa = r.h.map((v) => (v === null ? null : +v.toFixed(2)));
  out.geosampaKnots = r.knots.length;
  out.sources.geosampa = { label: 'GeoSampa (Prefeitura de São Paulo, Mapa Digital da Cidade): 1 m contours geoportal:curva_intermediaria + curva_mestra and spot heights geoportal:ponto_cotado (aerial photogrammetric restitution, 2004, updated 2015), public WFS https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wfs; profile = linear between the centreline\'s contour crossings (+ spot heights <= 4 m from it)', knots: r.knots.length, contours: contours.length, spots: spots.length };
}
writeFileSync(resolve(HERE, 'out', `dem-${id}.json`), JSON.stringify(out));
const st = (a) => { const v = a.filter((x) => x !== null); return v.length ? `${Math.min(...v).toFixed(1)}..${Math.max(...v).toFixed(1)} (range ${(Math.max(...v) - Math.min(...v)).toFixed(1)} m, ${a.length - v.length} null)` : 'none'; };
console.log(`${id}: ${M} points from ${lineSrc}; game ${st(out.game)}`);
for (const [k, a] of Object.entries(out.profiles)) if (a) console.log(`  ${k}: ${st(a)}`);
