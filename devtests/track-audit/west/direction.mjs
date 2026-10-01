// node devtests/track-audit/west/direction.mjs <id> <overpass-cache> <relationId> : racing direction check. For every
// oneway=yes member way (and oneway pit lanes) of the circuit relation, does its node order (= OSM's direction of
// travel) run with the game's lap (s increasing)? Counts metres with / against.
import { loadGame, gameArrays, loadOverpass, r } from './lib-audit.mjs';
const [id, cache, relId] = process.argv.slice(2);
const g = loadGame(id), A = gameArrays(g), J = loadOverpass(cache);
const near = (x, y) => { let b = Infinity, bi = 0; for (let i = 0; i < A.N; i++) { const d = (A.xy[i][0] - x) ** 2 + (A.xy[i][1] - y) ** 2; if (d < b) { b = d; bi = i; } } return { s: A.s[bi], d: Math.sqrt(b) }; };
const rel = J.elements.find((e) => String(e.id) === relId);
let w = 0, a = 0; const rows = [];
for (const m of rel.members) {
  if (m.type !== 'way' || !m.geometry) continue;
  // tags of members are not in "out geom": look the way up in any cached answer of this circuit
  const tagsSrc = ['-raceway', '-tunnels-bridges'].map((s) => loadOverpass(id + s)).filter(Boolean);
  let tags = null; for (const T of tagsSrc) { const e = T.elements.find((q) => q.id === m.ref); if (e && e.tags) { tags = e.tags; break; } }
  const oneway = tags && (tags.oneway === 'yes' || tags.oneway === '1');
  if (!oneway && m.role !== 'forward' && m.role !== 'backward') continue;
  let along = 0, against = 0;
  for (let i = 1; i < m.geometry.length; i++) {
    const p = near(...A.proj.to(m.geometry[i - 1].lat, m.geometry[i - 1].lon)), q = near(...A.proj.to(m.geometry[i].lat, m.geometry[i].lon));
    if (p.d > 20 || q.d > 20) continue;
    let ds = q.s - p.s; if (ds > A.L / 2) ds -= A.L; if (ds < -A.L / 2) ds += A.L;
    if (ds >= 0) along += ds; else against -= ds;
  }
  const flip = m.role === 'backward';
  if (flip) [along, against] = [against, along];
  w += along; a += against;
  rows.push(`${m.ref}${m.role ? '(' + m.role + ')' : ''}${oneway ? ' oneway' : ''}: with ${r(along, 0)} m, against ${r(against, 0)} m`);
}
console.log(id, 'oneway / role-directed members: with the game direction', r(w, 0), 'm, against', r(a, 0), 'm');
console.log(rows.join('\n'));
