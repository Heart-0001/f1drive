// Builds tools/seasons-raw.json: the Formula 1 seasons 2010..2026 with the cars to offer (one entry per constructor
// as the constructors' championship classifies it), sourced pace metrics from timed qualifying, a fast-circuit /
// slow-circuit character split and a like-for-like era pace index (2025 = 1.000).
//
// Source: F1DB (https://github.com/f1db/f1db), licence CC BY 4.0. The release asset f1db-json-splitted.zip is
// cached in tools/seasons-cache/ (not in git); it is downloaded only when the cache is missing.
//
// Usage: node tools/build-seasons.mjs [--refresh] [--release vYYYY.RR.M] [--diag] [--quiet]
//   --refresh   drop the cache and download the latest release again
//   --release   download that release tag instead of the latest one (implies a fresh download)
//   --diag      print every timed session with its measurements and filter flags
//   --quiet     no per-season tables
// Plain Node (18+, written for 24), no npm dependencies. The zip is unpacked with the platform's own tool:
// Windows bsdtar (System32\tar.exe) or PowerShell Expand-Archive, elsewhere unzip / bsdtar.
//
// The rules are documented in docs/seasons-data.md; every threshold lives in RULES below and is copied into the
// output so the consumer can see what was applied. Nothing in the output is invented: every value comes from F1DB
// except the few hand corrections in CORRECTIONS, each of which carries its source and the F1DB value it replaces.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, 'seasons-cache');
const DATA = join(CACHE, 'f1db-json-splitted');
const OUT = resolve(HERE, 'seasons-raw.json');
const REPO = 'f1db/f1db';
const ASSET = 'f1db-json-splitted.zip';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const RULES = {
  firstYear: 2010,
  lastYear: 2026,
  baseYear: 2025,                 // era index = 1.000
  notStarted: ['DNS', 'DNQ', 'DNPQ', 'DNP', 'EX'], // race-result codes that are not a race start
  minTimedEntriesPerSession: 3,   // a session with fewer timed constructors is not used
  wetVsRaceFastestLap: 1.0,       // fastest qualifying lap not faster than the race's fastest lap -> not used
  q1MuchSlower: 1.03,             // best Q1 lap > 3 % off the session's fastest lap (track dried / rubbered-in abnormally) -> not used
  slowVsAdjacentSeasons: 1.04,    // > 4 % slower than the same layout in the adjacent seasons predicts -> not used
  spreadFactor: 2.5,              // field median gap > 2.5 x the season's typical one ...
  spreadMinExcessPct: 2.0,        // ... and at least 2 points above it -> not used (mixed conditions)
  gapLimitFactor: 5,              // a single gap above max(gapLimitMinPct, factor x season field median gap) ...
  gapLimitMinPct: 12,             // ... is a no-representative-lap outlier and is dropped (the slowest real cars, HRT 2010-2012, reach 8-11 %)
  minSessionsForPace: 5,          // below this the pace median is flagged lowSample
  minSessionsPerClass: 3,         // below this (either class) the character split is flagged lowSample
  characterNeutralBandPct: 0.10,  // |centred twisty-minus-power gap| below this = 'neutral'
  eraMinMatches: 3,               // fewer like-for-like circuits than this -> the link is flagged
  eraFitTrimPct: 2.5,             // two-way fit (cross-check): points further than this from the first fit are left out of the second
};

// Hand corrections, applied after F1DB. Each one is sourced, keeps the F1DB value in the output and is listed in
// out.corrections. Keep this list short: it exists only where F1DB is demonstrably out of step with the primary source.
const CORRECTIONS = [
  { id: '2026-cadillac', field: 'chassis', f1db: 'CA01', value: 'MAC-26',
    source: 'https://www.cadillacf1team.com/news/cadillac-formula-1-r-team-honors-mario-andretti-with-inaugural-chassis',
    note: 'announced by the team on 2026-02-27 ("Mario Andretti Cadillac 26"); F1DB v2026.15.1 still lists CA01' },
  { id: '2025-ferrari', field: 'engine.designation', f1db: '066/12', value: '066/15', source: 'https://en.wikipedia.org/wiki/Ferrari_SF-25', note: 'F1DB carries the 2024 designation over' },
  { id: '2025-haas', field: 'engine.designation', f1db: '066/12', value: '066/15', source: 'https://en.wikipedia.org/wiki/2025_Formula_One_World_Championship', note: 'F1DB carries the 2024 designation over' },
  { id: '2025-kick-sauber', field: 'engine.designation', f1db: '066/12', value: '066/15', source: 'https://en.wikipedia.org/wiki/2025_Formula_One_World_Championship', note: 'F1DB carries the 2024 designation over' },
  { id: '2025-red-bull', field: 'engine.designation', f1db: 'RBPTH002', value: 'RBPTH003', source: 'https://global.honda/en/POWEREDbyHONDA/2025_Honda_rbpth003/', note: 'F1DB carries the 2024 designation over' },
  { id: '2025-racing-bulls', field: 'engine.designation', f1db: 'RBPTH002', value: 'RBPTH003', source: 'https://global.honda/en/POWEREDbyHONDA/2025_Honda_rbpth003/', note: 'F1DB carries the 2024 designation over' },
];

// Notes that F1DB cannot express. Facts only, each with its source; they do not change any number.
const ENTRY_NOTES = {
  '2010-sauber': { text: 'Entered and classified as "BMW Sauber-Ferrari" (BMW Sauber F1 Team) although BMW had left; F1DB files it under Sauber.', source: 'https://en.wikipedia.org/wiki/2010_Formula_One_World_Championship' },
  '2010-lotus-racing': { text: 'Championship constructor name "Lotus" (Lotus-Cosworth), entrant Lotus Racing; not the same organisation as the 2012-2015 "Lotus" (lotus-f1, the former Renault team).', source: 'https://en.wikipedia.org/wiki/2010_Formula_One_World_Championship' },
  '2011-lotus-racing': { text: 'Championship constructor name "Lotus" (Lotus-Renault), entrant Team Lotus; the same year the Renault constructor raced as "Lotus Renault GP".', source: 'https://en.wikipedia.org/wiki/2011_Formula_One_World_Championship' },
  '2015-force-india': { text: 'VJM08 for the first 8 races, B-spec VJM08B from the British Grand Prix (round 9) for the other 11.', source: 'https://en.wikipedia.org/wiki/Force_India_VJM08' },
  '2018-force-india': { text: 'Two championship entries with the same car: "Force India-Mercedes" (Sahara Force India, rounds 1-12, excluded, its points annulled) and "Racing Point Force India-Mercedes" (from round 13, Belgium; classified, position and points given here). Starts, wins, poles and podiums cover the whole season.', source: 'https://en.wikipedia.org/wiki/2018_Formula_One_World_Championship' },
};

// Engines entered under a name other than their maker's. F1DB keeps the badge as the engine manufacturer; this adds
// who built the unit. Source: the season articles of Wikipedia (entries tables and their footnotes).
const BADGED_ENGINES = {
  'tag-heuer': { builtBy: 'Renault', years: [2016, 2018] },
  'toro-rosso': { builtBy: 'Renault', years: [2017, 2017] },
  'bwt-mercedes': { builtBy: 'Mercedes', years: [2019, 2020] },
  rbpt: { builtBy: 'Honda', years: [2022, 2022] },
  'honda-rbpt': { builtBy: 'Honda', years: [2023, 2025] },
  'red-bull-ford': { builtBy: 'Red Bull Powertrains (with Ford)', years: [2026, 2026] },
};

