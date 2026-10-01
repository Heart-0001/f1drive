// The real starting grid from the F1 live-timing archive: the first 3 MB of the 2025 race's Position.z.jsonStream (HTTP
// Range request, cached under cache/f1livetiming/), i.e. the minutes before the start. The cars stand still on their
// grid slots just before lights out; the most advanced car = pole, slightly behind the start line.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CACHE } from './net.mjs';
import { decodePositions } from './livetiming.mjs';

export const RACES = {
  'bh-2002': '2025/2025-04-13_Bahrain_Grand_Prix/2025-04-13_Race/',
  'sa-2021': '2025/2025-04-20_Saudi_Arabian_Grand_Prix/2025-04-20_Race/',
  'qa-2004': '2025/2025-11-30_Qatar_Grand_Prix/2025-11-30_Race/',
  'ae-2009': '2025/2025-12-07_Abu_Dhabi_Grand_Prix/2025-12-07_Race/',
};
const HEAD_BYTES = 3000000;

export async function raceHead(id) {
  const url = 'https://livetiming.formula1.com/static/' + RACES[id] + 'Position.z.jsonStream';
  const file = resolve(CACHE, 'f1livetiming', id + '-race-head3MB-Position.z.jsonStream');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const r = await fetch(url, { headers: { Range: 'bytes=0-' + (HEAD_BYTES - 1), 'User-Agent': 'F1Drive track audit (devtests; cached one-off read)' } });
    if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status + ' ' + url);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    await new Promise((res) => setTimeout(res, 3000));
  }
  return { txt: readFileSync(file, 'utf8'), url, file };
}

// F = fitFrame result (timing frame -> OSM metres); toS(x, y) -> {s, d} on the OSM loop (s from the game start).
// Returns the grid just before the start: per car its slot (median position over the last stationary spell on track).
export function gridFromHead(txt, F, toS, total) {
  const { cars } = decodePositions(txt);
  // the start = the first moment after which (nearly) every car moves fast; look for the last spell where >= 15 cars
  // have been stationary for >= 5 s, all on the track
  const spells = {};
  for (const [num, rr] of Object.entries(cars)) {
    const out = []; let a = 0;
    for (let k = 1; k <= rr.length; k++) {
      const moved = k === rr.length || Math.hypot(rr[k][1] - rr[a][1], rr[k][2] - rr[a][2]) > 0.6;
      if (moved) { if (rr[k - 1][0] - rr[a][0] >= 5000) out.push({ t0: rr[a][0], t1: rr[k - 1][0], X: rr[a][1], Y: rr[a][2], Z: rr[a][3] }); a = k; }
    }
    spells[num] = out;
  }
  // candidate start time: the latest t1 shared (within 3 s) by the most cars, whose positions are on the track
  const ends = [];
  for (const [num, sp] of Object.entries(spells)) for (const s of sp) { const p = F.tf(s.X, s.Y), q = toS(p[0], p[1]); if (q.d < 12) ends.push({ num, t1: s.t1, t0: s.t0, p, q, Z: s.Z }); }
  ends.sort((a, b) => a.t1 - b.t1);
  let best = null;
  for (const e of ends) {
    const grp = ends.filter((o) => Math.abs(o.t1 - e.t1) < 3000);
    const nums = new Set(grp.map((o) => o.num));
    if (nums.size >= 15 && (!best || nums.size > best.n || (nums.size === best.n && e.t1 > best.t1))) best = { n: nums.size, t1: e.t1, grp };
  }
  if (!best) return null;
  const slots = [...new Map(best.grp.map((o) => [o.num, o])).values()];
  // order by distance before the line: the grid lies behind s = 0 (or just after it); unwrap around the line
  const unwrap = (s) => (s > total / 2 ? s - total : s);
  slots.sort((a, b) => unwrap(b.q.s) - unwrap(a.q.s));
  return {
    startUtc: new Date(best.t1).toISOString(), cars: slots.length,
    slots: slots.map((o, k) => ({ pos: k + 1, car: o.num, sFromGameStartM: Math.round(unwrap(o.q.s) * 10) / 10, lateralM: Math.round(o.q.side * 10) / 10 })),
  };
}
