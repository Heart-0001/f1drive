// node devtests/tunnel-test/make-data.js [--check]
// Builds tools/tunnels.json (the covered stretches of the game's circuits, with their sources) from the OpenStreetMap
// responses cached by osm-fetch.mjs (devtests/tunnel-test/cache/<trackId>.json, ODbL) and the decisions below.
//   1. candidates: per circuit, every road / raceway way tagged tunnel=* (not no) or covered=yes that runs ALONG the
//      game's centreline (each metre of the way within halfW + 4 m of it and within 30 deg of its direction marks the
//      nearest sample; runs shorter than 12 m dropped, closer than 20 m merged) = osm-match.js's rule;
//   2. DECISIONS: what each candidate is (the circuit itself under a roof, or another road beneath / beside it), by its
//      OSM way ids, with the reason and the references;
//   3. for an included stretch: the portals = the first / last covered metre along the lap, as [lat, lon] (inverse of
//      trackData.geo) + fractions of the lap; `split` where the building over the entry ends (F1_SCENERY footprints);
//      `open` (a side open to the sea) where scenery-data.js's water lies within OPEN_REACH m beyond the tunnel block.
// --check: exit 1 unless tools/tunnels.json is what this script makes AND js/tunnels.js's F1.TUNNEL_DATA equals its
// "tracks". Without --check the file is written and the F1.TUNNEL_DATA literal is printed (paste it into js/tunnels.js).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
const CHECK = process.argv.includes('--check');
const CACHE = path.join(__dirname, 'cache');
const OUT = path.join(ROOT, 'tools', 'tunnels.json');
const ROADISH = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|raceway)(_link)?$/;
const OPEN_REACH = 16, WALL_GAP = 0.52, OUT_T = 1.1, OPEN_MIN = 60;

