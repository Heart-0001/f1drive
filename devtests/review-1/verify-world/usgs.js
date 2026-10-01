// node devtests/review-1/verify-world/usgs.js us-2023,us-2012 [stepMetres]
// Samples the centreline every ~step m, asks the USGS Elevation Point Query Service (3DEP bare-earth lidar DEM, 1 m
// where available) for the ground height and compares range / grades with the game's elev[] at the same points.
// Results cached in out/usgs-<id>.json.
const fs = require('fs'), path = require('path');
global.window = global;
require(path.join(__dirname, '..', '..', '..', 'tracks-data.js'));
const ids = (process.argv[2] || 'us-2023,us-2012').split(',');
const STEP = +(process.argv[3] || 50);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function q(lat, lon) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(`https://epqs.nationalmap.gov/v1/json?x=${lon.toFixed(6)}&y=${lat.toFixed(6)}&wkid=4326&units=Meters&includeDate=false`);
      if (r.ok) { const j = await r.json(); const v = +j.value; if (isFinite(v) && v > -1000) return v; }
    } catch (e) {}
    await sleep(1000 * (a + 1));
  }
  return NaN;
}
(async () => {
  for (const id of ids) {
    const t = window.F1_TRACKS.find(x => x.id === id), g = t.geo, P = t.points, E = t.elev, n = P.length, cum = [0];
    for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]));
    const total = cum[n], m = Math.round(total / STEP), ds = total / m, pts = [];
    for (let k = 0, i = 0; k < m; k++) {
      const s = k * ds;
      while (i < n - 1 && cum[i + 1] <= s) i++;
      const f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1), j = (i + 1) % n;
      const x = P[i][0] + (P[j][0] - P[i][0]) * f, z = P[i][1] + (P[j][1] - P[i][1]) * f;
      pts.push({ s, lat: g.lat0 + z / g.kz, lon: g.lon0 + x / g.kx, game: E[i] + (E[j] - E[i]) * f });
    }
    const cf = path.join(__dirname, 'out', 'usgs-' + id + '.json');
    let cache = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, 'utf8')) : null;
    if (!cache || cache.length !== pts.length) {
      for (let a = 0; a < pts.length; a += 8) {
        const vs = await Promise.all(pts.slice(a, a + 8).map(p => q(p.lat, p.lon)));
        vs.forEach((v, b) => { pts[a + b].usgs = v; });
      }
      fs.writeFileSync(cf, JSON.stringify(pts));
      cache = pts;
    }
    const u = cache.map(p => p.usgs).filter(v => v === v), gm = cache.map(p => p.game);
    const umin = Math.min(...u), umax = Math.max(...u);
    let ug = 0, gg = 0, ugAt = 0;
    for (let k = 0; k < cache.length; k++) {
      const a = cache[k], b = cache[(k + 2) % cache.length];          // grade over 2 steps (~100 m)
      if (a.usgs === a.usgs && b.usgs === b.usgs) { const v = Math.abs(b.usgs - a.usgs) / (2 * ds); if (v > ug) { ug = v; ugAt = a.s; } }
      gg = Math.max(gg, Math.abs(b.game - a.game) / (2 * ds));
    }
    console.log(`${id}: ${cache.length} points every ${ds.toFixed(0)} m, ${cache.length - u.length} failed | USGS 3DEP range ${(umax - umin).toFixed(1)} m (${umin.toFixed(1)}..${umax.toFixed(1)} m ASL), max 100 m grade ${(ug * 100).toFixed(1)} % at s=${ugAt.toFixed(0)} | game elev range ${(Math.max(...gm) - Math.min(...gm)).toFixed(1)} m, max 100 m grade ${(gg * 100).toFixed(1)} %`);
    console.log('   profile (s: usgs-min / game):', cache.filter((_, k) => k % 4 === 0).map(p => Math.round(p.s) + ':' + (p.usgs - umin).toFixed(1) + '/' + p.game.toFixed(1)).join(' '));
  }
})();
