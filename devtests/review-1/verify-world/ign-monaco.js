// node devtests/review-1/verify-world/ign-monaco.js [stepMetres]
// Monaco centreline every ~step m against the IGN altimetry service (RGE ALTI / world resource: a terrain model), compared
// with the game's elev[]. Cached in out/ign-mc-1929.json.
const fs = require('fs'), path = require('path');
global.window = global;
require(path.join(__dirname, '..', '..', '..', 'tracks-data.js'));
const STEP = +(process.argv[2] || 40);
(async () => {
  const t = window.F1_TRACKS.find(x => x.id === 'mc-1929'), g = t.geo, P = t.points, E = t.elev, n = P.length, cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]));
  const total = cum[n], m = Math.round(total / STEP), ds = total / m, pts = [];
  for (let k = 0, i = 0; k < m; k++) {
    const s = k * ds;
    while (i < n - 1 && cum[i + 1] <= s) i++;
    const f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1), j = (i + 1) % n;
    const x = P[i][0] + (P[j][0] - P[i][0]) * f, z = P[i][1] + (P[j][1] - P[i][1]) * f;
    pts.push({ s, lat: g.lat0 + z / g.kz, lon: g.lon0 + x / g.kx, game: E[i] + (E[j] - E[i]) * f });
  }
  const cf = path.join(__dirname, 'out', 'ign-mc-1929.json');
  let c = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, 'utf8')) : null;
  if (!c || c.length !== pts.length) {
    const url = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=' + pts.map(p => p.lon.toFixed(6)).join('|') +
      '&lat=' + pts.map(p => p.lat.toFixed(6)).join('|') + '&resource=ign_rge_alti_wld&zonly=true';
    const r = await fetch(url), j = await r.json();
    j.elevations.forEach((z, k) => { pts[k].ign = +z; });
    fs.writeFileSync(cf, JSON.stringify(pts)); c = pts;
  }
  const u = c.map(p => p.ign).filter(v => v > -100), gm = c.map(p => p.game);
  let ug = 0, gg = 0, ugAt = 0, ggAt = 0;
  for (let k = 0; k < c.length; k++) {
    const a = c[k], b = c[(k + 2) % c.length];
    const v = Math.abs(b.ign - a.ign) / (2 * ds); if (a.ign > -100 && b.ign > -100 && v > ug) { ug = v; ugAt = a.s; }
    const w = Math.abs(b.game - a.game) / (2 * ds); if (w > gg) { gg = w; ggAt = a.s; }
  }
  const umin = Math.min(...u);
  console.log(`mc-1929: ${c.length} points every ${ds.toFixed(0)} m | IGN range ${(Math.max(...u) - umin).toFixed(1)} m (${umin.toFixed(1)}..${Math.max(...u).toFixed(1)} m), max ${(2 * ds).toFixed(0)} m grade ${(ug * 100).toFixed(1)} % at s=${ugAt.toFixed(0)} | game range ${(Math.max(...gm) - Math.min(...gm)).toFixed(1)} m, max grade ${(gg * 100).toFixed(1)} % at s=${ggAt.toFixed(0)}`);
  console.log('   profile (s: ign-min / game):', c.filter((_, k) => k % 3 === 0).map(p => Math.round(p.s) + ':' + (p.ign - umin).toFixed(1) + '/' + p.game.toFixed(1)).join(' '));
})();