// ---- what the candidates are. key: trackId; each entry names the candidate by any of its OSM way ids.
const DECISIONS = {
  'mc-1929': [
    { ways: [4230891, 1230247123], include: true, name: 'Tunnel', kind: 'tunnel', facade: ['hotel', 'plain'], ads: 'monaco', split: 'buildings', open: 'water',
      why: 'Boulevard Louis II in the tunnel (tunnel=yes, layer=-1): the circuit itself. Entry under the Fairmont Monte-Carlo ' +
        '(OSM node 9944534420 tourism=hotel lies in scenery footprint #9 over the road), exit under the building next to the ' +
        'Auditorium Rainier III (OSM way 112689159; bus platform way 1230247124 "Auditorium Rainier III", covered=yes, is ' +
        'inside the tunnel at its exit) -> facades hotel / plain. The sea side (the driver\'s left) is open along the hotel ' +
        'part: "partly open on one side along the shoreline" (SGM), "partially open to the sea view beside the pedestrian ' +
        'walkway"; OSM sidewalk way 450334964 (tunnel=yes) runs on that side.',
      refs: ['https://www.openstreetmap.org/way/4230891', 'https://www.openstreetmap.org/way/1230247123',
        'https://www.openstreetmap.org/node/9944534420', 'https://www.openstreetmap.org/way/112689159',
        'https://en.wikipedia.org/wiki/Circuit_de_Monaco (1973: the tunnel extended towards Portier under the new Loews, now Fairmont, hotel)',
        'https://en.wikipedia.org/wiki/Fairmont_Monte_Carlo (built over part of the course on pillars over the sea)',
        'https://www.sgmlighting.com/projects/famous-tunnel-lit-by-sgm-fixtures-for-the-monaco-formula-1-grand-prix (partly open on one side along the shoreline; LED lighting since the drivers\' complaints)',
        'https://routes.fandom.com/wiki/Tunnel_Louis_II_(MC) (Tunnel Louis II / tunnel du Fairmont, about 400 m; seen through a search summary)'] },
    { ways: [1470365907, 1470365899, 1470365904, 353889280, 1470365900, 1470365903], include: true, name: 'Portier', kind: 'underpass', facade: 'plain', ads: 'monaco',
      why: 'The circuit\'s own raceway way 1470365907 at Portier is tagged tunnel=yes, layer=-1, together with the Rond-Point du ' +
        'Portier ways: since the Portier Cove / Mareterra works (roundabout finished 2020) the corner passes under the ' +
        'roundabout\'s "virole" (OSM building way 1470365896 "Neuehouse" = scenery footprint #17 over the road) and the ' +
        'Boulevard du Larvotto bridge (way 92627405, bridge=yes, layer=1). Mapped from 2023-12 Bing imagery; nobody here has seen ' +
        'it in a race onboard: lower confidence than the tunnel.',
      refs: ['https://www.openstreetmap.org/way/1470365907', 'https://www.openstreetmap.org/way/1470365896',
        'https://www.openstreetmap.org/way/92627405',
        'https://ageprim.com/news/monaco/first-step-of-the-ambitious-portier-cove-monaco-project-completed/ (Portier roundabout and its virole, 2020)'] },
    { ways: [78149827], include: false, name: 'Tunnel I.M.2S (Boulevard du Larvotto)',
      why: 'A road tunnel (the former railway tunnel, abandoned:railway=rail, tunnel:name I.M.2S) BELOW the circuit\'s street on the ' +
        'climb after Sainte-Devote; the circuit runs in the open there.',
      refs: ['https://www.openstreetmap.org/way/78149827'] }
  ]
};
DECISIONS['it-1922'] = [
  { ways: [1443867793], include: true, name: 'Sopraelevata underpass', kind: 'underpass', facade: 'plain', ads: 'none',
    why: 'The road course\'s own raceway way 1443867793 is tagged covered=yes where it passes under the north curve of the old ' +
      'high-speed oval (raceway way 34404729 "anello alta velocità", bridge=yes, layer=1, and 34404730 / 725687994 "Sopraelevata ' +
      'Nord"), between the Lesmos and Ascari. js/scenery.js has no oval: the underpass stands alone as a concrete bridge.',
    refs: ['https://www.openstreetmap.org/way/1443867793', 'https://www.openstreetmap.org/way/34404729',
      'https://en.wikipedia.org/wiki/Monza_Circuit (the banked oval and the road course crossing under it)'] }
];
DECISIONS['es-2026'] = [
  { ways: [87096566, 34049751], include: true, name: 'Tunnel 1 (under the motorway)', kind: 'tunnel', facade: 'plain',
    why: 'Madring runs through two short tunnels under the motorway between the IFEMA and the Valdebebas halves of the lap ' +
      '(one out, one back). OSM: road tunnels 87096566 (tunnel=yes, layer=-1) / 34049751 that the game centreline follows within ' +
      '~2 m for the whole run; the MadRing raceway ways (construction=raceway) carry no tunnel tags yet. Plain concrete: nobody ' +
      'here has seen the finished tunnels.',
    refs: ['https://www.openstreetmap.org/way/87096566', 'https://www.openstreetmap.org/way/34049751',
      'https://www.racingcircuits.info/europe/spain/madring.html',
      'https://above.guide/madrid-f1/circuit (seen through a search summary: two short tunnels, Curve 18 "Norte" just outside the one back to IFEMA)'] },
  { ways: [827423913, 827423914], include: true, name: 'Tunnel 2 (under the motorway)', kind: 'tunnel', facade: 'plain',
    why: 'The second of Madring\'s two tunnels: twin one-way service tunnels 827423914 (the game centreline within ~2 m) and ' +
      '827423913 beside it, under the motorway link bridge 34049818 (highway=trunk_link, bridge=yes, layer=1) that crosses the ' +
      'circuit there.',
    refs: ['https://www.openstreetmap.org/way/827423914', 'https://www.openstreetmap.org/way/827423913',
      'https://www.openstreetmap.org/way/34049818', 'https://www.racingcircuits.info/europe/spain/madring.html'] }
];
DECISIONS['ae-2009'] = [
  { ways: [1255169704], include: true, name: 'W hotel bridge', kind: 'underpass', facade: 'plain', ceil: 9, deck: 18, wings: false,
    why: 'The circuit\'s raceway way 1255169704 is tagged covered=yes where it passes under the link bridge of the W Abu Dhabi ' +
      'Yas Island hotel: OSM building:part way 1387292013 (white glass, min_height=9, height=18, round roof) spans the road there -> ' +
      'a 9 m clear passage under an 18 m high bridge (ceil / deck), no wings (scenery footprint #10 is the whole hotel complex ' +
      'and its gridshell, 272 x 158 m: not a solid mass over the road).',
    refs: ['https://www.openstreetmap.org/way/1255169704', 'https://www.openstreetmap.org/way/1387292013',
      'https://en.wikipedia.org/wiki/Yas_Marina_Circuit (the track passes under the hotel bridge)'] }
];
DECISIONS['sg-2008'] = [
  { ways: [479745478], include: true, name: 'Raffles Boulevard link', kind: 'underpass', facade: 'plain', ceil: 4.5, deck: 6, wings: false,
    why: 'The circuit on Raffles Boulevard passes under a link building: the road way 479745478 is tagged tunnel=building_passage ' +
      '(maxheight 4.5) under OSM building way 393090492 (layer=1, min_height=4.5, height=6, built 1986) -> ceil 4.5, deck 6.',
    refs: ['https://www.openstreetmap.org/way/479745478', 'https://www.openstreetmap.org/way/393090492'] },
  { ways: [545362402, 545362403], include: true, name: 'Raffles Boulevard passage', kind: 'underpass', facade: 'plain', ceil: 5,
    why: 'Raffles Boulevard again passes through a building (ways 545362402 / 545362403 tunnel=building_passage, maxheight 4.5) ' +
      'that scenery footprint #15 (h 8) covers across the road -> a 5 m clear passage, the building above and beside it (wings).',
    refs: ['https://www.openstreetmap.org/way/545362402', 'https://www.openstreetmap.org/way/545362403'] },
  { ways: [1545634137, 1545634145, 1545634132, 1545634125, 1545634124, 1545634147], include: false, name: 'car park aisles',
    why: 'Underground car-park aisles (service=parking_aisle, layer=-1) beneath the circuit near the new NS Square: not the circuit.',
    refs: ['https://www.openstreetmap.org/way/1545634137'] }
];
DECISIONS['jp-1962'] = [
  { ways: [183391655], include: false, name: 'crossover (lower road)',
    why: 'The raceway way 183391655 (two nodes, 244 m) is tagged covered=yes over its whole length although only the part under ' +
      'the crossover bridge (raceway way 175231434, bridge=yes, layer=1, ~36 m) is covered; and js/track.js levels both roads into ' +
      'one flat crossing (track.crossings), so the game has no bridge to drive under.',
    refs: ['https://www.openstreetmap.org/way/183391655', 'https://www.openstreetmap.org/way/175231434'] },
  { ways: [467945733], include: false, name: 'service area',
    why: 'A service area (area=yes, highway=service, tunnel=yes) 25..40 m beside the circuit: not the circuit.',
    refs: ['https://www.openstreetmap.org/way/467945733'] }
];
// circuits with notes but nothing to build (filled in from the candidates and the overhead structures found)
const NOTES = {
  'jp-1962': 'Suzuka\'s figure-of-eight: js/track.js levels both roads into one flat crossing (track.crossings), so there is no ' +
    'bridge / underpass in the game to cover.',
  'ae-2009': 'Yas Marina: the real pit exit dives under the track in a tunnel; js/track.js builds a surface pit lane on every ' +
    'circuit, so there is no tunnel in the game to cover.'
};

