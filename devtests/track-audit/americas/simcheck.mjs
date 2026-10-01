// check sim.mjs against the game: predicted profile from the build's own raw heights vs the game's built y
import { readFileSync } from 'node:fs';
import { predictGame } from './sim.mjs';
import { grades } from './geo.mjs';
for (const id of process.argv.slice(2)) {
  const a = JSON.parse(readFileSync(new URL('./out/audit-' + id + '.json', import.meta.url)));
  const rows = a.profile.rows, ds = a.profile.step;
  const pick = (c) => rows.map((r) => r[c]);
  const real = pick(3), game = pick(4), raw = pick(8);
  for (const [name, src] of [['buildRaw', raw], ['osmLidar', real]]) {
    if (src.some((v) => v === null)) { console.log(id, name, 'has gaps'); continue; }
    const p = predictGame(src, ds, 'dtm');
    const off = game.reduce((s, v) => s + v, 0) / game.length - p.reduce((s, v) => s + v, 0) / p.length;
    const rms = Math.sqrt(p.reduce((s, v, k) => s + (v + off - game[k]) ** 2, 0) / p.length);
    const g = grades(p, ds, 50), gg = grades(game, ds, 50);
    console.log(id, name, 'pred range', (Math.max(...p) - Math.min(...p)).toFixed(2), 'rms vs game', rms.toFixed(3), 'max climb50 pred', (Math.max(...g) * 100).toFixed(1), 'game', (Math.max(...gg) * 100).toFixed(1));
  }
}
