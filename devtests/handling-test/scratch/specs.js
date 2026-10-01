// the proposal with other cars than the reference: lower / higher mechanical grip and downforce (the season specs span
// about this range), Monaco / Singapore / Zandvoort / Monza / Madring, keys driver
const L = require('../lib.js'), { drive } = require('../driver.js');
const specs = { ref: {}, lowGrip: { latBase: 16, downforce: 0.0016 }, highGrip: { latBase: 24, downforce: 0.0029, latMax: 50 } };
for (const v of ['today', 'proposed']) {
  const F1 = L.load(L.variant(v));
  const rows = [];
  for (const [sn, sp] of Object.entries(specs)) {
    const spec = Object.assign({}, F1.REF_SPEC, sp);
    const cells = [];
    for (const id of ['mc-1929', 'sg-2008', 'nl-1948', 'it-1922', 'es-2026']) {
      const tr = L.track(F1, id), car = F1.createCar(spec, { tyres: false }), line = F1.buildRaceLine(tr, car.perf);
      const r = drive(F1, tr, { mode: 'keys', spec, line });
      cells.push(`${id} ${r.flying.toFixed(2)}${r.grass || r.hits ? ' g' + r.grass + ' h' + r.hits : ''}`);
    }
    rows.push(`${sn.padEnd(8)} ` + cells.join(' | '));
  }
  console.log(`=== ${v}\n  ` + rows.join('\n  '));
}
