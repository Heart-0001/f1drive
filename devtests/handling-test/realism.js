// node devtests/handling-test/realism.js [out/<laps40 run>.json]   (default out/v1.json)
// Track-to-track realism of the lap times of a laps40.js run: for the 24 circuits of the 2025 season (+ Madring, 2026
// pole scaled by the 2026 / 2025 era index of tools/seasons-raw.json), the keyboard autopilot's flying lap of the
// reference car (F1.REF_SPEC = the 2025 standard car) / the real 2025 pole (tools/seasons-raw.json, F1DB). The
// game's absolute pace is not calibrated to the real laps (the seasons are calibrated relative to this car), but the
// ratio should be the same everywhere: its spread (coefficient of variation) and its correlation with how slow the
// circuit is (real pole average speed) say where the physics is off.
const fs = require('fs'), path = require('path');
const file = process.argv[2] || path.join(__dirname, 'out', 'v1.json');
const J = JSON.parse(fs.readFileSync(file, 'utf8'));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'seasons-raw.json'), 'utf8'));
const MAP = { 'Melbourne': 'au-1953', 'Shanghai': 'cn-2004', 'Suzuka': 'jp-1962', 'Bahrain': 'bh-2002', 'Jeddah': 'sa-2021',
  'Miami': 'us-2022', 'Enzo e Dino Ferrari': 'it-1953', 'Monaco': 'mc-1929', 'Catalunya': 'es-1991', 'Gilles Villeneuve': 'ca-1978',
  'Red Bull Ring': 'at-1969', 'Silverstone': 'gb-1948', 'Spa-Francorchamps': 'be-1925', 'Hungaroring': 'hu-1986',
  'Zandvoort': 'nl-1948', 'Monza': 'it-1922', 'Baku': 'az-2016', 'Marina Bay': 'sg-2008', 'Americas': 'us-2012',
  'Hermanos Rodríguez': 'mx-1962', 'José Carlos Pace': 'br-1940', 'Las Vegas': 'us-2023', 'Lusail': 'qa-2004', 'Yas Marina': 'ae-2009' };
const s25 = raw.seasons.find(s => s.year === 2025), s26 = raw.seasons.find(s => s.year === 2026);
const real = {};
for (const x of s25.sessions) if (MAP[x.circuit]) real[MAP[x.circuit]] = { lap: x.poleMs / 1000, kmh: x.poleSpeedKmh };
const md = s26 && s26.sessions.find(x => x.circuit === 'Madring');
if (md) real['es-2026'] = { lap: md.poleMs / 1000 * s25.eraIndex / s26.eraIndex, kmh: md.poleSpeedKmh, scaled: true };
const ids = Object.keys(real).sort((a, b) => real[a].kmh - real[b].kmh);
function stats(xs) { const m = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length); return { m, sd, cv: sd / m }; }
function corr(a, b) { const A = stats(a), B = stats(b); let c = 0; for (let i = 0; i < a.length; i++) c += (a[i] - A.m) * (b[i] - B.m); return c / a.length / (A.sd * B.sd); }
console.log('circuit    real pole  km/h  ' + J.names.map(n => n.slice(0, 18).padEnd(18)).join(' '));
const cols = J.names.map(() => []);
for (const id of ids) {
  let row = `${id.padEnd(9)} ${real[id].lap.toFixed(2).padStart(8)} ${String(real[id].kmh).padStart(5)}  `;
  J.names.forEach((n, k) => { const r = J.res[n][id]; const q = r.keys / real[id].lap; cols[k].push(q); row += `${r.keys.toFixed(2).padStart(7)} x${q.toFixed(3)}     `; });
  console.log(row);
}
const kmh = ids.map(id => real[id].kmh);
J.names.forEach((n, k) => {
  const st = stats(cols[k]);
  console.log(`${n.padEnd(26)} game / real: mean x${st.m.toFixed(3)}, spread (CV) ${(st.cv * 100).toFixed(2)} %, min x${Math.min(...cols[k]).toFixed(3)} max x${Math.max(...cols[k]).toFixed(3)}, correlation with the real average speed ${corr(cols[k], kmh).toFixed(2)}`);
});
