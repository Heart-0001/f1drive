// node devtests/track-audit/verify/overhead.js
// Re-queries OSM (API 0.6 /map, small boxes, one request at a time, 2.5 s apart, cached in cache/verify/osmapi/) around
// the stretches where an auditor reported a structure over the track or a covered section, and lists every way that
// crosses the game's built centreline there, with the tags that say whether it passes over or under the lap.
'use strict';
const L = require('./lib.js');
const fs = L.fs, path = L.path;
const DIR = path.join(L.CACHE, 'verify', 'osmapi');
fs.mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchBox(key, b) {
  const f = path.join(DIR, key + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${b[1].toFixed(6)},${b[0].toFixed(6)},${b[3].toFixed(6)},${b[2].toFixed(6)}`;
  for (let a = 0; a < 4; a++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'F1Drive-track-audit/1 (one-off verification, cached)' } });
    if (res.ok) { const j = await res.json(); fs.writeFileSync(f, JSON.stringify(j)); await sleep(2500); return j; }
    console.warn('  HTTP', res.status, (await res.text()).slice(0, 120), 'retry'); await sleep(5000 * (a + 1));
  }
  throw new Error('OSM API failed for ' + key);
}
const CHECKS = [
  ['ca-1978', 2080, 2170, 'Montreal: bridge underpass before T8 (Pont de la Concorde)'],
  ['sg-2008', 150, 320, 'Marina Bay: T1 under the ECP viaduct'],
  ['sg-2008', 480, 1060, 'Marina Bay: T3-T5 under the ECP / Sheares ramps'],
  ['sg-2008', 1200, 1290, 'Marina Bay: Raffles Boulevard building passage'],
  ['sg-2008', 4240, 4380, 'Marina Bay: before the line, under the Benjamin Sheares Bridge'],
  ['ae-2009', 4380, 4480, 'Yas Marina: under the W hotel link'],
  ['ae-2009', 180, 340, 'Yas Marina: pit exit tunnel under T1'],
  ['mc-1929', 1380, 1900, 'Monaco: Portier underpass + Fairmont tunnel'],
  ['es-2026', 1330, 1480, 'Madring: tunnel 1'],
  ['es-2026', 3840, 4030, 'Madring: Valdebebas - IFEMA tunnel'],
  ['jp-1962', 2290, 2350, 'Suzuka: crossover (lower road)'],
  ['us-2022', 3340, 3530, 'Miami: Turnpike ramps over T13-T16'],
  ['cn-2004', 5000, 5430, 'Shanghai: grandstand wings over the straight'],
];
(async () => {
  const res = [];
  for (const [id, s0, s1, label] of CHECKS) {
    const g = L.game(id);
    let la0 = Infinity, lo0 = Infinity, la1 = -Infinity, lo1 = -Infinity;
    for (let s = s0; s <= s1; s += 2) { const q = g.at(s), [la, lo] = g.ll(q.x, q.z); la0 = Math.min(la0, la); la1 = Math.max(la1, la); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); }
    const pad = 30 / 111000, pl = pad / Math.cos(la0 * Math.PI / 180);
    const key = `${id}-${s0}-${s1}`;
    const j = await fetchBox(key, [la0 - pad, lo0 - pl, la1 + pad, lo1 + pl]);
    const nodes = new Map(); for (const e of j.elements) if (e.type === 'node') nodes.set(e.id, e);
    const found = [];
    for (const w of j.elements.filter((e) => e.type === 'way')) {
      const t = w.tags || {}, c = w.nodes.map((n) => nodes.get(n)).filter(Boolean);
      const cross = [];
      for (let i = 0; i + 1 < c.length; i++) {
        const a = g.xz(c[i].lat, c[i].lon), b = g.xz(c[i + 1].lat, c[i + 1].lon);
        for (let k = Math.floor(s0 / g.ds); k <= Math.ceil(s1 / g.ds); k++) {
          const p = g.S[k % g.N], q = g.S[(k + 1) % g.N];
          if (L.segX(a, b, [p.x, p.z], [q.x, q.z])) cross.push(Math.round(p.s));
        }
      }
      const isRace = t.highway === 'raceway' || t.sport === 'motor';
      const raised = (t.bridge && t.bridge !== 'no') || +(t.layer || 0) > 0 || t['building:part'] || t.min_height || t.tunnel || t.covered;
      if (isRace) {
        // lap ways along the stretch: are they tunnel / covered / bridge?
        if ((t.tunnel && t.tunnel !== 'no') || t.covered === 'yes' || (t.bridge && t.bridge !== 'no') || +(t.layer || 0) !== 0) {
          const near = c.filter((n) => g.project(n.lat, n.lon).dist < 15).map((n) => Math.round(g.project(n.lat, n.lon).s));
          if (near.length) found.push({ way: w.id, lap: true, tags: pick(t), s: [Math.min(...near), Math.max(...near)] });
        }
        continue;
      }
      if (!cross.length || !raised) continue;
      found.push({ way: w.id, tags: pick(t), crossesLapAt: [...new Set(cross)] });
    }
    res.push({ id, s: [s0, s1], label, found });
    console.log(`\n${id} ${s0}-${s1} ${label}`);
    for (const f of found) console.log(`  ${f.lap ? 'LAP ' : ''}${f.way} ${JSON.stringify(f.tags)} ${f.lap ? 's ' + f.s.join('-') : 'crosses at s ' + f.crossesLapAt.join(',')}`);
  }
  fs.writeFileSync(path.join(__dirname, 'out-overhead.json'), JSON.stringify(res, null, 1));
})();
function pick(t) {
  const o = {};
  for (const k of ['name', 'highway', 'railway', 'man_made', 'building', 'building:part', 'bridge', 'tunnel', 'covered', 'layer', 'level', 'min_height', 'height', 'maxheight', 'raceway', 'description', 'note']) if (t[k] !== undefined) o[k] = String(t[k]).slice(0, 80);
  return o;
}
