// node devtests/track-audit/apac/osm-inspect.mjs <id> -- lists the OSM raceway ways, start/finish / pit nodes, bridges / tunnels near the track
import { loadOSM } from './osmline.mjs';
import { track, toXZ, project } from './common.mjs';
const id = process.argv[2], t = track(id), els = loadOSM(id);
const P = t.points;
const near = (g) => { let best = Infinity; for (const q of g) { const [x, z] = toXZ(t, q.lat, q.lon); best = Math.min(best, project(P, x, z).dist); } return best; };
const len = (g) => { let L = 0; for (let i = 1; i < g.length; i++) { const [x0, z0] = toXZ(t, g[i - 1].lat, g[i - 1].lon), [x1, z1] = toXZ(t, g[i].lat, g[i].lon); L += Math.hypot(x1 - x0, z1 - z0); } return L; };
console.log('--- raceway ways');
for (const e of els) if (e.type === 'way' && e.tags && (e.tags.highway === 'raceway' || e.tags.raceway)) {
  console.log(e.id, JSON.stringify(e.tags).slice(0, 260), 'len', len(e.geometry).toFixed(0), 'near', near(e.geometry).toFixed(1));
}
console.log('--- nodes (start/finish/pit/raceway)');
for (const e of els) if (e.type === 'node' && e.tags && (e.tags.raceway || /start|finish|grid|pit|ピット|スタート/i.test(JSON.stringify(e.tags)))) {
  const [x, z] = toXZ(t, e.lat, e.lon), pr = project(P, x, z);
  console.log(e.id, e.lat, e.lon, JSON.stringify(e.tags).slice(0, 200), 's', pr.s.toFixed(0), 'dist', pr.dist.toFixed(1));
}
console.log('--- bridges / tunnels / covered within 30 m of the centreline');
for (const e of els) if (e.type === 'way' && e.tags && (e.tags.bridge || e.tags.tunnel || e.tags.covered || e.tags.man_made === 'bridge' || e.tags.building === 'bridge' || e.tags.min_height || (e.tags.building && e.tags.layer))) {
  const d = near(e.geometry);
  if (d < 30) {
    const ss = e.geometry.map((q) => { const [x, z] = toXZ(t, q.lat, q.lon); return project(P, x, z).s; });
    console.log(e.id, JSON.stringify(e.tags).slice(0, 220), 'len', len(e.geometry).toFixed(0), 'near', d.toFixed(1), 's', Math.min(...ss).toFixed(0), '-', Math.max(...ss).toFixed(0));
  }
}
console.log('--- relations');
for (const e of els) if (e.type === 'relation' && e.tags && /circuit|raceway|grand prix|track|sport|motor/i.test(JSON.stringify(e.tags))) console.log(e.id, JSON.stringify(e.tags).slice(0, 300), 'members', (e.members || []).length);
