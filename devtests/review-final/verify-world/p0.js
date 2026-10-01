global.window = global; require('../../../tracks-data.js'); require('../../../scenery-data.js');
for (const id of process.argv.slice(2)) {
  const t = window.F1_TRACKS.find(x => x.id === id), g = t.geo, P = t.points;
  const ll = (p) => [(p[1] / g.kz + g.lat0).toFixed(5), (p[0] / g.kx + g.lon0).toFixed(5)];
  console.log(id, t.name, 'p0', ll(P[0]).join(','), 'p1', ll(P[3]).join(','));
  const pits = (window.F1_SCENERY[id].buildings || []).filter(b => b.k === 'pit');
  for (const b of pits) { const cx = b.p.reduce((s, q) => s + q[0], 0) / b.p.length, cz = b.p.reduce((s, q) => s + q[1], 0) / b.p.length; console.log('  pit bldg', ll([cx, cz]).join(','), 'dist from p0', Math.hypot(cx - P[0][0], cz - P[0][1]).toFixed(0)); }
}
