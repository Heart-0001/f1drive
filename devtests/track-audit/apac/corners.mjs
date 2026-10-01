// node devtests/track-audit/apac/corners.mjs <id> -- named OSM raceway ways (corners / straights) as game arc-length ranges, plus the
// game's own corners (|curvature| peaks, radius < 250 m) with apex s, direction, min radius and the game's bank there.
import { resolve } from 'node:path';
import { HERE, track, toXZ, project, readJSON } from './common.mjs';
import { loadOSM } from './osmline.mjs';
export function namedWays(id) {
  const t = track(id), out = [];
  for (const e of loadOSM(id)) {
    if (e.type !== 'way' || !e.tags || e.tags.highway !== 'raceway' || !(e.tags.name || e.tags['raceway:corner_number'])) continue;
    const ss = e.geometry.map((q) => { const [x, z] = toXZ(t, q.lat, q.lon); return project(t.points, x, z); });
    if (Math.max(...ss.map((p) => p.dist)) > 15) continue;
    const s = ss.map((p) => p.s);
    out.push({ way: e.id, name: e.tags['name:en'] || e.tags.name, n: e.tags['raceway:corner_number'] || null, from: Math.round(Math.min(...s)), to: Math.round(Math.max(...s)) });
  }
  return out.sort((a, b) => a.from - b.from);
}
export function gameCorners(id) {
  const g = readJSON(resolve(HERE, 'out', 'game-' + id + '.json')), S = g.samples, N = S.length, out = [];
  const k = S.map((s) => s.k);
  for (let i = 0; i < N; i++) {
    const r = 1 / Math.max(1e-9, Math.abs(k[i]));
    if (r > 250) continue;
    let peak = true;
    for (let j = -15; j <= 15; j++) if (Math.abs(k[(i + j + N) % N]) > Math.abs(k[i])) { peak = false; break; }
    if (!peak) continue;
    // turn angle over the corner (where radius < 400 m around the apex)
    let a = i, b = i; while (1 / Math.abs(k[(a - 1 + N) % N]) < 400 && (i - a) < 200) a--; while (1 / Math.abs(k[(b + 1) % N]) < 400 && (b - i) < 200) b++;
    let ang = 0; for (let j = a; j <= b; j++) ang += k[(j + N) % N] * g.ds;
    out.push({ apexS: Math.round(S[i].s), dir: k[i] > 0 ? 'left' : 'right', minRadius: Math.round(r), turnDeg: Math.round(Math.abs(ang) * 180 / Math.PI), bankDeg: +S[i].bank.toFixed(1), gradePct: +(S[i].grade * 100).toFixed(1) });
  }
  return out;
}
if (process.argv[1] && process.argv[1].endsWith('corners.mjs')) {
  const id = process.argv[2];
  for (const w of namedWays(id)) console.log('osm', w.from, w.to, w.n || '', w.name);
  for (const c of gameCorners(id)) console.log('game corner', JSON.stringify(c));
}
