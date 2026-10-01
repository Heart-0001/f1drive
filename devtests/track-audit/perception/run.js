// node devtests/track-audit/perception/run.js <track> <plan name> <tag> [PATCH spec | ""] [CFG json]
// Runs shots.js under Electron with that plan (plans/<plan name>.json) and prints a compact table of the measurements.
'use strict';
const { spawnSync } = require('child_process'), path = require('path');
const [track, plan, tag, patch, cfg] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const env = Object.assign({}, process.env, { TRACK: track, PLAN: path.join(__dirname, 'plans', plan + '.json'), TAG: tag || '' });
if (patch) env.PATCH = patch; else delete env.PATCH;
delete env.DUMP;
if (cfg) env.CFG = cfg; else delete env.CFG;
const r = spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(__dirname, 'shots.js')],
  { cwd: ROOT, env, encoding: 'utf8', timeout: 660000, maxBuffer: 64 << 20 });
const out = (r.stdout || '') + (r.stderr || '');
for (const line of out.split(/\r?\n/)) {
  if (!line.trim() || /deprecated|GPU state|WaitForGet|Event<WebContents/.test(line)) continue;
  if (line[0] !== '{') { console.log(line); continue; }
  const m = JSON.parse(line);
  if (m.kmh === undefined) { console.log(m.n + ' (free camera)'); continue; }
  const a = m.ahead.map(x => x.d + ':' + x.dy + 'm/' + x.sy).join(' ');
  console.log(`${m.n.padEnd(16)} s ${m.s} ${m.kmh} km/h grade ${m.gradePct}% bank ${m.bankDeg} | car p ${m.carPitch} r ${m.carRoll} | cam fov ${m.camFov}/${m.camHFov} h ${m.camH} ` +
    `view p ${m.viewPitch} r ${m.viewRoll} | horizonY ${m.horizonY} (${m.pxPerDegCentre} px/deg) | ahead d:dy/screenY ${a}` + (m.marks && m.marks.length ? `
${''.padEnd(16)} marks s:dy/dist/screenY ${m.marks.map(k => k.s + ':' + k.dy + 'm/' + k.dist + 'm/' + k.sy + (k.front ? '' : '(behind)')).join(' ')}` : '') + (m.perc && m.perc.load !== undefined ? `
${''.padEnd(16)} head: ${JSON.stringify(m.perc)}` : ''));
}
if (r.error) console.log('spawn: ' + r.error.message);
