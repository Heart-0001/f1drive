// node devtests/tunnel-test/osm-match.js [trackId ...]   (after osm-fetch.mjs)
// For every circuit: which stretches of the GAME track (js/track.js samples) are covered according to OpenStreetMap.
//  - "covered": a road / raceway way tagged tunnel=* (not no) or covered=yes (not a footway / cycleway / platform / rail /
//    waterway) that runs ALONG the centreline: every 1 m of the way within halfW + 4 m of the centreline and within
//    30 deg of its direction marks the nearest sample. Runs shorter than 12 m are dropped, runs closer than 20 m merged.
//  - "overhead": structures over the circuit (man_made=bridge, highway / railway bridges, buildings with layer >= 1 or a
//    min_height) whose outline / line crosses the road: listed with their sample range (the car drives under them).
// Prints a table per track and writes devtests/tunnel-test/osm-match.json.
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
const want = process.argv.slice(2);
const ROADISH = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|raceway)(_link)?$/;
const out = {};

function toXZ(g, n) { return [(n.lon - g.lon0) * g.kx, (n.lat - g.lat0) * g.kz]; }
function runsOf(mask, N) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < N; i++) {
    if (mask[i] && start < 0) start = i;
    if (!mask[i] && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, N - 1]);
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === N - 1) { runs[0][0] = runs.pop()[0] - N; }
  return runs;
}

for (const t of global.F1_TRACKS) {
  if (want.length && !want.includes(t.id)) continue;
  const file = path.join(__dirname, 'cache', t.id + '.json');
  if (!fs.existsSync(file)) { console.log(t.id + ': no cache'); continue; }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tr = global.F1.buildTrack(t), S = tr.samples, N = S.length, ds = tr.length / N, g = t.geo;
  const covMask = new Uint8Array(N), covBy = new Array(N);
  const overhead = [];
  for (const e of j.elements) {
    const tg = e.tags || {}, geom = e.geometry;
    if (!geom || geom.length < 2) continue;
    const isCovered = ((tg.tunnel && tg.tunnel !== 'no') || (tg.covered && tg.covered !== 'no')) && ROADISH.test(tg.highway || '');
    const isOver = tg.man_made === 'bridge' || ((tg.bridge && tg.bridge !== 'no') && (tg.highway || tg.railway)) ||
      ((tg.building || tg['building:part']) && ((+tg.layer >= 1) || tg.min_height || tg.building === 'bridge'));
    if (!isCovered && !isOver) continue;
    const P = geom.map((n) => toXZ(g, n));
    if (isCovered) {
      let hits = 0;
      for (let k = 0; k + 1 < P.length; k++) {
        const ax = P[k][0], az = P[k][1], bx = P[k + 1][0], bz = P[k + 1][1], L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-6) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L;
        for (let s = 0; s <= L; s += 1) {
          const x = ax + ux * s, z = az + uz * s, n = tr.nearest(x, z), sm = S[n.index];
          if (Math.abs(n.d) > sm.halfW + 4) continue;
          if (Math.abs(ux * sm.tx + uz * sm.tz) < Math.cos(30 * Math.PI / 180)) continue;
          covMask[n.index] = 1; hits++;
          (covBy[n.index] = covBy[n.index] || new Set()).add(e.id + ' ' + (tg.name || tg['tunnel:name'] || tg.highway) + (tg.tunnel ? ' tunnel=' + tg.tunnel : '') + (tg.covered ? ' covered=' + tg.covered : '') + (tg.layer ? ' layer=' + tg.layer : ''));
        }
      }
    }
    if (isOver) {
      // samples whose road cross-section (|d| <= halfW) the line / outline crosses
      const closed = P.length > 3 && geom[0].lat === geom[geom.length - 1].lat && geom[0].lon === geom[geom.length - 1].lon;
      const hit = new Set();
      for (let k = 0; k + 1 < P.length; k++) {
        const ax = P[k][0], az = P[k][1], bx = P[k + 1][0], bz = P[k + 1][1], L = Math.hypot(bx - ax, bz - az);
        for (let s = 0; s <= L; s += 1) {
          const x = ax + (bx - ax) * s / (L || 1), z = az + (bz - az) * s / (L || 1), n = tr.nearest(x, z);
          if (Math.abs(n.d) <= S[n.index].halfW) hit.add(n.index);
        }
      }
      if (closed) {   // outline: also every sample whose centreline point is inside the polygon
        for (let i = 0; i < N; i++) {
          let inside = false;
          for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
            if (((P[a][1] > S[i].z) !== (P[b][1] > S[i].z)) && (S[i].x < (P[b][0] - P[a][0]) * (S[i].z - P[a][1]) / (P[b][1] - P[a][1]) + P[a][0])) inside = !inside;
          }
          if (inside) hit.add(i);
        }
      }
      if (hit.size) {
        const idx = [...hit].sort((a, b) => a - b);
        overhead.push({ way: e.id, what: tg.man_made === 'bridge' ? 'man_made=bridge' : (tg.building ? 'building=' + tg.building : (tg.highway ? 'highway=' + tg.highway + ' bridge' : 'railway bridge')),
          name: tg.name || '', layer: tg.layer || '', min_height: tg.min_height || '', samples: [idx[0], idx[idx.length - 1]],
          s: [Math.round(S[idx[0]].s), Math.round(S[idx[idx.length - 1]].s)], n: idx.length });
      }
    }
  }
  // close small gaps, drop short runs
  const gap = Math.round(20 / ds);
  let runs = runsOf(covMask, N);
  for (let r = 0; r + 1 < runs.length; r++) {
    if (runs[r + 1][0] - runs[r][1] <= gap) { runs[r][1] = runs[r + 1][1]; runs.splice(r + 1, 1); r--; }
  }
  runs = runs.filter((r) => (r[1] - r[0] + 1) * ds >= 12);
  const res = runs.map((r) => {
    const ways = new Set();
    for (let i = r[0]; i <= r[1]; i++) { const b = covBy[(i + N) % N]; if (b) for (const w of b) ways.add(w); }
    const a = (r[0] + N) % N, b = (r[1] + N) % N;
    return { from: a, to: b, sFrom: +S[a].s.toFixed(1), sTo: +S[b].s.toFixed(1), fFrom: +(S[a].s / tr.length).toFixed(5), fTo: +(S[b].s / tr.length).toFixed(5),
      len: Math.round((r[1] - r[0] + 1) * ds), ways: [...ways] };
  });
  out[t.id] = { name: t.name, N, length: +tr.length.toFixed(1), covered: res, overhead };
  console.log(`${t.id.padEnd(8)} ${t.name.padEnd(40)} covered: ${res.length ? res.map((r) => `${r.from}..${r.to} (${r.sFrom}..${r.sTo} m, ${r.len} m) ${r.ways.join(' | ')}`).join('; ') : '-'}`);
  for (const o of overhead) console.log(`         overhead: ${o.what} ${o.name} way ${o.way} layer ${o.layer} min_h ${o.min_height}: samples ${o.samples[0]}..${o.samples[1]} (${o.s[0]}..${o.s[1]} m, ${o.n} samples)`);
  tr.dispose();
}
const prev = fs.existsSync(path.join(__dirname, 'osm-match.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'osm-match.json'), 'utf8')) : {};
fs.writeFileSync(path.join(__dirname, 'osm-match.json'), JSON.stringify(Object.assign(prev, out), null, 1));