// ---------------------------------------------------------------- helpers
const r6 = v => Math.round(v * 1e6) / 1e6, r5 = v => Math.round(v * 1e5) / 1e5;
function pip(x, z, p) {
  let c = false;
  for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
    if (((p[a][1] > z) !== (p[b][1] > z)) && (x < (p[b][0] - p[a][0]) * (z - p[a][1]) / (p[b][1] - p[a][1]) + p[a][0])) c = !c;
  }
  return c;
}
function toLL(g, x, z) { return [r6(z / g.kz + g.lat0), r6(x / g.kx + g.lon0)]; }

// covered runs along the centreline: [{a, b (sample indices, a..b along the lap), ways: Set(id), pts: [{i, al, x, z}]}]
function candidates(t, tr, j) {
  const S = tr.samples, N = S.length, ds = tr.length / N, g = t.geo;
  const mark = new Array(N);
  for (const e of j.elements) {
    const tg = e.tags || {}, geom = e.geometry;
    if (!geom || geom.length < 2) continue;
    const isCovered = ((tg.tunnel && tg.tunnel !== 'no') || (tg.covered && tg.covered !== 'no')) && ROADISH.test(tg.highway || '');
    if (!isCovered) continue;
    const P = geom.map(n => [(n.lon - g.lon0) * g.kx, (n.lat - g.lat0) * g.kz]);
    for (let k = 0; k + 1 < P.length; k++) {
      const ax = P[k][0], az = P[k][1], bx = P[k + 1][0], bz = P[k + 1][1], L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      for (let s = 0; s <= L; s += 1) {
        const x = ax + ux * s, z = az + uz * s, n = tr.nearest(x, z), sm = S[n.index];
        if (Math.abs(n.d) > sm.halfW + 4) continue;
        if (Math.abs(ux * sm.tx + uz * sm.tz) < Math.cos(30 * Math.PI / 180)) continue;
        const m = mark[n.index] || (mark[n.index] = { ways: new Set(), pts: [] });
        m.ways.add(e.id);
        m.pts.push({ i: n.index, al: (x - sm.x) * sm.tx + (z - sm.z) * sm.tz, x, z });
      }
    }
  }
  let runs = [], start = -1;
  for (let i = 0; i < N; i++) {
    if (mark[i] && start < 0) start = i;
    if (!mark[i] && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, N - 1]);
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === N - 1) runs[0][0] = runs.pop()[0] - N;
  const gap = Math.round(20 / ds);
  for (let r = 0; r + 1 < runs.length; r++) if (runs[r + 1][0] - runs[r][1] <= gap) { runs[r][1] = runs[r + 1][1]; runs.splice(r + 1, 1); r--; }
  runs = runs.filter(r => (r[1] - r[0] + 1) * ds >= 12);
  return runs.map(r => {
    const ways = new Set(), pts = [];
    for (let i = r[0]; i <= r[1]; i++) { const m = mark[(i + N) % N]; if (m) { m.ways.forEach(w => ways.add(w)); pts.push(...m.pts); } }
    return { a: (r[0] + N) % N, b: (r[1] + N) % N, ways, pts };
  });
}
// structures over the circuit (bridges, buildings with layer >= 1 / min_height): for the notes
function overhead(t, tr, j) {
  const S = tr.samples, g = t.geo, out = [];
  for (const e of j.elements) {
    const tg = e.tags || {}, geom = e.geometry;
    if (!geom || geom.length < 2) continue;
    const isOver = tg.man_made === 'bridge' || ((tg.bridge && tg.bridge !== 'no') && (tg.highway || tg.railway)) ||
      ((tg.building || tg['building:part']) && ((+tg.layer >= 1) || tg.min_height || tg.building === 'bridge'));
    if (!isOver) continue;
    const P = geom.map(n => [(n.lon - g.lon0) * g.kx, (n.lat - g.lat0) * g.kz]);
    const hit = new Set();
    let along = 0, metres = 0;
    for (let k = 0; k + 1 < P.length; k++) {
      const L = Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
      for (let s = 0; s <= L; s += 1) {
        const x = P[k][0] + (P[k + 1][0] - P[k][0]) * s / (L || 1), z = P[k][1] + (P[k + 1][1] - P[k][1]) * s / (L || 1), n = tr.nearest(x, z);
        if (Math.abs(n.d) > S[n.index].halfW) continue;
        hit.add(n.index); metres++;
        if (L > 1e-6 && Math.abs(((P[k + 1][0] - P[k][0]) * S[n.index].tx + (P[k + 1][1] - P[k][1]) * S[n.index].tz) / L) > 0.8) along++;
      }
    }
    const what = tg.man_made === 'bridge' ? 'man_made=bridge' : (tg.building ? 'building=' + tg.building :
      (tg['building:part'] ? 'building:part' : (tg.highway ? 'highway=' + tg.highway + ' bridge' : 'railway bridge')));
    // a bridge way that runs ALONG the centreline for most of its metres: the circuit is on it, or it runs above it
    if (hit.size) out.push({ way: e.id, what, name: tg.name || '', layer: tg.layer || '', samples: hit.size,
      carries: !tg.building && !tg['building:part'] && metres > 0 && along / metres > 0.6 && hit.size >= 6 });
  }
  return out;
}