// ------------------------------------------------------------------------------------------------ cache

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'f1drive-build-seasons', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function resolveRelease(tag) {
  try {
    const j = await fetchJson(`https://api.github.com/repos/${REPO}/releases/${tag ? `tags/${tag}` : 'latest'}`);
    const a = (j.assets || []).find((x) => x.name === ASSET);
    if (!a) throw new Error(`release ${j.tag_name} has no ${ASSET}`);
    const sums = (j.assets || []).find((x) => x.name === 'checksums_sha256.txt');
    return { tag: j.tag_name, publishedAt: j.published_at, url: a.browser_download_url, sumsUrl: sums ? sums.browser_download_url : null };
  } catch (e) {
    // API unreachable / rate-limited: follow the "latest" download redirect by hand to learn the tag.
    const base = `https://github.com/${REPO}/releases/${tag ? `download/${tag}` : 'latest/download'}`;
    let t = tag;
    if (!t) {
      const r = await fetch(`${base}/${ASSET}`, { redirect: 'manual' });
      const m = /\/download\/([^/]+)\//.exec(r.headers.get('location') || '');
      if (!m) throw new Error(`cannot resolve the latest F1DB release (${e.message})`);
      t = m[1];
    }
    const b = `https://github.com/${REPO}/releases/download/${t}`;
    return { tag: t, publishedAt: null, url: `${b}/${ASSET}`, sumsUrl: `${b}/checksums_sha256.txt` };
  }
}

function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const tries = process.platform === 'win32'
    ? [
      [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]],
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]],
    ]
    : [['unzip', ['-oq', zip, '-d', dest]], ['bsdtar', ['-xf', zip, '-C', dest]], ['tar', ['-xf', zip, '-C', dest]]];
  let last;
  for (const [cmd, a] of tries) {
    try { execFileSync(cmd, a, { stdio: 'ignore' }); if (existsSync(join(dest, 'f1db-races.json'))) return; } catch (e) { last = e; }
  }
  throw new Error(`could not unpack ${zip}${last ? `: ${last.message}` : ''}`);
}

