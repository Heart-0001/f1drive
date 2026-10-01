export const meta = {
  name: 'f1drive-track-audit',
  description: 'F1Drive: re-check the data of all 40 circuits against real-world sources (layout and length, direction, start line, pit side and limit, elevation profile and gradients, banking, tunnels / bridges) plus why climbs and banking do not read visually; research only, corrections proposed as data',
  phases: [
    { title: 'Audit', detail: '8 regional auditors + a perception analyst' },
    { title: 'Synthesis', detail: 'merge, verify the big corrections, write the correction file and report' },
  ],
}
const AUDIT = {
  type: 'object',
  properties: {
    tracks: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, verdict: { type: 'string', enum: ['ok', 'minor issues', 'major issues'] },
      findings: { type: 'array', items: { type: 'object', properties: {
        aspect: { type: 'string', description: 'layout | length | direction | start | pit | elevation | gradient | banking | tunnel | bridge | other' },
        game: { type: 'string' }, real: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor', 'cosmetic'] },
        proposedFix: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } },
      }, required: ['aspect', 'game', 'real', 'severity', 'proposedFix', 'sources'] } },
    }, required: ['id', 'verdict', 'findings'] } },
    filesWritten: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['tracks', 'filesWritten', 'notes'],
}
const PRE = `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive — a first-person F1 game on 40 real circuits (Electron 44 + Three.js r149, classic ES5 scripts; Node 24 for tools). Do NOT commit / push. The user (translated): "I need you to re-check the data of ALL the circuits"; just before: "at Spa the steep climb can't be felt visually either", "the banked corners at Madring / Zandvoort don't feel pronounced", "Monaco's slowest hairpin can't be taken even at 20 km/h", "please recreate Monaco's tunnel a bit".
How the track data is made: tools/build-tracks.mjs builds tracks-data.js (window.F1_TRACKS: id, name, location, lengthKm, points [[x, z] metres], elev [m per point], geo {lon0, lat0, kx, kz} with x = (lon - lon0) * kx, z = (lat - lat0) * kz, optional bankOverrides, pitSide, pitLimitKmh, START_AT overrides) from the bacinger/f1-circuits GeoJSON (pinned commit) and DEM elevation (Copernicus GLO-90 by default — coarse; tonight 9 tracks got better lidar sources: USGS 3DEP for COTA / Las Vegas / Indianapolis / Watkins Glen, IGN RGE ALTI for Monaco / Magny-Cours / Paul Ricard, GSI 5 m for Suzuka, AHN4 for Zandvoort; caches in tools/elevation-cache-*.json). js/track.js turns it into samples (~2 m) with elevation, curvature-derived banking (max 6 deg) plus the overrides, walls, pit lane (track.pit), terrain. Read tools/build-tracks.mjs (its header and the source tables), docs/v6-plan.md, and js/track.js as needed.
RIGHT NOW other workflows are editing the game: do NOT edit any existing file. Write only under devtests/track-audit/ (new). Network etiquette: OpenTopoData's public API allows about 1 request per second and 1000 per day for EVERYONE on this machine (several agents run at once): wait 2.5 s between your requests, at most 100 locations per request, cache every response under devtests/track-audit/cache/<source>/ and reuse it; prefer national open lidar / DEM services where they exist (they have their own limits: be gentle); Overpass: one query at a time, back off on 429. WebSearch quota may be exhausted: use WebFetch on known pages (Wikipedia, FIA circuit maps, official circuit sites) and direct API calls from node. Never invent a figure; cite every 'real' value. RESUMING AFTER A PAUSE: an earlier run was stopped while fetching data; devtests/track-audit/ already holds caches (cache/, git-ignored) and partial notes per region folder — reuse them, do not refetch what is cached.`
const CHECKS = `For EACH of your circuits, check the game data (load tracks-data.js in node; build the track with lib/three.min.js + js/track.js to get samples, banking and track.pit when needed) against real-world references, and report concrete, measured findings:
1. Layout and length: is the dataset's layout the CURRENT F1 layout (or the layout a 2010-2026 season used — note which; e.g. Barcelona without the final chicane since 2023, Albert Park 2022, Yas Marina 2021, Singapore 2023, Madring new for 2026 ...)? Compare the centreline with OpenStreetMap's raceway ways of that layout (max / mean lateral deviation in metres, where) and the official lap length.
2. Racing direction; start / finish line position (OSM start-finish node or the official map); pit lane side, entry / exit positions and the official pit speed limit.
3. Elevation: sample a better DEM than GLO-90 along the OSM centreline (national lidar or EU-DEM 25 m / SRTM 30 m / ALOS 30 m via OpenTopoData, or the services already used tonight), and compare with the game's elev: total range, the profile shape, and the steepest climbs / descents (grade in % over 50 m and 100 m windows, and where). Check the famous features explicitly against published numbers (e.g. Spa Eau Rouge / Raidillon gradient and the drop to Stavelot; Red Bull Ring climb to T3; Interlagos; Suzuka; COTA T1; Mugello; Imola Acque Minerali / Rivazza; Portimão crests; Istanbul T8 / T1 drop; Kyalami; Nürburgring). Flag any place where smoothing flattened a real gradient by more than ~2 percentage points or invented a slope that is not there.
4. Banking: real banked corners (with sourced angles) present / missing / wrong; corners the game banks that are flat in reality.
5. Covered sections and bridges the car drives through or under (tunnels, crossovers) and whether the game has them.
Write devtests/track-audit/<id>.json per circuit with your measurements (game vs real numbers, the DEM profile you used, sources) and a proposed correction in machine-readable form where you can (e.g. an elevation source / profile override, a bankOverrides entry, a START_AT point, pitSide / pitLimitKmh, a layout note). Rank severity honestly: 'major' = a player would notice it or a famous feature is wrong / missing.`

