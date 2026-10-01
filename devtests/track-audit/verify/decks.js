// node devtests/track-audit/verify/decks.js
// Game-wide list of the scenery "bridge" polygons (OSM man_made=bridge outlines in scenery-data.js) that js/scenery.js
// addBridge() builds as a deck OVER the road: the polygon contains centreline samples over <= 60 m (longer = the road
// runs along it, dropped). Writes cache/verify/decks.json: per deck the track, s range, lat/lon outline and bbox.
'use strict';
const L = require('./lib.js');
const out = [];
for (const T of window.F1_TRACKS) {
  const sc = (window.F1_SCENERY || {})[T.id];
  if (!sc) continue;
  const g = L.game(T.id);
  (sc.buildings || []).forEach((b, bi) => {
    if (b.k !== 'bridge') return;
    const p = b.p, inside = [];
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const q of p) { bx0 = Math.min(bx0, q[0]); bx1 = Math.max(bx1, q[0]); bz0 = Math.min(bz0, q[1]); bz1 = Math.max(bz1, q[1]); }
    for (let i = 0; i < g.N; i++) {
      const s = g.S[i];
      if (s.x < bx0 || s.x > bx1 || s.z < bz0 || s.z > bz1) continue;
      if (L.pointInPoly(s.x, s.z, p)) inside.push(i);
    }
    // nearest approach of the polygon outline to the centreline (for "beside the road" decks)
    let dmin = Infinity;
    for (const q of p) { const pr = g.project(...g.ll(q[0], q[1])); dmin = Math.min(dmin, pr.dist); }
    const over = inside.length > 0 && inside.length * g.ds <= 60;
    const ll = p.map((q) => g.ll(q[0], q[1]).map((v) => +v.toFixed(7)));
    const lats = ll.map((q) => q[0]), lons = ll.map((q) => q[1]);
    const area = Math.abs(p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0) / 2);
    out.push({ id: T.id, idx: bi, h: b.h, over, insideM: +(inside.length * g.ds).toFixed(1),
      s: inside.length ? [+g.S[inside[0]].s.toFixed(0), +g.S[inside[inside.length - 1]].s.toFixed(0)] : null,
      outlineMinDistM: +dmin.toFixed(1), areaM2: Math.round(area),
      bbox: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)], ll });
  });
}
L.fs.mkdirSync(L.path.join(L.CACHE, 'verify'), { recursive: true });
L.fs.writeFileSync(L.path.join(L.CACHE, 'verify', 'decks.json'), JSON.stringify(out, null, 1));
const ov = out.filter((d) => d.over);
console.log(`${out.length} scenery bridge polygons in ${new Set(out.map((d) => d.id)).size} circuits; ${ov.length} built over the road:`);
for (const d of ov) console.log(`  ${d.id} #${d.idx} s ${d.s.join('-')} inside ${d.insideM} m area ${d.areaM2} m2 centre ${((d.bbox[0] + d.bbox[2]) / 2).toFixed(6)},${((d.bbox[1] + d.bbox[3]) / 2).toFixed(6)}`);
