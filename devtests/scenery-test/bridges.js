// node devtests/scenery-test/bridges.js [trackId ...] [--json out.json]
// Every scenery 'bridge' (scenery-data.js) as js/scenery.js builds it on the current js/track.js + tracks-data.js:
// decks built OVER the road (the lap passes under them: s range, centre lat/lon, OSM way id when the data carries it,
// the deck's underside above the road) and the ones left out. Then the checks of the 2026-10-01 audit:
//   - the 6 phantom decks (the lap's own deck over an underpass) are not built: be-1925 1353164215, nl-1948 765476850,
//     de-1932 1302356195 / 1302600377 / 1302600378, de-1927 790945811 (by OSM id where the data has ids, else by place)
//   - the 5 real ones are: de-1927 34444288 (BMW-Bruecke), gb-1948 605922107, ae-2009 1473728620 / 1473750056,
//     us-2023 1419057401
//   - the structures over the track the audit asked for: Montreal before T8 (s ~2114-2134), Marina Bay ECP / Benjamin
//     Sheares (s ~196-260, 520-1030, 4280-4340)
//   - no deck over a covered stretch of js/tunnels.js, none over the track's own bridge (Suzuka), every deck over the
//     road at least 6.5 m above it, every pier outside the corridor (no ground footprint inside it)
// Exit code 1 when a check fails.
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
require(path.join(ROOT, 'js', 'scenery.js'));
try { require(path.join(ROOT, 'js', 'tunnels.js')); } catch (e) { /* optional */ }
F1.SCENERY_DEBUG = true;

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;
const only = args.filter((a, i) => !a.startsWith('--') && (jsonAt < 0 || i !== jsonAt + 1));

// place of each audited deck: centre [lat, lon] (devtests/track-audit/verify/out-decks.json)
const PHANTOM = [
  ['be-1925', 1353164215, [50.443972, 5.968381]],
  ['nl-1948', 765476850, [52.387094, 4.539548]],
  ['de-1932', 1302600378, [49.32772, 8.573642]],
  ['de-1932', 1302356195, [49.332038, 8.566381]],
  ['de-1932', 1302600377, [49.327036, 8.571949]],
  ['de-1927', 790945811, [50.330336, 6.939514]],
];
const REAL = [
  ['de-1927', 34444288, [50.335177, 6.947221]], ['gb-1948', 605922107, [52.067474, -1.013238]],
  ['ae-2009', 1473728620, [24.466987, 54.602824]], ['ae-2009', 1473750056, [24.467879, 54.604757]],
  ['us-2023', 1419057401, [36.115297, -115.172882]],
];
const WANT = [   // [track, s0, s1, what]: some deck over the road with its crossing inside s0..s1
  ['ca-1978', 2090, 2160, 'Montreal: bridge underpass before T8'],
  ['sg-2008', 180, 270, 'Marina Bay: T1 under the ECP'],
  ['sg-2008', 500, 1040, 'Marina Bay: T3-T5 under the ECP / Sheares ramps'],
  ['sg-2008', 4260, 4350, 'Marina Bay: before the line under the Benjamin Sheares Bridge'],
];