async function ensureCache() {
  const metaPath = join(CACHE, 'release.json');
  const wantTag = opt('--release');
  if (flag('--refresh') || wantTag) rmSync(CACHE, { recursive: true, force: true });
  mkdirSync(CACHE, { recursive: true });
  const zip = join(CACHE, ASSET);
  if (!existsSync(join(DATA, 'f1db-races.json'))) {
    if (!existsSync(zip) || !existsSync(metaPath)) {
      const rel = await resolveRelease(wantTag);
      console.log(`downloading F1DB ${rel.tag} (${ASSET}) ...`);
      const r = await fetch(rel.url, { headers: { 'User-Agent': 'f1drive-build-seasons' } });
      if (!r.ok) throw new Error(`${rel.url}: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const sha256 = createHash('sha256').update(buf).digest('hex');
      let checksum = 'not published';
      if (rel.sumsUrl) {
        const s = await fetch(rel.sumsUrl, { headers: { 'User-Agent': 'f1drive-build-seasons' } });
        if (s.ok) {
          const txt = await s.text();
          writeFileSync(join(CACHE, 'checksums_sha256.txt'), txt);
          const line = txt.split(/\r?\n/).find((l) => l.trim().endsWith(ASSET));
          if (line) {
            if (line.trim().split(/\s+/)[0].toLowerCase() !== sha256) throw new Error(`${ASSET}: sha256 mismatch against the release checksums`);
            checksum = 'verified';
          }
        }
      }
      writeFileSync(zip, buf);
      writeFileSync(metaPath, JSON.stringify({
        tag: rel.tag, publishedAt: rel.publishedAt, asset: ASSET, url: rel.url, sha256, checksum, bytes: buf.length,
        downloadedAt: new Date().toISOString(),
      }, null, 1) + '\n');
    }
    unzip(zip, DATA);
  }
  return existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8'))
    : { tag: 'unknown', publishedAt: null, asset: ASSET, url: null, sha256: null, checksum: 'unknown' };
}

// ---------------------------------------------------------------------------------------------- helpers

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d) => (v == null ? null : Number(v.toFixed(d)));
const groupBy = (arr, key) => {
  const m = new Map();
  for (const x of arr) { const k = key(x); let g = m.get(k); if (!g) m.set(k, g = []); g.push(x); }
  return m;
};
const indexBy = (arr, key = (x) => x.id) => new Map(arr.map((x) => [key(x), x]));
const uniq = (a) => [...new Set(a)];

const ASPIRATION = { NATURALLY_ASPIRATED: 'NA', SUPERCHARGED: 'supercharged', TURBOCHARGED: 'turbo', TURBOCHARGED_HYBRID: 'turbo-hybrid' };
const LAYOUT = { V: (n) => `V${n}`, L: (n) => `straight-${n}`, F: (n) => `flat-${n}`, H: (n) => `H${n}`, W: (n) => `W${n}` };
function engineSpec(e) {
  const m = /^([A-Z])(\d+)$/.exec(e.configuration || '');
  return {
    id: e.id,
    designation: e.name,
    fullName: e.fullName,
    capacityL: e.capacity,
    configuration: m && LAYOUT[m[1]] ? LAYOUT[m[1]](m[2]) : null,
    cylinders: m ? Number(m[2]) : null,
    aspiration: ASPIRATION[e.aspiration] || null,
  };
}
const formulaOf = (s) => (s ? { capacityL: s.capacityL, configuration: s.configuration, cylinders: s.cylinders, aspiration: s.aspiration, label: `${s.capacityL.toFixed(1)} ${s.configuration} ${s.aspiration}` } : null);

// ------------------------------------------------------------------------------------------------- main

const release = await ensureCache();
const T = (name) => JSON.parse(readFileSync(join(DATA, `f1db-${name}.json`), 'utf8'));
const inRange = (r) => r.year >= RULES.firstYear && r.year <= RULES.lastYear;

const races = T('races').filter(inRange);
const raceResults = groupBy(T('races-race-results').filter(inRange), (r) => r.raceId);
const sprintResults = groupBy(T('races-sprint-race-results').filter(inRange), (r) => r.raceId);
const qualiRows = groupBy(T('races-qualifying-results').filter(inRange), (r) => r.raceId);
const fastestLaps = groupBy(T('races-fastest-laps').filter(inRange), (r) => r.raceId);
const constructorStandings = groupBy(T('seasons-constructor-standings').filter(inRange), (r) => r.year);
const driverStandings = groupBy(T('seasons-driver-standings').filter(inRange), (r) => r.year);
const seasonConstructors = groupBy(T('seasons-constructors').filter(inRange), (r) => r.year);
const entrantChassis = groupBy(T('seasons-entrants-chassis').filter(inRange), (r) => r.year);
const entrantEngines = groupBy(T('seasons-entrants-engines').filter(inRange), (r) => r.year);
const entrantConstructors = groupBy(T('seasons-entrants-constructors').filter(inRange), (r) => r.year);
const chronology = T('constructors-chronology');
const constructors = indexBy(T('constructors'));
const engineMakers = indexBy(T('engine-manufacturers'));
const engines = indexBy(T('engines'));
const chassisById = indexBy(T('chassis'));
const countries = indexBy(T('countries'));
const tyreMakers = indexBy(T('tyre-manufacturers'));
const drivers = indexBy(T('drivers'));
const entrants = indexBy(T('entrants'));
const grandsPrix = indexBy(T('grands-prix'));
const circuits = indexBy(T('circuits'));

const NOT_STARTED = new Set(RULES.notStarted);
const keyOf = (r) => `${r.constructorId}|${r.engineManufacturerId}`;
const years = [];
for (let y = RULES.firstYear; y <= RULES.lastYear; y++) years.push(y);
const racesByYear = groupBy(races, (r) => r.year);
for (const y of years) if (!(racesByYear.get(y) || []).length) throw new Error(`the F1DB release ${release.tag} has no races for ${y}`);
const anomalies = [];
const note = (s) => anomalies.push(s);

// ---- lineage: the same organisation across renames ------------------------------------------------------
// F1DB's constructors-chronology lists, for a constructor, the chain of constructors it continues. The chains are
// merged (union-find) and the group is named after its member that appears first in the output range, so the key is
// readable and does not change when a team is renamed later.
const lineageParent = new Map();
const find = (x) => { while (lineageParent.has(x) && lineageParent.get(x) !== x) x = lineageParent.get(x); return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (!lineageParent.has(ra)) lineageParent.set(ra, ra); if (!lineageParent.has(rb)) lineageParent.set(rb, rb); if (ra !== rb) lineageParent.set(rb, ra); };
for (const c of chronology) union(c.parentConstructorId, c.constructorId);
const lineageFirst = new Map(); // group root -> [year, constructorId] of the first appearance in range
for (const y of years) {
  for (const st of constructorStandings.get(y) || []) {
    const root = find(st.constructorId);
    if (!lineageFirst.has(root)) lineageFirst.set(root, st.constructorId);
  }
}
const lineageOf = (constructorId) => lineageFirst.get(find(constructorId)) || constructorId;

// ---- timed sessions: the fastest qualifying lap of every constructor at every race ----------------------
// Best lap of any driver of the constructor in any segment (Q1 / Q2 / Q3; "time" is the classified time). All
// seasons in range use the knockout format (two 2016 rounds its "elimination" variant, 2021-2022 sprint weekends
// the same knockout session on Friday), so every time is a single flying lap on low fuel.
function sessionOf(race) {
  const best = new Map(); // constructor|engine -> ms
  const seg = { q1: Infinity, q2: Infinity, q3: Infinity };
  const take = (r, ms, s) => {
    if (!(ms > 0)) return;
    const k = keyOf(r);
    if (!(best.get(k) <= ms)) best.set(k, ms);
    if (s && ms < seg[s]) seg[s] = ms;
  };
  for (const r of qualiRows.get(race.id) || []) {
    take(r, r.timeMillis, null); take(r, r.q1Millis, 'q1'); take(r, r.q2Millis, 'q2'); take(r, r.q3Millis, 'q3');
  }
  const poleMs = best.size ? Math.min(...best.values()) : null;
  const fl = (fastestLaps.get(race.id) || []).map((r) => r.timeMillis).filter((v) => v > 0);
  const fin = (v) => (Number.isFinite(v) ? v : null);
  return {
    race, best, poleMs,
    q1BestMs: fin(seg.q1), q2BestMs: fin(seg.q2), q3BestMs: fin(seg.q3),
    fastestSegment: !poleMs ? null : seg.q3 === poleMs ? 'Q3' : seg.q2 === poleMs ? 'Q2' : seg.q1 === poleMs ? 'Q1' : null,
    raceFastestLapMs: fl.length ? Math.min(...fl) : null,
    speedKmh: poleMs ? race.courseLength / (poleMs / 3600000) : null,
    layoutKey: `${race.circuitLayoutId}@${race.courseLength.toFixed(3)}`,
    flags: [],
  };
}

const sessionsByYear = new Map();
for (const y of years) {
  const list = [];
  for (const race of racesByYear.get(y).sort((a, b) => a.round - b.round)) {
    if (!raceResults.has(race.id)) continue; // not held yet
    const s = sessionOf(race);
    if (!s.poleMs || s.best.size < RULES.minTimedEntriesPerSession) s.flags.push('no-times');
    else {
      // wet qualifying, dry(er) race
      if (s.raceFastestLapMs && s.poleMs >= s.raceFastestLapMs * RULES.wetVsRaceFastestLap) s.flags.push('slower-than-race-lap');
      // the conditions got worse after Q1: the fastest laps are Q1 laps, where the quick cars do not run flat out
      if (s.fastestSegment === 'Q1') s.flags.push('fastest-lap-in-q1');
      // the conditions got much better after Q1 (damp start): the cars eliminated in Q1 have no representative lap
      else if (s.q1BestMs && s.q1BestMs > s.poleMs * RULES.q1MuchSlower) s.flags.push('q1-much-slower');
    }
    list.push(s);
  }
  // mixed conditions: the whole field is abnormally far from the fastest lap
  for (const s of list) if (s.poleMs) { s.fieldMedianMs = median([...s.best.values()]); s.fieldMedianGap = (s.fieldMedianMs / s.poleMs - 1) * 100; }
  const usable = list.filter((s) => !s.flags.length);
  const typical = median(usable.map((s) => s.fieldMedianGap));
  for (const s of usable) {
    if (s.fieldMedianGap > typical * RULES.spreadFactor && s.fieldMedianGap > typical + RULES.spreadMinExcessPct) s.flags.push('field-spread');
  }
  sessionsByYear.set(y, list);
}

// ---- era pace index ------------------------------------------------------------------------------------
const okSessions = (y) => (sessionsByYear.get(y) || []).filter((s) => !s.flags.length);
function layoutBest(y) { // layout@length -> fastest usable pole of that season
  const m = new Map();
  for (const s of okSessions(y)) if (!(m.get(s.layoutKey) <= s.poleMs)) m.set(s.layoutKey, s.poleMs);
  return m;
}
function link(a, b, skipKey = null) { // ratio = lap time in season b / lap time in season a, like-for-like layouts
  const A = layoutBest(a), B = layoutBest(b), rows = [];
  for (const [k, ta] of A) if (k !== skipKey && B.has(k)) rows.push({ k, r: B.get(k) / ta });
  rows.sort((p, q) => p.k.localeCompare(q.k));
  const ratios = rows.map((x) => x.r);
  return {
    from: a, to: b, matches: rows.length, ratio: median(ratios),
    min: ratios.length ? Math.min(...ratios) : null, max: ratios.length ? Math.max(...ratios) : null,
    circuits: rows.map((x) => [x.k.split('@')[0], round(x.r, 4)]),
  };
}
// second pass: a pole far slower than the same layout in the adjacent seasons predicts (a wet qualifying the
// race-lap test cannot see because the race was wet too or was not run)
for (const y of years) {
  for (const s of okSessions(y)) {
    const resid = [];
    for (const n of [y - 1, y + 1]) {
      if (!sessionsByYear.has(n)) continue;
      const t = layoutBest(n).get(s.layoutKey);
      if (!t) continue;
      const l = n < y ? link(n, y, s.layoutKey) : link(y, n, s.layoutKey);
      if (l.matches < 2) continue;
      resid.push(n < y ? s.poleMs / (t * l.ratio) : s.poleMs / (t / l.ratio));
    }
    s.vsAdjacent = resid.length ? Math.min(...resid) : null;
    if (resid.length && Math.min(...resid) > RULES.slowVsAdjacentSeasons) s.pendingSlow = true;
  }
}
for (const y of years) for (const s of sessionsByYear.get(y)) if (s.pendingSlow) s.flags.push('slow-vs-adjacent-seasons');

const eraLinks = [];
for (let y = RULES.firstYear; y < RULES.lastYear; y++) {
  const l = link(y, y + 1);
  if (!l.matches) throw new Error(`no like-for-like circuit between ${y} and ${y + 1}`);
  if (l.matches < RULES.eraMinMatches) { l.flag = 'few-matches'; note(`${y}->${y + 1}: era link rests on ${l.matches} circuit(s) only`); }
  eraLinks.push(l);
}
const eraIndex = new Map([[RULES.baseYear, 1]]);
for (let y = RULES.baseYear - 1; y >= RULES.firstYear; y--) eraIndex.set(y, eraIndex.get(y + 1) / eraLinks.find((l) => l.from === y).ratio);
for (let y = RULES.baseYear + 1; y <= RULES.lastYear; y++) eraIndex.set(y, eraIndex.get(y - 1) * eraLinks.find((l) => l.to === y).ratio);
// cross-check without chaining: the layouts a season shares with the base season directly
const eraDirect = new Map();
for (const y of years) {
  if (y === RULES.baseYear) { eraDirect.set(y, { matches: null, ratio: 1 }); continue; }
  const l = y < RULES.baseYear ? link(y, RULES.baseYear) : link(RULES.baseYear, y);
  eraDirect.set(y, { matches: l.matches, ratio: l.matches ? (y < RULES.baseYear ? 1 / l.ratio : l.ratio) : null });
}

// second cross-check: all seasons at once. log(pole) = circuit effect + season effect, least squares over every
// layout used in at least two seasons, fitted twice (the second time without the points the first fit misses by
// more than eraFitTrimPct). Less sensitive than the chain to one odd link, but not what the index is defined as.
const eraFit = (() => {
  let pts = [];
  for (const y of years) for (const [k, ms] of layoutBest(y)) pts.push({ y, k, v: Math.log(ms) });
  const count = new Map();
  for (const p of pts) count.set(p.k, (count.get(p.k) || 0) + 1);
  pts = pts.filter((p) => count.get(p.k) >= 2);
  const solve = (P) => {
    const I = new Map(years.map((y) => [y, 0])), C = new Map();
    for (let it = 0; it < 500; it++) {
      const cs = new Map(), is = new Map();
      for (const p of P) { const a = cs.get(p.k) || [0, 0]; a[0] += p.v - I.get(p.y); a[1]++; cs.set(p.k, a); }
      for (const [k, a] of cs) C.set(k, a[0] / a[1]);
      for (const p of P) { const a = is.get(p.y) || [0, 0]; a[0] += p.v - C.get(p.k); a[1]++; is.set(p.y, a); }
      for (const [y, a] of is) I.set(y, a[0] / a[1]);
      const base = I.get(RULES.baseYear);
      for (const y of years) I.set(y, I.get(y) - base);
    }
    return { I, C };
  };
  const first = solve(pts);
  const lim = Math.log(1 + RULES.eraFitTrimPct / 100);
  const kept = pts.filter((p) => Math.abs(p.v - first.C.get(p.k) - first.I.get(p.y)) <= lim);
  const { I, C } = solve(kept);
  const res = kept.map((p) => p.v - C.get(p.k) - I.get(p.y));
  return {
    byYear: new Map(years.map((y) => [y, Math.exp(I.get(y))])),
    points: kept.length, trimmed: pts.length - kept.length, layouts: new Set(kept.map((p) => p.k)).size,
    residualSdPct: Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length) * 100,
  };
})();

// ---- entries ---------------------------------------------------------------------------------------------
function buildSeason(y) {
  const seasonRaces = racesByYear.get(y).sort((a, b) => a.round - b.round);
  const sessions = sessionsByYear.get(y);
  const held = seasonRaces.filter((r) => raceResults.has(r.id));
  const official = (constructorStandings.get(y) || []).slice().sort((a, b) => a.positionDisplayOrder - b.positionDisplayOrder);
  if (!official.length) throw new Error(`${y}: no constructors' standings`);

  // statistics from the race results
  const stat = new Map();
  const get = (k, r) => {
    let s = stat.get(k);
    if (!s) stat.set(k, s = { key: k, constructorId: r.constructorId, engineManufacturerId: r.engineManufacturerId, started: new Set(), wins: new Set(), poles: new Set(), podiums: 0, podiumRaces: new Set(), fastestLaps: new Set(), carStarts: 0, points: 0, tyres: new Map(), drivers: new Map() });
    return s;
  };
  for (const race of held) {
    for (const r of raceResults.get(race.id)) {
      const s = get(keyOf(r), r);
      s.points += r.points || 0;
      if (r.polePosition) s.poles.add(race.id); // counted even when the car did not take the start (2021 Monaco)
      if (NOT_STARTED.has(r.positionText)) continue;
      s.started.add(race.id); s.carStarts++;
      if (r.positionNumber === 1) s.wins.add(race.id);
      if (r.positionNumber >= 1 && r.positionNumber <= 3) { s.podiums++; s.podiumRaces.add(race.id); }
      if (r.fastestLap) s.fastestLaps.add(race.id);
      if (r.tyreManufacturerId) s.tyres.set(r.tyreManufacturerId, (s.tyres.get(r.tyreManufacturerId) || 0) + 1);
      let d = s.drivers.get(r.driverId);
      if (!d) s.drivers.set(r.driverId, d = { id: r.driverId, starts: 0, numbers: new Map() });
      d.starts++;
      if (r.driverNumber) d.numbers.set(r.driverNumber, (d.numbers.get(r.driverNumber) || 0) + 1);
    }
    for (const r of sprintResults.get(race.id) || []) get(keyOf(r), r).points += r.points || 0;
  }

  // one entry per constructor + engine of the constructors' standings. A constructor classified twice (2018 Force
  // India: excluded entry + its successor with the same car) becomes one entry with the classified row.
  const byKey = groupBy(official, keyOf);
  const cand = [];
  for (const [k, rows] of byKey) {
    const s = stat.get(k);
    if (!s) { note(`${y}: standings entry ${k} has no race results`); continue; }
    const main = rows.find((r) => r.positionNumber != null) || rows[0];
    const others = rows.filter((r) => r !== main);
    cand.push({ s, main, others });
    if (others.length) note(`${y}: ${k} is classified ${rows.length} times in the constructors' standings (${rows.map((r) => `${r.positionText}: ${r.points} pts`).join(', ')}); merged into one entry`);
  }
  for (const s of stat.values()) if (!byKey.has(s.key)) note(`${y}: ${s.key} has race results but is not in the constructors' standings`);
  cand.sort((a, b) => a.main.positionDisplayOrder - b.main.positionDisplayOrder);

  const usable = sessions.filter((s) => !s.flags.length);
  const seasonMedianSpeed = median(usable.map((s) => s.speedKmh));
  for (const s of sessions) {
    s.cls = s.flags.length || seasonMedianSpeed == null ? null
      : s.speedKmh > seasonMedianSpeed ? 'power' : s.speedKmh < seasonMedianSpeed ? 'twisty' : 'mid';
  }
  const typicalFieldGap = median(usable.map((s) => s.fieldMedianGap));
  const gapLimit = Math.max(RULES.gapLimitMinPct, RULES.gapLimitFactor * (typicalFieldGap || 0));
  const droppedGaps = [];
  const totals = indexBy(seasonConstructors.get(y) || [], (r) => r.constructorId);

  const makeEntry = ({ s, main, others }) => {
    const k = s.key;
    const id = `${y}-${s.constructorId}`;
    const con = constructors.get(s.constructorId), em = engineMakers.get(s.engineManufacturerId);
    const country = countries.get(con.countryId);
    const mine = (rows) => rows.filter((r) => keyOf(r) === k);

    const chassisIds = uniq(mine(entrantChassis.get(y) || []).map((r) => r.chassisId));
    const chassisAll = chassisIds.map((c) => chassisById.get(c)?.name || c);
    if (!chassisAll.length) note(`${id}: no chassis in F1DB`);
    const engineIds = uniq(mine(entrantEngines.get(y) || []).map((r) => r.engineId));
    if (engineIds.length !== 1) note(`${id}: ${engineIds.length} engines in F1DB (${engineIds.join(', ')})`);
    const engine = engineIds.length ? engineSpec(engines.get(engineIds[0])) : null;
    const badge = BADGED_ENGINES[s.engineManufacturerId];
    if (engine && em && engine.designation === em.name) engine.designationIsBadge = true; // F1DB has no type designation, only the badge
    const entrantNames = uniq(mine(entrantConstructors.get(y) || []).map((r) => entrants.get(r.entrantId)?.name || r.entrantId));

    // pace
    const gaps = [];
    for (const ses of usable) {
      const ms = ses.best.get(k);
      if (!ms) continue;
      const g = (ms / ses.poleMs - 1) * 100;
      if (g > gapLimit) { droppedGaps.push(`${id} r${ses.race.round} +${g.toFixed(1)}%`); continue; }
      gaps.push({ round: ses.race.round, gap: g, rel: (ms / ses.fieldMedianMs - 1) * 100, cls: ses.cls });
    }
    const pw = gaps.filter((g) => g.cls === 'power').map((g) => g.gap), tw = gaps.filter((g) => g.cls === 'twisty').map((g) => g.gap);
    const gp = median(pw), gt = median(tw);
    // the same split measured against the session's median constructor instead of the fastest lap: the fastest car
    // is at 0 % gap wherever it is on pole, which hides its own strengths; against the field it is not
    const rp = median(gaps.filter((g) => g.cls === 'power').map((g) => g.rel)), rt = median(gaps.filter((g) => g.cls === 'twisty').map((g) => g.rel));

    // cross-check against F1DB's own season totals
    const tot = totals.get(s.constructorId);
    if (tot) {
      const diff = [['totalRaceStarts', s.started.size], ['totalRaceWins', s.wins.size], ['totalPolePositions', s.poles.size], ['totalPodiums', s.podiums], ['totalPoints', s.points]]
        .filter(([f, v]) => Math.abs(tot[f] - v) > 1e-9).map(([f, v]) => `${f} ${tot[f]} vs ${v} from the results`);
      if (diff.length) note(`${id}: F1DB season totals differ from its race results: ${diff.join('; ')}`);
    } else note(`${id}: no F1DB season totals row`);
    if (Math.abs(s.points - main.points) > 1e-9) note(`${id}: ${main.points} championship points, but its cars scored ${round(s.points, 2)} in the races and sprints (exclusion or penalty)`);

    const tyres = [...s.tyres].sort((a, b) => b[1] - a[1]).map(([t]) => tyreMakers.get(t)?.name || t);
    return {
      id,
      year: y,
      constructorId: s.constructorId,
      lineage: lineageOf(s.constructorId),
      constructor: con.name,
      constructorFullName: con.fullName,
      entrants: entrantNames,
      country: country ? country.name : null,
      countryCode: country ? country.alpha2Code : null,
      chassis: chassisAll[0] || null,
      chassisAll,
      engineManufacturerId: s.engineManufacturerId,
      engineManufacturer: em ? em.name : s.engineManufacturerId,
      engineBuiltBy: badge && y >= badge.years[0] && y <= badge.years[1] ? badge.builtBy : (em ? em.name : null),
      engine,
      tyres: tyres[0] || null,
      tyresAll: tyres,
      standing: {
        position: main.positionNumber, text: main.positionText, points: main.points,
        pointsScored: round(s.points, 2),
        champion: !!main.championshipWon,
        otherClassifications: others.length ? others.map((r) => ({ text: r.positionText, points: r.points })) : undefined,
      },
      raceStarts: s.started.size,
      carStarts: s.carStarts,
      wins: s.wins.size,
      poles: s.poles.size,
      podiums: s.podiums,
      podiumRaces: s.podiumRaces.size,
      fastestLaps: s.fastestLaps.size,
      drivers: [...s.drivers.values()].sort((a, b) => b.starts - a.starts || a.id.localeCompare(b.id)).map((d) => {
        const dr = drivers.get(d.id);
        return { id: d.id, name: dr?.name || d.id, abbreviation: dr?.abbreviation || null, number: [...d.numbers].sort((a, b) => b[1] - a[1])[0]?.[0] || null, starts: d.starts };
      }),
      pace: {
        medianGapPct: round(median(gaps.map((g) => g.gap)), 3),
        meanGapPct: gaps.length ? round(gaps.reduce((a, g) => a + g.gap, 0) / gaps.length, 3) : null,
        bestGapPct: gaps.length ? round(Math.min(...gaps.map((g) => g.gap)), 3) : null,
        sessions: gaps.length,
        lowSample: gaps.length < RULES.minSessionsForPace,
        rank: null,
        gaps: gaps.map((g) => [g.round, round(g.gap, 3)]),
      },
      character: {
        powerGapPct: round(gp, 3), twistyGapPct: round(gt, 3), powerSessions: pw.length, twistySessions: tw.length,
        // positive = the car is further from the fastest lap on slow circuits than on fast ones
        twistyMinusPowerPct: gp != null && gt != null ? round(gt - gp, 3) : null,
        // lap time against the session's median constructor (negative = faster than the midfield), per class
        powerVsFieldPct: round(rp, 3), twistyVsFieldPct: round(rt, 3),
        rawVsField: rp != null && rt != null ? rt - rp : null,
        vsFieldPct: null, // twistyVsField - powerVsField, centred on the season's median entry; positive = relatively stronger on fast circuits
        lean: null,
        lowSample: pw.length < RULES.minSessionsPerClass || tw.length < RULES.minSessionsPerClass,
      },
      note: ENTRY_NOTES[id] || undefined,
    };
  };

  const entries = cand.map(makeEntry);
  for (const e of entries) if (!/^[a-z0-9-]{1,40}$/.test(e.id)) note(`${y}: entry id ${e.id} does not match /^[a-z0-9-]{1,40}$/`);
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error(`${y}: duplicate entry ids`);

  // hand corrections
  for (const c of CORRECTIONS) {
    const e = entries.find((x) => x.id === c.id);
    if (!e) continue;
    if (c.field === 'chassis') {
      if (e.chassis !== c.f1db) { note(`${c.id}: correction of chassis not applied, F1DB now says ${e.chassis} (expected ${c.f1db})`); continue; }
      e.chassisF1db = e.chassis; e.chassis = c.value; e.chassisAll = e.chassisAll.map((x) => (x === c.f1db ? c.value : x));
    } else if (c.field === 'engine.designation') {
      if (!e.engine || e.engine.designation !== c.f1db) { note(`${c.id}: correction of the engine designation not applied, F1DB now says ${e.engine?.designation} (expected ${c.f1db})`); continue; }
      e.engine.designationF1db = e.engine.designation; e.engine.designation = c.value; e.engine.fullName = e.engine.fullName.replace(c.f1db, c.value);
    }
    c.applied = true;
  }

  // pace rank; ties keep the standings order
  for (const e of entries) if (!e.pace.sessions) note(`${e.id}: no usable qualifying time`);
  [...entries].sort((a, b) => (a.pace.medianGapPct ?? 1e9) - (b.pace.medianGapPct ?? 1e9) || entries.indexOf(a) - entries.indexOf(b))
    .forEach((e, i) => { e.pace.rank = i + 1; });
  // character relative to the field
  const fieldDelta = median(entries.map((e) => e.character.rawVsField).filter((v) => v != null));
  for (const e of entries) {
    const d = e.character.rawVsField;
    delete e.character.rawVsField;
    if (d == null) continue;
    const v = d - fieldDelta;
    e.character.vsFieldPct = round(v, 3);
    // 'power' = relatively stronger on fast circuits than the typical car of that season, 'twisty' = on slow ones
    e.character.lean = Math.abs(v) < RULES.characterNeutralBandPct ? 'neutral' : v > 0 ? 'power' : 'twisty';
  }
  // engine groups: the only straight-line indication the source allows (there is no speed-trap data in F1DB)
  const engineGroups = [...groupBy(entries, (e) => e.engineManufacturerId)].map(([em, list]) => ({
    engineManufacturerId: em,
    engineManufacturer: list[0].engineManufacturer,
    builtBy: list[0].engineBuiltBy,
    entries: list.map((e) => e.id),
    medianGapPct: round(median(list.map((e) => e.pace.medianGapPct).filter((v) => v != null)), 3),
    medianCharacterVsFieldPct: round(median(list.map((e) => e.character.vsFieldPct).filter((v) => v != null)), 3),
  })).sort((a, b) => (b.medianCharacterVsFieldPct ?? -1e9) - (a.medianCharacterVsFieldPct ?? -1e9));

  // champion / formula
  const champRow = official.find((s) => s.championshipWon) || null;
  const champEntry = entries.find((e) => (champRow ? e.constructorId === champRow.constructorId : false)) || entries[0];
  const dStand = (driverStandings.get(y) || []).slice().sort((a, b) => a.positionDisplayOrder - b.positionDisplayOrder);
  const dChamp = dStand.find((d) => d.championshipWon) || null;
  const topDriver = dChamp || dStand[0] || null;
  const mix = new Map();
  for (const e of entries) {
    if (!e.engine) continue;
    const f = formulaOf(e.engine);
    if (!mix.has(f.label)) mix.set(f.label, { ...f, entries: 0 });
    mix.get(f.label).entries++;
  }
  const engineMix = [...mix.values()].sort((a, b) => b.entries - a.entries);
  if (engineMix.length !== 1) note(`${y}: ${engineMix.length} engine formulas among the entries (${engineMix.map((m) => `${m.label} x${m.entries}`).join(', ')})`);

  const complete = held.length === seasonRaces.length;
  if (!complete) note(`${y}: season in progress, ${held.length} of ${seasonRaces.length} races held (F1DB ${release.tag}); standings, statistics and pace are interim`);
  if (droppedGaps.length) note(`${y}: ${droppedGaps.length} single gap(s) above ${round(gapLimit, 1)} % dropped as unrepresentative: ${droppedGaps.join(', ')}`);

  return {
    year: y,
    complete,
    races: held.length,
    racesScheduled: seasonRaces.length,
    engineFormula: engineMix[0] ? (({ entries: _n, ...f }) => f)(engineMix[0]) : null,
    tyres: uniq(entries.flatMap((e) => e.tyresAll)),
    champion: { entryId: champEntry.id, decided: !!champRow },
    driversChampion: topDriver ? { driver: drivers.get(topDriver.driverId)?.name || topDriver.driverId, decided: !!dChamp } : null,
    eraIndex: round(eraIndex.get(y), 4),
    eraIndexDirect: eraDirect.get(y).ratio == null ? null : round(eraDirect.get(y).ratio, 4),
    eraIndexDirectMatches: eraDirect.get(y).matches,
    eraIndexFit: round(eraFit.byYear.get(y), 4),
    medianPoleSpeedKmh: round(seasonMedianSpeed, 1),
    pace: { sessionsUsed: usable.length, sessionsTotal: sessions.length, typicalFieldMedianGapPct: round(typicalFieldGap, 3), gapLimitPct: round(gapLimit, 2) },
    engineGroups,
    sessions: sessions.map((s) => ({
      round: s.race.round,
      grandPrix: grandsPrix.get(s.race.grandPrixId)?.name || s.race.grandPrixId,
      circuit: circuits.get(s.race.circuitId)?.name || s.race.circuitId,
      layout: s.race.circuitLayoutId,
      lengthKm: s.race.courseLength,
      poleMs: s.poleMs,
      poleSpeedKmh: round(s.speedKmh, 1),
      fastestSegment: s.fastestSegment,
      q1VsFastest: s.q1BestMs && s.poleMs ? round(s.q1BestMs / s.poleMs, 4) : null,
      vsRaceFastestLap: s.raceFastestLapMs && s.poleMs ? round(s.poleMs / s.raceFastestLapMs, 4) : null,
      vsAdjacentSeasons: s.vsAdjacent == null ? null : round(s.vsAdjacent, 4),
      fieldMedianGapPct: round(s.fieldMedianGap, 3),
      class: s.cls,
      excluded: s.flags.length ? s.flags.slice() : undefined,
    })),
    entries,
  };
}

const seasons = years.map(buildSeason);
for (const c of CORRECTIONS) if (!c.applied) note(`correction for ${c.id} (${c.field}) was not applied`);

// lineage table
const lineages = {};
for (const s of seasons) for (const e of s.entries) {
  const l = lineages[e.lineage] || (lineages[e.lineage] = []);
  const last = l[l.length - 1];
  if (last && last.constructorId === e.constructorId && last.to === s.year - 1) last.to = s.year;
  else l.push({ constructorId: e.constructorId, constructor: e.constructor, from: s.year, to: s.year });
}

// ---- output --------------------------------------------------------------------------------------------
const out = {
  schema: 2,
  generatedBy: 'tools/build-seasons.mjs',
  range: [RULES.firstYear, RULES.lastYear],
  source: {
    name: 'F1DB',
    url: 'https://github.com/f1db/f1db',
    release: release.tag,
    publishedAt: release.publishedAt,
    asset: release.asset,
    sha256: release.sha256,
    licence: 'CC BY 4.0',
    licenceName: 'Creative Commons Attribution 4.0 International License',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    licenceStatement: 'F1DB is licensed under a Creative Commons Attribution 4.0 International License.', // README of the repository, verbatim
    attribution: `Formula 1 season data: F1DB ${release.tag} (https://github.com/f1db/f1db), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); filtered, aggregated and in a few documented places corrected for F1Drive.`,
    attributionShort: 'F1 data © F1DB (CC BY 4.0), modified',
  },
  rules: RULES,
  straightLineSpeed: {
    available: false,
    reason: `F1DB ${release.tag} holds no speed-trap data and no fastest-lap speeds (its fastest-laps table has lap and time only), so no straight-line ranking can be derived from it. The nearest indication is the character split (entry.character) and its median per engine (season.engineGroups).`,
  },
  eraIndex: {
    baseYear: RULES.baseYear,
    definition: 'fastest qualifying lap relative to the base season on like-for-like layouts (same F1DB circuit layout id and course length; usable sessions only); > 1 = slower lap times. byYear chains the median lap-time ratio of each pair of consecutive seasons; direct compares a season with the base season on the layouts they share, without chaining; fit is a two-way least-squares fit over all seasons at once (both are cross-checks: where they differ from byYear, that difference is the uncertainty).',
    byYear: Object.fromEntries(years.map((y) => [y, round(eraIndex.get(y), 4)])),
    direct: Object.fromEntries(years.map((y) => [y, eraDirect.get(y).ratio == null ? null : round(eraDirect.get(y).ratio, 4)])),
    directMatches: Object.fromEntries(years.map((y) => [y, eraDirect.get(y).matches])),
    fit: Object.fromEntries(years.map((y) => [y, round(eraFit.byYear.get(y), 4)])),
    fitInfo: { method: 'two-way least squares on log pole time (layout + season), second pass without points missed by more than rules.eraFitTrimPct', points: eraFit.points, trimmed: eraFit.trimmed, layouts: eraFit.layouts, residualSdPct: round(eraFit.residualSdPct, 3) },
    medianPoleSpeedKmh: Object.fromEntries(seasons.map((s) => [s.year, s.medianPoleSpeedKmh])),
    links: eraLinks.map((l) => ({ from: l.from, to: l.to, matches: l.matches, ratio: round(l.ratio, 5), min: round(l.min, 4), max: round(l.max, 4), flag: l.flag || undefined, circuits: l.circuits })),
  },
  lineages,
  corrections: CORRECTIONS.map(({ applied, ...c }) => ({ ...c, applied: !!applied })),
  seasons,
  anomalies,
};

// compact but diff-friendly: one line per entry / session / link
function serialise(o) {
  const line = (v) => JSON.stringify(v);
  const L = [];
  L.push('{');
  for (const k of ['schema', 'generatedBy', 'range']) L.push(` ${line(k)}: ${line(o[k])},`);
  L.push(` "source": ${JSON.stringify(o.source, null, 1).replace(/\n/g, '\n ')},`);
  L.push(` "rules": ${line(o.rules)},`);
  L.push(` "straightLineSpeed": ${line(o.straightLineSpeed)},`);
  L.push(' "eraIndex": {');
  for (const k of ['baseYear', 'definition', 'byYear', 'direct', 'directMatches', 'fit', 'fitInfo', 'medianPoleSpeedKmh']) L.push(`  ${line(k)}: ${line(o.eraIndex[k])},`);
  L.push('  "links": [');
  L.push(o.eraIndex.links.map((l) => `   ${line(l)}`).join(',\n'));
  L.push('  ]');
  L.push(' },');
  L.push(' "lineages": {');
  L.push(Object.entries(o.lineages).map(([k, v]) => `  ${line(k)}: ${line(v)}`).join(',\n'));
  L.push(' },');
  L.push(' "corrections": [');
  L.push(o.corrections.map((c) => `  ${line(c)}`).join(',\n'));
  L.push(' ],');
  L.push(' "seasons": [');
  L.push(o.seasons.map((s) => {
    const { sessions, entries, engineGroups, ...head } = s;
    const rows = ['  {'];
    for (const [k, v] of Object.entries(head)) rows.push(`   ${line(k)}: ${line(v)},`);
    rows.push('   "engineGroups": [');
    rows.push(engineGroups.map((x) => `    ${line(x)}`).join(',\n'));
    rows.push('   ],');
    rows.push('   "sessions": [');
    rows.push(sessions.map((x) => `    ${line(x)}`).join(',\n'));
    rows.push('   ],');
    rows.push('   "entries": [');
    rows.push(entries.map((x) => `    ${line(x)}`).join(',\n'));
    rows.push('   ]');
    rows.push('  }');
    return rows.join('\n');
  }).join(',\n'));
  L.push(' ],');
  L.push(' "anomalies": [');
  L.push(o.anomalies.map((a) => `  ${line(a)}`).join(',\n'));
  L.push(' ]');
  L.push('}');
  return L.join('\n') + '\n';
}
const text = serialise(out);
JSON.parse(text); // must round-trip
writeFileSync(OUT, text);

// ---- report --------------------------------------------------------------------------------------------
const allEntries = seasons.flatMap((s) => s.entries);
const pad = (v, n) => String(v ?? '-').padEnd(n).slice(0, n);
const lpad = (v, n) => String(v ?? '-').padStart(n);
const fx = (v, d = 3) => (v == null ? '-' : v.toFixed(d));
console.log(`F1DB ${release.tag}${release.publishedAt ? ` (${release.publishedAt.slice(0, 10)})` : ''} -> ${OUT}`);
console.log(`${seasons.length} seasons ${years[0]}-${years[years.length - 1]}, ${allEntries.length} entries, ${(text.length / 1024).toFixed(0)} KiB`);

if (flag('--diag')) {
  console.log('\n-- timed sessions (pole s, fastest segment, Q1 / fastest, pole / race fastest lap, vs adjacent seasons, field median gap %, class, flags)');
  for (const s of seasons) for (const x of s.sessions) {
    console.log(`${s.year} r${lpad(x.round, 2)} ${pad(x.grandPrix, 18)} ${pad(x.layout, 22)} ${lpad(fx(x.poleMs / 1000), 8)} ${pad(x.fastestSegment, 2)} ${lpad(fx(x.q1VsFastest), 6)} ${lpad(fx(x.vsRaceFastestLap), 6)} ${lpad(fx(x.vsAdjacentSeasons), 6)} ${lpad(fx(x.fieldMedianGapPct, 2), 5)} ${pad(x.class, 6)} ${x.excluded ? x.excluded.join(', ') : ''}`);
  }
}

if (!flag('--quiet')) {
  for (const s of seasons) {
    console.log(`\n${s.year}${s.complete ? '' : ' (in progress)'}: ${s.races}/${s.racesScheduled} races, ${s.entries.length} entries, ${s.engineFormula?.label}, ${s.tyres.join('/')}; era index ${fx(s.eraIndex)} (direct ${fx(s.eraIndexDirect)} on ${s.eraIndexDirectMatches ?? '-'}, fit ${fx(s.eraIndexFit)}), median pole speed ${s.medianPoleSpeedKmh} km/h, sessions used ${s.pace.sessionsUsed}/${s.pace.sessionsTotal}`);
    console.log(' pos id                    lineage      chassis       engine                         pts   st  W  P pod |  gap%  n rk | power twisty  vsFld lean');
    for (const e of s.entries) {
      console.log(` ${lpad(e.standing.text, 3)} ${pad(e.id, 21)} ${pad(e.lineage, 12)} ${pad(e.chassisAll.join('/'), 13)} ${pad(e.engine?.designation === e.engineManufacturer ? e.engineManufacturer : `${e.engineManufacturer} ${e.engine?.designation ?? '?'}`, 28)} ${lpad(e.standing.points, 5)} ${lpad(e.raceStarts, 4)} ${lpad(e.wins, 2)} ${lpad(e.poles, 2)} ${lpad(e.podiums, 3)} | ${lpad(fx(e.pace.medianGapPct), 5)} ${lpad(e.pace.sessions, 2)} ${lpad(e.pace.rank, 2)} | ${lpad(fx(e.character.powerGapPct), 5)} ${lpad(fx(e.character.twistyGapPct), 6)} ${lpad(fx(e.character.vsFieldPct), 6)} ${e.character.lean ?? '-'}${e.character.lowSample ? '*' : ''}`);
    }
    const ex = s.sessions.filter((x) => x.excluded);
    if (ex.length) console.log(` not used: ${ex.map((x) => `r${x.round} ${x.grandPrix} (${x.excluded.join('+')})`).join('; ')}`);
  }
  console.log('\nera index (2025 = 1.000; > 1 = slower)');
  console.log(' year  index  direct (n)    fit  link from previous: ratio  n  [min .. max]   median pole km/h');
  for (const s of seasons) {
    const l = eraLinks.find((x) => x.to === s.year);
    console.log(` ${s.year}  ${fx(s.eraIndex)}  ${lpad(fx(s.eraIndexDirect), 5)} (${lpad(s.eraIndexDirectMatches, 2)})  ${fx(s.eraIndexFit)}  ${l ? `${fx(l.ratio, 4)} ${lpad(l.matches, 2)}  [${fx(l.min)} .. ${fx(l.max)}]` : pad('', 27)}   ${s.medianPoleSpeedKmh}`);
  }
}

// sanity checks against facts verified on the web (references in docs/seasons-data.md)
const CHECKS = [
  ['2010-red-bull', { chassis: 'RB6', engineManufacturer: 'Renault', designation: 'RS27-2010', cap: 2.4, cfg: 'V8', asp: 'NA', tyres: 'Bridgestone', wins: 9, poles: 15, podiums: 20, points: 498, position: 1 }],
  ['2014-mercedes', { chassis: 'F1 W05', designation: 'PU106A', cap: 1.6, cfg: 'V6', asp: 'turbo-hybrid', tyres: 'Pirelli', wins: 16, poles: 18, podiums: 31, points: 701, position: 1 }],
  ['2021-ferrari', { chassis: 'SF21', poles: 2, wins: 0 }],
  ['2020-mercedes', { chassis: 'F1 W11', cap: 1.6, cfg: 'V6', asp: 'turbo-hybrid', wins: 13, poles: 15, podiums: 25, points: 573, position: 1, raceStarts: 17 }],
  ['2023-red-bull', { chassis: 'RB19', engineManufacturer: 'Honda RBPT', designation: 'RBPTH001', cap: 1.6, cfg: 'V6', asp: 'turbo-hybrid', wins: 21, poles: 14, podiums: 30, points: 860, position: 1, raceStarts: 22 }],
  ['2018-force-india', { chassis: 'VJM11', points: 52, position: 7, raceStarts: 21, lineage: 'force-india' }],
  ['2019-racing-point', { lineage: 'force-india' }],
  ['2021-aston-martin', { lineage: 'force-india' }],
  ['2012-lotus-f1', { lineage: 'renault', constructor: 'Lotus' }],
  ['2010-lotus-racing', { lineage: 'lotus-racing' }],
  ['2014-caterham', { lineage: 'lotus-racing' }],
  ['2024-rb', { lineage: 'toro-rosso', chassis: 'VCARB 01' }],
  ['2025-ferrari', { chassis: 'SF-25', designation: '066/15' }],
  ['2025-red-bull', { chassis: 'RB21', designation: 'RBPTH003' }],
  ['2026-mercedes', { chassis: 'F1 W17', designation: 'AMG F1 M17', cap: 1.6, cfg: 'V6', asp: 'turbo-hybrid', wins: 11, points: 538, position: 1 }],
  ['2026-ferrari', { chassis: 'SF-26', wins: 2, points: 378, position: 2 }],
  ['2026-mclaren', { chassis: 'MCL40', wins: 2, points: 306, position: 3 }],
  ['2026-red-bull', { chassis: 'RB22', engineManufacturer: 'Red Bull Ford', designation: 'DM01' }],
  ['2026-racing-bulls', { chassis: 'VCARB 03', engineManufacturer: 'Red Bull Ford', lineage: 'toro-rosso' }],
  ['2026-audi', { chassis: 'R26', engineManufacturer: 'Audi', lineage: 'sauber' }],
  ['2026-cadillac', { chassis: 'MAC-26', engineManufacturer: 'Ferrari', designation: '067/6', lineage: 'cadillac' }],
  ['2026-aston-martin', { chassis: 'AMR26', engineManufacturer: 'Honda', designation: 'RA626H' }],
  ['2026-alpine', { chassis: 'A526', engineManufacturer: 'Mercedes', lineage: 'renault', poles: 1 }],
];
console.log('\nsanity checks');
let failed = 0;
for (const [id, want] of CHECKS) {
  const e = allEntries.find((x) => x.id === id);
  const got = e && {
    chassis: e.chassis, engineManufacturer: e.engineManufacturer, designation: e.engine?.designation, cap: e.engine?.capacityL, cfg: e.engine?.configuration, asp: e.engine?.aspiration,
    tyres: e.tyres, wins: e.wins, poles: e.poles, podiums: e.podiums, points: e.standing.points, position: e.standing.position, raceStarts: e.raceStarts, lineage: e.lineage, constructor: e.constructor,
  };
  const bad = !e ? ['missing'] : Object.keys(want).filter((k) => want[k] !== got[k]).map((k) => `${k}: ${got[k]} (expected ${want[k]})`);
  if (bad.length) failed++;
  console.log(` ${bad.length ? 'FAIL' : 'ok  '} ${id}${e ? `: ${e.constructor} ${e.chassis} / ${e.engine?.fullName}, P${e.standing.text} ${e.standing.points} pts, ${e.wins} wins, ${e.poles} poles, ${e.podiums} podiums, lineage ${e.lineage}` : ''}${bad.length ? ` -> ${bad.join('; ')}` : ''}`);
}
const structural = [];
if (seasons.length !== RULES.lastYear - RULES.firstYear + 1) structural.push('season count');
for (const s of seasons) {
  if (!s.entries.length) structural.push(`${s.year}: no entries`);
  if (s.eraIndex == null) structural.push(`${s.year}: no era index`);
  for (const e of s.entries) {
    if (!e.chassis) structural.push(`${e.id}: no chassis`);
    if (!e.engine) structural.push(`${e.id}: no engine`);
    else if (e.engine.capacityL == null || !e.engine.configuration || !e.engine.aspiration) structural.push(`${e.id}: incomplete engine data (${e.engine.fullName})`);
    if (!e.tyres) structural.push(`${e.id}: no tyre manufacturer`);
    if (e.tyresAll.length > 1) structural.push(`${e.id}: several tyre manufacturers`);
    if (e.pace.medianGapPct == null) structural.push(`${e.id}: no pace`);
    if (!e.drivers.length) structural.push(`${e.id}: no drivers`);
  }
}
if (seasons.find((s) => s.year === 2026).entries.length !== 11) structural.push('2026: expected 11 entries');
for (const m of structural) console.log(` WARN ${m}`);
console.log(`\nentries per season: ${seasons.map((s) => `${s.year}: ${s.entries.length}`).join(', ')}`);
console.log(`${CHECKS.length - failed}/${CHECKS.length} checks passed, ${structural.length} structural warnings, ${anomalies.length} anomalies recorded in the output`);
if (anomalies.length && !flag('--quiet')) { console.log('\nanomalies'); for (const a of anomalies) console.log(` - ${a}`); }
if (failed || structural.length) process.exitCode = 1;
