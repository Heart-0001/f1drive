// node devtests/track-audit/eu-south-central/game.js
// Game-side facts for it-1922 it-1953 it-1914 at-1969 hu-1986: dataset centreline (lat/lon through geo), elev, and the
// built track (js/track.js samples: smoothed height, grade, bank; track.pit). Writes out/game-<id>.json.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
const IDS = (process.argv[2] || 'it-1922,it-1953,it-1914,at-1969,hu-1986').split(',');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

for (const id of IDS) {
  const td = window.F1_TRACKS.find((t) => t.id === id), g = td.geo;
  const ll = (x, z) => [g.lat0 + z / g.kz, g.lon0 + x / g.kx];
  const P = td.points, n = P.length, cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]));
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length;
  const samples = S.map((s) => {
    const [lat, lon] = ll(s.x, s.z);
    return { s: +s.s.toFixed(1), lat: +lat.toFixed(6), lon: +lon.toFixed(6), y: +s.y.toFixed(2), grade: +s.grade.toFixed(4),
      bankDeg: +(s.bank * 180 / Math.PI).toFixed(2), halfW: +s.halfW.toFixed(2) };
  });
  const pit = tr.pit ? {
    side: tr.pit.side, limitKmh: tr.pit.limitKmh, from: tr.pit.from, to: tr.pit.to, entry: tr.pit.entry, exit: tr.pit.exit,
    length: tr.pit.length,
    fromS: S[tr.pit.from].s, toS: S[tr.pit.to].s, entryS: S[tr.pit.entry].s, exitS: S[tr.pit.exit].s,
    fromLL: ll(S[tr.pit.from].x, S[tr.pit.from].z), toLL: ll(S[tr.pit.to].x, S[tr.pit.to].z),
    entryLL: ll(S[tr.pit.entry].x, S[tr.pit.entry].z), exitLL: ll(S[tr.pit.exit].x, S[tr.pit.exit].z),
  } : null;
  const out = {
    id, name: td.name, lengthKm: td.lengthKm, pointsCount: n, polyLength: cum[n], trackLength: tr.length, N,
    bankOverrides: td.bankOverrides || null, pitSide: td.pitSide || null, pitLimitKmh: td.pitLimitKmh || null,
    start: ll(P[0][0], P[0][1]),
    points: P.map((p, i) => { const [lat, lon] = ll(p[0], p[1]); return [+lat.toFixed(7), +lon.toFixed(7), +cum[i].toFixed(1), td.elev[i]]; }),
    samples, pit,
  };
  fs.writeFileSync(path.join(OUT, `game-${id}.json`), JSON.stringify(out));
  const ys = S.map((s) => s.y), maxB = Math.max(...S.map((s) => Math.abs(s.bank))) * 180 / Math.PI;
  console.log(`${id} ${td.name}: lengthKm ${td.lengthKm}, poly ${cum[n].toFixed(0)} m, built ${tr.length.toFixed(0)} m, N ${N}, ` +
    `elev ${Math.min(...td.elev)}..${Math.max(...td.elev)} m, built y range ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)} m, ` +
    `max |bank| ${maxB.toFixed(2)} deg, start ${out.start.map((v) => v.toFixed(6)).join(',')}, pit ${pit ? `side ${pit.side} limit ${pit.limitKmh} entry s ${pit.entryS.toFixed(0)} exit s ${pit.exitS.toFixed(0)} len ${pit.length.toFixed(0)}` : 'none'}`);
}