let fails = 0;
const fail = (m) => { fails++; console.log('  FAIL ' + m); };
const rows = [];
const byTrack = {};
for (const td of F1_TRACKS) {
  if (only.length && !only.includes(td.id)) continue;
  const data = (window.F1_SCENERY || {})[td.id];
  if (!data) continue;
  const bridges = (data.buildings || []).map((b, i) => ({ b, i })).filter((q) => q.b.k === 'bridge');
  if (!bridges.length) { byTrack[td.id] = []; continue; }
  const track = F1.buildTrack(td), S = track.samples, N = S.length, ds = track.length / N, g = td.geo;
  const ll = (x, z) => [g.lat0 + z / g.kz, g.lon0 + x / g.kx];
  const sc = F1.buildScenery(track, td, data);
  const dk = sc.debug.footprints.filter((f) => f.k === 'bridge');
  const piers = sc.debug.footprints.filter((f) => f.k === 'pier');
  // covered stretches of js/tunnels.js on this track
  let cov = null;
  if (typeof F1.buildTunnels === 'function') {
    const tun = F1.buildTunnels(track, td);
    if (tun.tunnels.length) { cov = new Uint8Array(N); for (let i = 0; i < N; i++) cov[i] = tun.covered(i) ? 1 : 0; }
    tun.dispose();
  }
  const pip = (x, z, p) => { let c = false; for (let a = 0, b = p.length - 1; a < p.length; b = a++) { if (((p[a][1] > z) !== (p[b][1] > z)) && (x < (p[b][0] - p[a][0]) * (z - p[a][1]) / (p[b][1] - p[a][1]) + p[a][0])) c = !c; } return c; };
  const list = [];
  for (const { b, i } of bridges) {
    const f = dk.find((q) => q.src === i) || dk.find((q) => q.p === b.p) || null;
    const inside = [];
    for (let s = 0; s < N; s++) if (pip(S[s].x, S[s].z, b.p)) inside.push(s);
    let cx = 0, cz = 0; for (const q of b.p) { cx += q[0]; cz += q[1]; } cx /= b.p.length; cz /= b.p.length;
    const c = ll(cx, cz);
    let clear = null, onCov = 0;
    if (f && f.over && inside.length) {
      clear = Infinity;
      for (const s of inside) {
        const y = Math.max(track.surfaceY ? track.surfaceY(s, 0) : S[s].y, S[s].y);
        clear = Math.min(clear, f.minY - y);
        if (cov && cov[s]) onCov++;
      }
    }
    const r = { id: td.id, idx: i, o: b.o || null, h: b.h, built: !!f, over: !!(f && f.over), why: f ? '' : (b.lap ? 'lap deck' : 'left out'),
      s: inside.length ? [Math.round(S[inside[0]].s), Math.round(S[inside[inside.length - 1]].s)] : null, insideM: +(inside.length * ds).toFixed(1),
      centre: [+c[0].toFixed(6), +c[1].toFixed(6)], clearM: clear === null ? null : +clear.toFixed(2), onCovered: onCov };
    list.push(r);
    if (r.over) {
      if (!(r.clearM >= 6.5 - 1e-6)) fail(`${td.id} #${i} deck ${r.clearM} m above the road (< 6.5)`);
      if (onCov) fail(`${td.id} #${i} deck over ${onCov} covered sample(s) of js/tunnels.js`);
      if (track.bridges && track.bridges.length) {
        for (const br of track.bridges) {
          for (const s of inside) if (Math.abs(((s - br.up + N / 2) % N + N) % N - N / 2) * ds < 60) { fail(`${td.id} #${i} deck over the track's own bridge (upper road, sample ${s})`); break; }
        }
      }
    }
  }
  // piers: no ground footprint inside the corridor (the scenery-test rule, again here for the decks)
  for (const pr of piers) {
    const [x, z] = [(pr.p[0][0] + pr.p[2][0]) / 2, (pr.p[0][1] + pr.p[2][1]) / 2];
    if (track.inCorridor && track.inCorridor(x, z, 0)) fail(`${td.id}: pier at ${x.toFixed(1)}, ${z.toFixed(1)} inside the corridor`);
  }
  sc.dispose(); track.dispose();
  byTrack[td.id] = list;
  for (const r of list) rows.push(r);
}

console.log('decks built over the road:');
for (const r of rows.filter((q) => q.over)) {
  console.log(`  ${r.id.padEnd(8)} #${String(r.idx).padEnd(4)} ${r.o ? ('osm ' + r.o).padEnd(16) : ''.padEnd(16)} s ${r.s.join('-').padEnd(10)} inside ${String(r.insideM).padStart(5)} m  ` +
    `underside +${r.clearM} m  centre ${r.centre.join(',')}`);
}
const besides = rows.filter((q) => q.built && !q.over).length, out = rows.filter((q) => !q.built);
console.log(`${rows.length} bridge footprints in ${Object.keys(byTrack).filter((k) => byTrack[k].length).length} tracks: ` +
  `${rows.filter((q) => q.over).length} over the road, ${besides} beside it, ${out.length} left out` +
  (out.length ? ' (' + out.map((q) => q.id + '#' + q.idx + (q.s ? ' s ' + q.s.join('-') : '') + (q.why ? ' ' + q.why : '')).join(', ') + ')' : ''));