// ---------------------------------------------------------------- build
const tracksOut = {}, sources = {}, checked = {};
const fetched = {};
for (const t of global.F1_TRACKS) {
  const file = path.join(CACHE, t.id + '.json');
  if (!fs.existsSync(file)) { checked[t.id] = 'NOT CHECKED: no OpenStreetMap response cached (Overpass unavailable)'; continue; }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  fetched[t.id] = (j.__fetched && j.__fetched.at) || (j.osm3s && j.osm3s.timestamp_osm_base) || '';
  const tr = F1.buildTrack(t), S = tr.samples, N = S.length, L = tr.length, g = t.geo;
  const cands = candidates(t, tr, j), over = overhead(t, tr, j);
  const dec = DECISIONS[t.id] || [];
  const list = [], srcs = [], notes = [];
  for (const c of cands) {
    const d = dec.find(x => x.ways.some(w => c.ways.has(w)));
    const len = Math.round(((c.b - c.a + N) % N + 1) * L / N);
    const desc = `samples ${c.a}..${c.b} (s ${Math.round(S[c.a].s)}..${Math.round(S[c.b].s)} m, ${len} m), ways ${[...c.ways].join(', ')}`;
    if (!d) { notes.push('UNDECIDED covered candidate: ' + desc); continue; }
    if (!d.include) { notes.push('excluded ' + d.name + ': ' + d.why + ' [' + desc + ']'); continue; }
    // portals: first / last covered metre along the lap
    const relOf = p => ((p.i - c.a + N) % N) * (L / N) + p.al;
    let pa = null, pb = null;
    for (const p of c.pts) { const r = relOf(p); if (!pa || r < pa.r) pa = { r, p }; if (!pb || r > pb.r) pb = { r, p }; }
    const fOf = q => r5((((S[q.p.i].s + q.p.al) / L) % 1 + 1) % 1);
    const entry = { name: d.name, kind: d.kind, facade: d.facade };
    if (d.ads) entry.ads = d.ads;
    if (d.ceil) entry.ceil = d.ceil;
    if (d.deck) entry.deck = d.deck;
    if (d.wings === false) entry.wings = false;
    Object.assign(entry, { from: toLL(g, pa.p.x, pa.p.z), to: toLL(g, pb.p.x, pb.p.z), fFrom: fOf(pa), fTo: fOf(pb) });
    const ia = pa.p.i, ib = pb.p.i, K = (ib - ia + N) % N;
    // split: the building over the entry ends (F1_SCENERY footprint holding the road's middle)
    const sc = global.F1_SCENERY[t.id], bl = sc ? sc.buildings.filter(b => b.k !== 'bridge') : [];
    const coverIdx = i => bl.map((b, n) => pip(S[i].x, S[i].z, b.p) ? n : -1).filter(n => n >= 0);
    if (d.split === 'buildings') {
      const first = coverIdx((ia + 2) % N);
      let endA = -1, startB = -1;
      for (let k = 2; k <= K; k++) {
        const cv = coverIdx((ia + k) % N);
        if (endA < 0 && !cv.some(n => first.includes(n))) endA = k;
        if (endA >= 0 && cv.length && !cv.some(n => first.includes(n))) { startB = k; break; }
      }
      if (endA > 0) {
        const ks = Math.round((endA + (startB > 0 ? startB : endA)) / 2), i = (ia + ks) % N;
        entry.split = toLL(g, S[i].x, S[i].z); entry.fSplit = r5(S[i].s / L);
      }
    }
    // open side: water within OPEN_REACH beyond the tunnel block, longest run >= OPEN_MIN m
    if (d.open === 'water') {
      const water = sc ? sc.areas.filter(a => a.k === 'water') : [];
      entry.open = [];
      for (const side of [1, -1]) {
        let best = null, run = null;
        for (let k = 0; k <= K; k++) {
          const i = (ia + k) % N, s = S[i], b0 = (side > 0 ? s.wallPosDist : s.wallNegDist) + WALL_GAP + OUT_T;
          let wet = false;
          for (let e = 0; e <= OPEN_REACH && !wet; e += 0.5) {
            const x = s.x + s.nx * side * (b0 + e), z = s.z + s.nz * side * (b0 + e);
            wet = water.some(w => pip(x, z, w.p));
          }
          if (wet) { if (!run) run = { a: k, b: k }; else run.b = k; } else run = null;
          if (run && (!best || run.b - run.a > best.b - best.a)) best = { a: run.a, b: run.b };
        }
        if (best && (best.b - best.a) * L / N >= OPEN_MIN) {
          const A = (ia + best.a) % N, B = (ia + best.b) % N;
          entry.open.push({ side, from: toLL(g, S[A].x, S[A].z), to: toLL(g, S[B].x, S[B].z), fFrom: r5(S[A].s / L), fTo: r5(S[B].s / L) });
        }
      }
      if (!entry.open.length) delete entry.open;
    }
    list.push(entry);
    srcs.push({ name: d.name, osmWays: [...c.ways].sort((x, y) => x - y), game: { from: ia, to: ib, sFrom: Math.round(S[ia].s), sTo: Math.round(S[ib].s), length: Math.round(K * L / N) },
      why: d.why, refs: d.refs });
  }
  list.sort((x, y) => x.fFrom - y.fFrom);
  if (list.length) { tracksOut[t.id] = list; sources[t.id] = srcs; }
  const fmt = o => `${o.what} ${o.name ? '"' + o.name + '" ' : ''}way ${o.way} (${o.samples} samples)`;
  const ov = over.filter(o => o.samples * L / N >= 4 && !o.carries).map(fmt), on = over.filter(o => o.carries).map(fmt);
  checked[t.id] = (list.length ? 'covered stretches: ' + list.map(x => x.name).join(', ') : 'no covered stretch of the circuit in OpenStreetMap') +
    (notes.length ? '; ' + notes.join('; ') : '') + (ov.length ? '; over the circuit (bridges / link buildings, not tunnels; js/scenery.js decks where in its data): ' + ov.join(', ') : '') +
    (on.length ? '; bridge ways running ALONG the circuit (it is on them, or they are above it, e.g. a monorail): ' + on.join(', ') : '') +
    (NOTES[t.id] ? '; ' + NOTES[t.id] : '');
  tr.dispose();
}
const doc = {
  about: 'Covered stretches of the F1Drive circuits (the car drives through them), for js/tunnels.js (F1.TUNNEL_DATA is a copy of ' +
    '"tracks"). Built by devtests/tunnel-test/make-data.js from OpenStreetMap responses (devtests/tunnel-test/osm-fetch.mjs) ' +
    'and the decisions recorded in that script. Positions: [lat, lon] (WGS84) mapped onto the game track through tracks-data.js ' +
    'geo; f* = fractions of the game lap (the fallback). from / to: the first / last covered metre along the lap; split: where ' +
    'the block\'s facade changes from the entry portal\'s to the exit portal\'s; open: a side (+1 = the driver\'s left) open to the sea.',
  license: 'Positions and tags derived from OpenStreetMap, (c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
  osmFetched: fetched,
  tracks: tracksOut,
  sources,
  checked
};
const text = JSON.stringify(doc, null, 1) + '\n';
if (CHECK) {
  let bad = 0;
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const missing = global.F1_TRACKS.filter(t => !fs.existsSync(path.join(CACHE, t.id + '.json'))).map(t => t.id);
  if (!cur) { console.log('FAIL tools/tunnels.json missing'); bad++; }
  else if (cur === text) console.log('PASS tools/tunnels.json up to date');
  else if (missing.length) {
    // the OSM cache is not in git: compare what can be rebuilt (the circuits whose response is cached)
    const old = JSON.parse(cur).tracks, diff = Object.keys(tracksOut).filter(id => JSON.stringify(old[id]) !== JSON.stringify(tracksOut[id]));
    if (diff.length) { console.log('FAIL tools/tunnels.json differs for ' + diff.join(', ')); bad++; }
    else console.log('PASS tools/tunnels.json matches for the ' + (global.F1_TRACKS.length - missing.length) + ' circuits with a cached OSM response (' + missing.length + ' without: not rebuilt)');
  } else { console.log('FAIL tools/tunnels.json is not what make-data.js makes now (run it without --check)'); bad++; }
  global.F1 = global.F1 || {};
  delete global.F1.TUNNEL_DATA;
  require(path.join(ROOT, 'js', 'tunnels.js'));
  if (JSON.stringify(global.F1.TUNNEL_DATA) !== JSON.stringify(tracksOut)) { console.log('FAIL js/tunnels.js F1.TUNNEL_DATA differs from tools/tunnels.json "tracks"'); bad++; }
  else console.log('PASS js/tunnels.js F1.TUNNEL_DATA == tools/tunnels.json "tracks"');
  process.exit(bad ? 1 : 0);
}
fs.writeFileSync(OUT, text);
console.log('wrote tools/tunnels.json: ' + Object.keys(tracksOut).length + ' circuit(s) with covered stretches; checked ' +
  Object.keys(checked).filter(k => !/^NOT CHECKED/.test(checked[k])).length + ' / ' + global.F1_TRACKS.length);
