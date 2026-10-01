// For every track: nearest OSM 'pit' building (scenery-data.js) to the centreline, and its arc position s.
global.window = global;
require('../../../tracks-data.js'); require('../../../scenery-data.js');
const only = process.argv[2];
for (const t of window.F1_TRACKS) {
  if (only && t.id !== only) continue;
  const sc = window.F1_SCENERY[t.id]; const P = t.points; const n = P.length; const cum = [0];
  for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; cum.push(cum[i] + Math.hypot(b[0]-a[0], b[1]-a[1])); }
  const L = cum[n];
  const pits = (sc && sc.buildings || []).filter(b => b.k === 'pit');
  let best = null;
  for (const b of pits) {
    const cx = b.p.reduce((s, q) => s + q[0], 0) / b.p.length, cz = b.p.reduce((s, q) => s + q[1], 0) / b.p.length;
    let bi = 0, bd = 1e9; P.forEach((p, i) => { const d = Math.hypot(p[0]-cx, p[1]-cz); if (d < bd) { bd = d; bi = i; } });
    let s = cum[bi]; if (s > L / 2) s -= L;
    if (bd < 200 && (!best || Math.abs(s) < Math.abs(best.s))) best = { s: Math.round(s), d: Math.round(bd) };
  }
  console.log(t.id.padEnd(8), 'pit bldgs', String(pits.length).padStart(3), 'nearest-to-line (within 200 m of road):', best ? JSON.stringify(best) : '-', 'elev0', t.elev[0], 'max', Math.max(...t.elev));
}
