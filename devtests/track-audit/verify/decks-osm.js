// node devtests/track-audit/verify/decks-osm.js
// For every scenery deck built over the road (cache/verify/decks.json, from decks.js): fetches the OSM data of its
// bounding box (+25 m) from the OSM API 0.6 (one request at a time, 2.5 s apart, cached in cache/verify/osmapi/) and
// classifies the deck: what in OSM passes OVER the lap there (bridge=* / layer >= 1 ways other than the lap) and what
// passes UNDER it (tunnel=* / layer < 0, or the lap's own raceway way tagged bridge=yes).
'use strict';
const L = require('./lib.js');
const fs = L.fs, path = L.path;
const DIR = path.join(L.CACHE, 'verify', 'osmapi');
fs.mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchBox(key, b) {
  const f = path.join(DIR, key + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${b[1]},${b[0]},${b[3]},${b[2]}`;
  for (let a = 0; a < 4; a++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'F1Drive-track-audit/1 (one-off verification, cached)' } });
    if (res.ok) { const j = await res.json(); fs.writeFileSync(f, JSON.stringify(j)); await sleep(2500); return j; }
    console.warn('  HTTP', res.status, 'retry'); await sleep(5000 * (a + 1));
  }
  throw new Error('OSM API failed for ' + key);
}
(async () => {
  const decks = JSON.parse(fs.readFileSync(path.join(L.CACHE, 'verify', 'decks.json'), 'utf8')).filter((d) => d.over);
  const res = [];
  for (const d of decks) {
    const pad = 25 / 111000, pl = pad / Math.cos(d.bbox[0] * Math.PI / 180);
    const b = [d.bbox[0] - pad, d.bbox[1] - pl, d.bbox[2] + pad, d.bbox[3] + pl];
    const key = `${d.id}-${d.idx}`;
    const j = await fetchBox(key, b);
    const nodes = new Map(); for (const e of j.elements) if (e.type === 'node') nodes.set(e.id, e);
    const g = L.game(d.id);
    const polyXZ = d.ll.map(([la, lo]) => g.xz(la, lo));
    const ways = j.elements.filter((e) => e.type === 'way').map((w) => Object.assign(w, { coords: w.nodes.map((n) => nodes.get(n)).filter(Boolean).map((n) => [n.lat, n.lon]) }));
    // the OSM man_made=bridge outline matching the scenery polygon: most of the scenery vertices on its outline
    let match = null, bestCnt = 0;
    for (const w of ways) {
      if ((w.tags || {}).man_made !== 'bridge') continue;
      const wxz = w.coords.map(([la, lo]) => g.xz(la, lo));
      let cnt = 0;
      for (const q of polyXZ) if (wxz.some((r) => Math.hypot(r[0] - q[0], r[1] - q[1]) < 1.5)) cnt++;
      if (cnt > bestCnt) { bestCnt = cnt; match = w; }
    }
    // ways with some vertex inside the polygon or a segment crossing it
    const inPoly = (la, lo) => { const [x, z] = g.xz(la, lo); return L.pointInPoly(x, z, polyXZ); };
    const touches = (w) => {
      if (w.coords.some(([la, lo]) => inPoly(la, lo))) return true;
      for (let i = 0; i + 1 < w.coords.length; i++) {
        const a = g.xz(...w.coords[i]), bq = g.xz(...w.coords[i + 1]);
        for (let k = 0; k < polyXZ.length; k++) if (L.segX(a, bq, polyXZ[k], polyXZ[(k + 1) % polyXZ.length])) return true;
      }
      return false;
    };
    const under = [], over = [], lapOnDeck = [];
    for (const w of ways) {
      const t = w.tags || {};
      if (!t || t.man_made === 'bridge' || t.building || t['building:part'] || t.landuse || t.natural || t.area === 'yes' || !touches(w)) continue;
      const layer = +(t.layer || 0), isRace = t.highway === 'raceway' || t.sport === 'motor';
      const desc = `${w.id} ${Object.entries(t).filter(([k]) => /^(highway|railway|name|bridge|tunnel|layer|covered|service|footway|sport|waterway)$/.test(k)).map(([k, v]) => k + '=' + v).join(' ')}`;
      if (isRace && t.bridge && t.bridge !== 'no') lapOnDeck.push(desc);
      else if ((t.tunnel && t.tunnel !== 'no') || layer < 0 || t.waterway || t.covered === 'yes') under.push(desc);
      else if (!isRace && ((t.bridge && t.bridge !== 'no') || layer > 0)) over.push(desc);
    }
    const verdict = over.length ? 'real overpass' : (under.length || lapOnDeck.length ? 'PHANTOM (the lap\'s own deck)' : 'unclear');
    const r = { key, id: d.id, s: d.s, centre: [+((d.bbox[0] + d.bbox[2]) / 2).toFixed(6), +((d.bbox[1] + d.bbox[3]) / 2).toFixed(6)],
      osmBridgeOutline: match ? { id: match.id, tags: match.tags, matchedVertices: bestCnt + '/' + polyXZ.length } : null,
      over, under, lapOnDeck, verdict };
    res.push(r);
    console.log(`${key} s ${d.s.join('-')}: outline ${match ? match.id : '?'} (${bestCnt}/${polyXZ.length}) -> ${verdict}\n   over: ${over.join(' | ') || '-'}\n   under: ${under.join(' | ') || '-'}\n   lap on deck: ${lapOnDeck.join(' | ') || '-'}`);
  }
  fs.writeFileSync(path.join(__dirname, 'out-decks.json'), JSON.stringify(res, null, 1));
})();
