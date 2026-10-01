// ETRS89-LAEA Europe (EPSG:3035) forward / inverse on GRS80 (IOGP Guidance Note 7-2, 1.3.2.4).
// toLAEA(lat, lon) -> [E, N]; fromLAEA(E, N) -> [lat, lon].
'use strict';
const a = 6378137, f = 1 / 298.257222101, e2 = 2 * f - f * f, e = Math.sqrt(e2);
const lat0 = 52 * Math.PI / 180, lon0 = 10 * Math.PI / 180, FE = 4321000, FN = 3210000, rad = Math.PI / 180;
const q = (phi) => { const s = Math.sin(phi); return (1 - e2) * (s / (1 - e2 * s * s) - 1 / (2 * e) * Math.log((1 - e * s) / (1 + e * s))); };
const qP = q(Math.PI / 2), q0 = q(lat0), Rq = a * Math.sqrt(qP / 2), b0 = Math.asin(q0 / qP);
const D = a * (Math.cos(lat0) / Math.sqrt(1 - e2 * Math.sin(lat0) ** 2)) / (Rq * Math.cos(b0));
function toLAEA(lat, lon) {
  const phi = lat * rad, lam = lon * rad, b = Math.asin(q(phi) / qP);
  const B = Rq * Math.sqrt(2 / (1 + Math.sin(b0) * Math.sin(b) + Math.cos(b0) * Math.cos(b) * Math.cos(lam - lon0)));
  const E = FE + B * D * Math.cos(b) * Math.sin(lam - lon0);
  const N = FN + (B / D) * (Math.cos(b0) * Math.sin(b) - Math.sin(b0) * Math.cos(b) * Math.cos(lam - lon0));
  return [E, N];
}
function fromLAEA(E, N) {
  const x = (E - FE) / D, y = (N - FN) * D, rho = Math.hypot(x, y), C = 2 * Math.asin(rho / (2 * Rq));
  const bp = Math.asin(Math.cos(C) * Math.sin(b0) + (y * Math.sin(C) * Math.cos(b0)) / rho);
  const lam = lon0 + Math.atan2(x * Math.sin(C), rho * Math.cos(b0) * Math.cos(C) - y * Math.sin(b0) * Math.sin(C));
  const phi = bp + (e2 / 3 + 31 * e2 * e2 / 180 + 517 * e2 ** 3 / 5040) * Math.sin(2 * bp) +
    (23 * e2 * e2 / 360 + 251 * e2 ** 3 / 3780) * Math.sin(4 * bp) + (761 * e2 ** 3 / 45360) * Math.sin(6 * bp);
  return [phi / rad, lam / rad];
}
module.exports = { toLAEA, fromLAEA };