const BATCHES = [
  ['be-1925 (Spa-Francorchamps) — START HERE: the user said its steep climb cannot be felt', 'nl-1948 (Zandvoort)', 'de-1932 (Hockenheim)', 'de-1927 (Nurburgring GP)', 'gb-1948 (Silverstone)'],
  ['mc-1929 (Monaco)', 'fr-1960 (Magny-Cours)', 'fr-1969 (Paul Ricard)', 'es-1991 (Barcelona-Catalunya)', 'es-2026 (Madring)'],
  ['it-1922 (Monza)', 'it-1953 (Imola)', 'it-1914 (Mugello)', 'at-1969 (Red Bull Ring)', 'hu-1986 (Hungaroring)'],
  ['pt-1972 (Estoril)', 'pt-2008 (Portimao)', 'tr-2005 (Istanbul Park)', 'ru-2014 (Sochi)', 'az-2016 (Baku)'],
  ['us-2012 (COTA)', 'us-2023 (Las Vegas)', 'us-2022 (Miami)', 'us-1909 (Indianapolis)', 'us-1956 (Watkins Glen)', 'ca-1978 (Montreal)'],
  ['mx-1962 (Mexico City)', 'br-1940 (Interlagos)', 'br-1977 (Jacarepagua)', 'ar-1952 (Buenos Aires)', 'za-1961 (Kyalami)'],
  ['bh-2002 (Bahrain)', 'sa-2021 (Jeddah)', 'qa-2004 (Lusail)', 'ae-2009 (Yas Marina)'],
  ['jp-1962 (Suzuka)', 'sg-2008 (Marina Bay)', 'my-1999 (Sepang)', 'cn-2004 (Shanghai)', 'au-1953 (Albert Park)'],
]

phase('Audit')
const jobs = BATCHES.map((b, i) => () => agent(`${PRE}\n\nYOUR CIRCUITS: ${b.join(', ')}.\n\n${CHECKS}`, { label: 'audit ' + (i + 1) + ': ' + b[0].split(' ')[0], phase: 'Audit', schema: AUDIT }))
jobs.push(() => agent(`${PRE}

YOUR TASK (perception analyst — write only under devtests/track-audit/perception/): the user cannot FEEL the steep climb of Spa's Raidillon in the picture, nor the banking at Zandvoort / Madring. Independently of whether the data is right (other agents audit the data), find out how the game PRESENTS slope and banking and why it reads flat: read js/cockpit.js (camera mounting, pitch / roll following, smoothing, FOV law), js/car.js (state.pitch / roll smoothing: ATTITUDE_TAU), js/main.js (camera / scene / fog), js/track.js (terrain, walls, kerbs on banking), js/scenery.js. In the real game (offscreen Electron, MUTED through devtests/electron-userdata.js; look at devtests/v6-smoke or devtests/track-fix/shots.js for how to place the car) take cockpit screenshots approaching and climbing Raidillon, at Zandvoort T3 / T14 and Madring's banked turn, and compare with what real onboard footage shows (describe the reference: e.g. at Raidillon the track rises like a wall ahead and the horizon disappears; at Zandvoort the car visibly leans into the bowl). Measure the game's road grade and bank at those spots and the camera's actual pitch / roll / FOV there. Recommend concrete presentation changes (camera height / FOV / pitch follow / horizon cues / g-force head motion / terrain and wall detail on slopes / bank-visible kerbs and run-off), with before / after screenshots made on COPIES of the files (serve modified copies through a patch mechanism like devtests/gp-e2e/lib.js PATCH), and READ them.
Return your findings as tracks entries (one per place, id = the circuit id) with aspect 'other' and the exact recommended changes in proposedFix.`, { label: 'perception: slopes + banking', phase: 'Audit', schema: AUDIT }))

const results = (await parallel(jobs)).filter(Boolean)
const all = [].concat(...results.map(r => r.tracks || []))
log('audited entries: ' + all.length + ', major findings: ' + all.reduce((n, t) => n + (t.findings || []).filter(f => f.severity === 'major').length, 0))

phase('Synthesis')
const synth = await agent(`${PRE}

Nine auditors have checked the 40 circuits (their per-circuit files are in devtests/track-audit/*.json, their summaries below). YOUR TASK:
1. Independently verify every 'major' finding (re-measure: re-sample the DEM, re-query OSM, re-read the cited source); drop what you cannot confirm, mark the rest verified.
2. Write tools/track-audit.json (new): the verified corrections in a form tools/build-tracks.mjs can apply later — per circuit: elevation source / profile overrides (which DEM service, resolution, any manual correction and why), bankOverrides additions / changes, START_AT, pitSide / pitLimitKmh, layout notes (and if a layout is outdated, which source geometry would replace it and what that would break: grid, pit lane, scenery-data alignment, seasons calibration), tunnels / bridges.
3. Write docs/track-audit.md (Traditional Chinese, concise): a table of all 40 circuits with the verdict and the main issues, what will be fixed and what will not (and why), and the perception recommendations.
Summaries:
${JSON.stringify(results.map(r => ({ tracks: (r.tracks || []).map(t => ({ id: t.id, verdict: t.verdict, findings: (t.findings || []).map(f => ({ aspect: f.aspect, severity: f.severity, game: f.game, real: f.real, proposedFix: f.proposedFix })) })), notes: r.notes })), null, 1).slice(0, 180000)}`, { label: 'synthesis + verify', phase: 'Synthesis', schema: AUDIT })
return { results, synth }