for (const id of Object.keys(checked)) console.log('  ' + id.padEnd(8) + ' ' + checked[id]);
console.log('\nF1.TUNNEL_DATA literal for js/tunnels.js:\n' + literal(tracksOut));

function literal(o) {
  const lines = ['  F1.TUNNEL_DATA = F1.TUNNEL_DATA || {'];
  const ids = Object.keys(o);
  ids.forEach((id, ti) => {
    lines.push(`    '${id}': [`);
    o[id].forEach((e, k) => {
      const f = JSON.stringify(e.facade).replace(/"/g, '\'').replace(/','/g, '\', \'');
      let s = `      { name: '${e.name}', kind: '${e.kind}', facade: ${f}${e.ads ? `, ads: '${e.ads}'` : ''}${e.ceil ? `, ceil: ${e.ceil}` : ''}${e.deck ? `, deck: ${e.deck}` : ''}${e.wings === false ? ', wings: false' : ''},\n        from: ${JSON.stringify(e.from)}, to: ${JSON.stringify(e.to)}, fFrom: ${e.fFrom}, fTo: ${e.fTo}`;
      if (e.split) s += `,\n        split: ${JSON.stringify(e.split)}, fSplit: ${e.fSplit}`;
      if (e.open) s += `,\n        open: [${e.open.map(q => `{ side: ${q.side}, from: ${JSON.stringify(q.from)}, to: ${JSON.stringify(q.to)}, fFrom: ${q.fFrom}, fTo: ${q.fTo} }`).join(', ')}]`;
      s += ' }' + (k < o[id].length - 1 ? ',' : '');
      lines.push(s.replace(/\[(-?[\d.]+),(-?[\d.]+)\]/g, '[$1, $2]'));
    });
    lines.push('    ]' + (ti < ids.length - 1 ? ',' : ''));
  });
  lines.push('  };');
  return lines.join('\n');
}
