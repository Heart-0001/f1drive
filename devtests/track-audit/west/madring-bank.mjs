// Madring per-turn banking from the official circuit page (https://www.madring.com/en/circuit, read 2026-10-01:
// "Banking 3%" etc. per turn, "ContraBanking" = outside of the corner lower) as bankOverrides entries for
// tools/build-tracks.mjs BANKED (deg > 0: inside lower; deg < 0: contra-banking, which js/track.js supports).
// from / to = the ends of the game's corner (radius < 400 m, corners.mjs) on the game centreline, [lat, lon].
// Turn <-> corner matching by order, angle and length (official angle / length vs game): see the table below.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';
import { loadGame, r } from './lib-audit.mjs';
const g = loadGame('es-2026'), S = g.samples, ds = g.ds;
const at = (s) => { const p = S[Math.round(s / ds) % S.length]; return [+p.lat.toFixed(6), +p.lon.toFixed(6)]; };
const pct2deg = (p) => r(Math.atan(p / 100) * 180 / Math.PI, 2);
// [turn, official angle deg, official length m, banking %, contra, game corner s from, to, game angle, note]
const T = [
  ['T1', 77.54, 16.92, 3, false, 168, 226, 79],
  ['T2', 77.58, 20.99, 1, false, 230, 280, 78],
  ['T3 Hortaleza', 67.2, 139.73, 3, true, 306, 460, 67, 'official "Banking -3%"'],
  ['T4', 70.9, 432.55, 2, false, 1078, 1270, 34, 'game / OSM curve only ~34 deg over 192 m (official 70.9 deg, 432.55 m)'],
  ['T5', 116.89, 22.95, 3, false, 1280, 1316, 68, 'T5 / 5A / T6 matching uncertain (game L68-R58-L38, OSM L48-R65-L62)'],
  ['T6 Subida de las Carcavas', 47.55, 31.53, 3, false, 1354, 1412, 38],
  ['T7 Subida de las Carcavas', 90, 17.28, 3, false, 1666, 1708, 84],
  ['T8 El Bunker', 84.39, 72.79, 5, false, 1714, 1806, 80],
  ['T9', 27.89, 21.42, 7, false, 1832, 1884, 28],
  ['T10 La Chicane', 57.6, 92.94, 2, false, 1990, 2060, 52],
  ['T11 La Chicane', 78.82, 94.5, 2, true, 2088, 2206, 75],
  ['T13', 83.93, 45.41, 4, false, 3042, 3140, 88],
  ['T14 Las Enlazadas de Valdebebas', 53.8, 76.06, 3, true, 3216, 3328, 53],
  ['T15 Las Enlazadas de Valdebebas', 90, 209.7, 3, false, 3398, 3610, 90],
  ['T16 Las Enlazadas de Valdebebas', 29.03, 40.54, 2, true, 3700, 3752, 30],
  ['T17', 84.19, 14.69, 4, false, 3762, 3824, 85],
  ['T18 Norte', 77.44, 95.34, 2, false, 3980, 4078, 72],
  ['T19', 89.97, 169.79, 1, false, 4124, 4306, 87],
  ['T20', 117.5, 32.4, 2, false, 4552, 4614, 114],
  ['T21', 71.02, 11.16, 1, true, 4712, 4774, 83],
  ['T22 El Parque', 90.81, 119.14, 1, true, 5014, 5090, 87],
];
const list = T.map(([name, ang, len, pct, contra, s0, s1, gang, note]) => ({
  name, deg: contra ? -pct2deg(pct) : pct2deg(pct), officialPct: contra ? -pct : pct, from: at(s0), to: at(s1),
  gameS: [s0, s1], gameBankDeg: r(Math.max(...S.slice(Math.round(s0 / ds), Math.round(s1 / ds) + 1).map((p) => Math.abs(p.bank))), 1),
  officialAngle: ang, officialLengthM: len, gameAngle: gang, note }));
list.splice(11, 0, { name: 'T12 La Monumental', deg: 13.5, officialPct: 24, keep: 'existing BANKED entry (from [40.479284, -3.624737] to [40.478759, -3.622536]) is right: 24 % = 13.5 deg; game section above 3 deg = 548 m vs official 547.82 m' });
writeFileSync(resolve(HERE, 'res', 'madring-bank.json'), JSON.stringify(list, null, 1));
for (const b of list) console.log(b.name.padEnd(34), String(b.deg).padStart(6), 'deg (', b.officialPct, '%) game peak', b.gameBankDeg, 'deg');
