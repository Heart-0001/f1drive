// node devtests/track-audit/west/corners.mjs <id> [minRadius=400] : corners of the game centreline = runs where the
// radius is below minRadius (curvature smoothed over +-10 m), with direction, total angle, length, minimum radius.
import { loadGame, gameArrays, gauss, r } from './lib-audit.mjs';
const [id, minR = '400'] = process.argv.slice(2);
const g = loadGame(id), A = gameArrays(g);
const k = gauss(A.k, 10 / A.ds);
const out = []; let cur = null;
for (let i = 0; i < A.N; i++) {
  const on = Math.abs(k[i]) > 1 / +minR, sg = Math.sign(k[i]);
  if (on && cur && cur.sg === sg) { cur.to = i; cur.ang += k[i] * A.ds; cur.minR = Math.min(cur.minR, 1 / Math.abs(k[i])); }
  else { if (cur) out.push(cur); cur = on ? { from: i, to: i, sg, ang: k[i] * A.ds, minR: 1 / Math.abs(k[i]) } : null; }
}
if (cur) out.push(cur);
for (const c of out) {
  const len = (c.to - c.from + 1) * A.ds;
  if (Math.abs(c.ang) * 180 / Math.PI < 8) continue;
  const mid = Math.round((c.from + c.to) / 2);
  console.log(`s ${r(A.s[c.from], 0)}-${r(A.s[c.to], 0)} ${c.sg > 0 ? 'L' : 'R'} angle ${r(Math.abs(c.ang) * 180 / Math.PI, 0)} deg, len ${r(len, 0)} m, minR ${r(c.minR, 0)} m, bank(game) ${r(Math.max(...A.bank.slice(c.from, c.to + 1).map(Math.abs)), 1)} deg, at ${A.S[mid].lat},${A.S[mid].lon}`);
}