console.log('\naudit checks:');
const near = (r, c, m) => { const dy = (r.centre[0] - c[0]) * 111000, dx = (r.centre[1] - c[1]) * 111000 * Math.cos(c[0] * Math.PI / 180); return Math.hypot(dx, dy) < m; };
for (const [id, osm, c] of PHANTOM) {
  if (!byTrack[id]) continue;
  const hit = byTrack[id].filter((r) => r.over && (r.o === osm || (!r.o && near(r, c, 25))));
  if (hit.length) fail(`${id}: phantom deck ${osm} is built over the road (#${hit.map((r) => r.idx).join(', #')})`);
  else console.log(`  ok   ${id} phantom ${osm} not built over the road`);
}
for (const [id, osm, c] of REAL) {
  if (!byTrack[id]) continue;
  const hit = byTrack[id].filter((r) => r.over && (r.o ? r.o === osm : near(r, c, 30)));
  if (!hit.length) fail(`${id}: real deck ${osm} is not built over the road`);
  else console.log(`  ok   ${id} real deck ${osm} built (#${hit.map((r) => r.idx).join(', #')}${hit[0].o ? '' : ', matched by place'})`);
}
for (const [id, s0, s1, what] of WANT) {
  if (!byTrack[id]) { if (!only.length || only.includes(id)) fail(`${id}: no scenery bridges at all (${what})`); continue; }
  const hit = byTrack[id].filter((r) => r.over && r.s && r.s[1] >= s0 && r.s[0] <= s1);
  if (!hit.length) fail(`${id}: nothing over the road at s ${s0}-${s1} (${what})`);
  else console.log(`  ok   ${id} ${what}: ${hit.length} deck(s) (s ${hit.map((r) => r.s.join('-')).join(', ')})`);
}
// js/scenery.js's own rule, on made-up decks (a 20 m square across the road): none over the track's own bridge
// (Suzuka's upper road) or over a covered stretch of js/tunnels.js (Monaco's tunnel); the same square elsewhere on the lap
// is built (control); c / t (underside above the road, thickness) are honoured.
if (!only.length) {
  console.log('\njs/scenery.js rule (made-up decks):');
  const square = (x, z, r) => [[x - r, z - r], [x + r, z - r], [x + r, z + r], [x - r, z + r]];
  const run = (id, at, extra, tunnelsOff) => {
    const td = F1_TRACKS.find((t) => t.id === id), track = F1.buildTrack(td), S = track.samples, N = S.length;
    const i = typeof at === 'function' ? at(track) : at, s = S[((i % N) + N) % N];
    const b = Object.assign({ k: 'bridge', h: 7, p: square(s.x, s.z, 10) }, extra || {});
    const keep = F1.TUNNEL_DATA;
    if (tunnelsOff) F1.TUNNEL_DATA = null;
    const sc = F1.buildScenery(track, td, { buildings: [b], areas: [], trees: [] });
    F1.TUNNEL_DATA = keep;
    const f = sc.debug.footprints.find((q) => q.k === 'bridge' && q.over) || null;
    const y = track.surfaceY ? track.surfaceY(((i % N) + N) % N, 0) : s.y;
    const res = { skipped: sc.stats.counts.decksSkipped, built: sc.stats.counts.decks, under: f ? f.minY - y : null, thick: f ? f.top - f.minY : null };
    sc.dispose(); track.dispose();
    return res;
  };
  const ok = (cond, m) => { if (cond) console.log('  ok   ' + m); else fail(m); };
  const up = (tr) => (tr.bridges && tr.bridges[0] ? tr.bridges[0].up : -1);
  let r = run('jp-1962', up);
  ok(r.skipped === 1 && r.built === 0, `Suzuka: a deck around the crossover (the upper road's own deck) is not built (${JSON.stringify(r)})`);
  r = run('jp-1962', (tr) => Math.round(tr.samples.length * 0.3));
  ok(r.skipped === 0 && r.built === 1 && r.under >= 6.5 - 1e-6, `Suzuka: the same deck elsewhere on the lap is built, ${r.under && r.under.toFixed(2)} m clear`);
  if (typeof F1.buildTunnels === 'function') {
    const mid = (tr) => { const tn = F1.buildTunnels(tr, F1_TRACKS.find((t) => t.id === 'mc-1929')), T = tn.tunnels.find((q) => q.kind === 'tunnel') || tn.tunnels[0]; tn.dispose(); return T ? Math.round((T.from + T.to) / 2) : -1; };
    r = run('mc-1929', mid);
    ok(r.skipped === 1 && r.built === 0, `Monaco: a deck over the tunnel (js/tunnels.js covers it) is not built (${JSON.stringify(r)})`);
    r = run('mc-1929', mid, null, true);
    ok(r.built === 1, `Monaco: without F1.TUNNEL_DATA the same deck is built (control, ${JSON.stringify(r)})`);
  } else console.log('  (js/tunnels.js not loaded: tunnel rule not checked)');
  r = run('it-1922', 300, { c: 12.5, t: 4 });
  ok(r.built === 1 && r.under >= 12.5 - 1e-6 && Math.abs(r.thick - 4) < 1e-6, `c / t honoured: underside ${r.under && r.under.toFixed(2)} m above the road, ${r.thick && r.thick.toFixed(2)} m thick`);
  r = run('it-1922', 300);
  ok(r.built === 1 && r.under >= 6.5 - 1e-6 && Math.abs(r.thick - 1.4) < 1e-6, `defaults: underside ${r.under && r.under.toFixed(2)} m, ${r.thick && r.thick.toFixed(2)} m thick`);
}

if (jsonOut) require('fs').writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall bridge checks passed');
process.exit(fails ? 1 : 0);
