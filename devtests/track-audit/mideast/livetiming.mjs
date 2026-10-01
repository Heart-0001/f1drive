// F1 live-timing archive (livetiming.formula1.com/static, the feed FastF1 reads): Position.z.jsonStream of one session
// per circuit = every car's X / Y / Z (decimetres, a circuit-local frame) ~4 times a second. Z is the measured height of
// the car on the road, an independent elevation reference for the whole lap (no DEM, no buildings, no smoothing).
// Cached under devtests/track-audit/cache/f1livetiming/ (one ~4 MB file per circuit, fetched once).
// Jeddah reuses the 2025 qualifying file another agent already downloaded (devtests/handling-test/ref/sa-pos.txt,
// timestamps 2025-04-19 16:47..18:12 UTC = the 2025 Saudi Arabian GP qualifying), copied, not refetched.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { cachedGet, CACHE } from './net.mjs';
import { ROOT } from './core.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));

export const SESSIONS = {
  'bh-2002': '2025/2025-04-13_Bahrain_Grand_Prix/2025-04-12_Qualifying/',
  'sa-2021': '2025/2025-04-20_Saudi_Arabian_Grand_Prix/2025-04-19_Qualifying/',
  'qa-2004': '2025/2025-11-30_Qatar_Grand_Prix/2025-11-29_Qualifying/',
  'ae-2009': '2025/2025-12-07_Abu_Dhabi_Grand_Prix/2025-12-06_Qualifying/',
};

export async function positionStream(id) {
  const name = id + '-' + SESSIONS[id].split('/')[2] + '-Position.z.jsonStream';
  const file = resolve(CACHE, 'f1livetiming', name);
  if (!existsSync(file) && id === 'sa-2021') {
    const src = resolve(ROOT, 'devtests', 'handling-test', 'ref', 'sa-pos.txt');
    if (existsSync(src)) { mkdirSync(dirname(file), { recursive: true }); copyFileSync(src, file); }
  }
  const txt = await cachedGet('f1livetiming', name, 'https://livetiming.formula1.com/static/' + SESSIONS[id] + 'Position.z.jsonStream', { gapMs: 3000 });
  return { txt: String(txt), url: 'https://livetiming.formula1.com/static/' + SESSIONS[id] + 'Position.z.jsonStream', file };
}

// -> { cars: { num: [[tMs, X m, Y m, Z m], ...] } } (OnTrack rows only, (0,0,0) placeholders dropped)
export function decodePositions(txt) {
  const cars = {};
  for (const ln of txt.replace(/^﻿/, '').split(/\r?\n/)) {
    const q = ln.indexOf('"');
    if (q < 0) continue;
    let j;
    try { j = JSON.parse(inflateRawSync(Buffer.from(ln.slice(q + 1, ln.lastIndexOf('"')), 'base64')).toString('utf8')); } catch (e) { continue; }
    for (const p of j.Position || []) {
      const t = Date.parse(p.Timestamp);
      for (const [num, e] of Object.entries(p.Entries || {})) {
        if (e.Status !== 'OnTrack' || (e.X === 0 && e.Y === 0 && e.Z === 0)) continue;
        (cars[num] = cars[num] || []).push([t, e.X / 10, e.Y / 10, e.Z / 10]);
      }
    }
  }
  for (const k of Object.keys(cars)) cars[k].sort((a, b) => a[0] - b[0]);
  return { cars };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const id of process.argv.slice(2)) {
    const { txt, file } = await positionStream(id);
    const d = decodePositions(txt);
    const n = Object.values(d.cars).reduce((a, r) => a + r.length, 0);
    console.log(id, file, txt.length, 'bytes', Object.keys(d.cars).length, 'cars', n, 'rows');
  }
}
