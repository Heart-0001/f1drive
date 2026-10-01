// node devtests/net-gp/fuzz-session.js [runs] [seed]
// Random walks over net/session.js (the Grand Prix rules): nothing may throw, every snapshot must be plain,
// finite and self-consistent, and a session must never be stuck (from any state: everybody leaving -> free).
'use strict';
const assert = require('assert');
const path = require('path');
const { createSession } = require(path.resolve(__dirname, '..', '..', 'net', 'session.js'));

const RUNS = Number(process.argv[2]) || 3000, SEED = Number(process.argv[3]) || 12345;
let seed = SEED >>> 0;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const pick = a => a[Math.floor(rnd() * a.length)];
const NASTY = [NaN, Infinity, -Infinity, undefined, null, '', 'x', '5', {}, [], [1], true, false, -1, 0, 0.5, 1e308, -1e308, 1e-9, 200, 5000, function () {}];
const PHASES = ['free', 'quali', 'grid', 'race', 'results'];
const LEN = 300, MIN = LEN / (330 / 3.6);

function finite(o, where) {
  if (typeof o === 'number') assert(Number.isFinite(o), 'non-finite number at ' + where);
  else if (Array.isArray(o)) o.forEach((v, i) => finite(v, where + '[' + i + ']'));
  else if (o && typeof o === 'object') Object.keys(o).forEach(k => finite(o[k], where + '.' + k));
  else assert(o === null || typeof o === 'string' || typeof o === 'boolean', 'odd value at ' + where + ': ' + typeof o);
}

function check(s, present, lastSid, trail) {
  const g = s.snapshot();
  try {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), g, 'snapshot survives JSON');
    finite(g, 'snapshot');
    assert(PHASES.includes(g.phase) && g.phase === s.phase);
    assert(Number.isInteger(g.sid) && g.sid >= lastSid && g.sid === s.sid);
    assert(Number.isInteger(g.q) && g.q >= 1 && g.q <= 20 && Number.isInteger(g.r) && g.r >= 1 && g.r <= 99);
    assert(g.year === null || (Number.isInteger(g.year) && g.year >= 2010 && g.year <= 2100), 'year ' + g.year);
    assert(Number.isInteger(g.wear) && g.wear >= 1 && g.wear <= 5, 'wear ' + g.wear);
    const here = g.players.filter(p => !p.left);
    assert.deepStrictEqual(here.map(p => p.id).sort(), Array.from(present).sort(), 'present players = the ones we added');
    assert(new Set(here.map(p => p.id)).size === here.length, 'a present id appears once');
    const drivers = g.players.filter(p => !p.spec), active = drivers.filter(p => !p.left);
    assert.deepStrictEqual(g.order.slice().sort(), drivers.map(p => p.id).sort(), 'order = the classified players');
    assert(new Set(g.grid).size === g.grid.length);
    for (const p of g.players) {
      assert(p.qLaps >= 0 && p.qLaps <= 20 && p.rLaps >= 0 && p.rLaps <= 99 && p.down >= 0 && p.rTime >= 0);
      assert(p.gap === null || p.gap >= 0);
      if (p.dnf) assert(p.left && !p.fin && !p.spec, 'DNF = a driver who left without finishing');
      if (p.fin) assert(p.rLaps >= 1 && !p.spec);
      if (p.spec) assert(!p.left && p.rLaps === 0, 'spectators leave without a trace');
      if (p.qDone) assert(p.qLaps === g.q);
      if (p.qBest !== null) assert(p.qBest >= MIN - 0.001 && p.qLaps >= 1);
      if (p.rBest !== null) assert(p.rBest >= MIN - 0.001 && p.rLaps >= 1);
    }
    if (g.phase === 'free') {
      assert(g.players.every(p => !p.left && !p.spec) && g.grid.length === 0 && g.goAt === 0 && g.endsAt === 0);
    } else {
      assert(here.length > 0, 'a session with nobody in the room');
      assert(g.len >= 200);
    }
    if (g.phase === 'quali') {
      assert(g.players.every(p => !p.left && !p.spec), 'qualifying has no leavers / spectators');
      assert(active.some(p => !p.qDone), 'everybody done but still qualifying');
    }
    if (g.phase === 'grid' || g.phase === 'race') {
      assert(active.length > 0, g.phase + ' without a driver');
      assert(g.lightsAt > 0 && g.goAt - g.lightsAt >= 5500 && g.goAt - g.lightsAt <= 7000);
    }
    if (g.phase === 'grid') {
      assert.deepStrictEqual(g.grid.slice().sort(), active.map(p => p.id).sort(), 'the grid = the drivers present');
      assert(g.players.every(p => !p.left && p.rLaps === 0 && !p.fin));
    }
    if (g.phase === 'race') {
      assert(active.some(p => !p.fin), 'everybody finished but still racing');
      assert((g.winnerAt > 0) === drivers.some(p => p.fin) && (g.winnerAt > 0) === (g.endsAt > 0));
      if (g.endsAt) assert.strictEqual(g.endsAt, g.winnerAt + 90000);
    }
    if (g.phase === 'race' || g.phase === 'results') {
      // classification: no DNF ahead of a non-DNF, more laps never behind fewer among finishers
      let seenDnf = false, lastFinLaps = Infinity;
      const by = {}; drivers.forEach(p => { by[p.id] = p; });
      for (const id of g.order) {
        const p = by[id];
        if (p.dnf) seenDnf = true; else assert(!seenDnf, 'a classified car behind a DNF');
        if (p.fin) { assert(p.rLaps <= lastFinLaps, 'a finisher with more laps behind one with fewer'); lastFinLaps = p.rLaps; }
      }
    }
    return g;
  } catch (e) {
    console.log('FAILED after: ' + trail.slice(-25).join(' | '));
    console.log(JSON.stringify(g));
    throw e;
  }
}

let ops = 0;
const seen = {};
for (let run = 0; run < RUNS; run++) {
  const s = createSession({ random: pick([rnd, () => 0, () => 1, () => NaN, undefined]) });
  let now = 1000000 + Math.floor(rnd() * 1e9), nextId = 1, lastSid = 0;
  const present = new Set(), trail = [];
  const steps = 20 + Math.floor(rnd() * 200);
  const anyId = () => (rnd() < 0.9 && present.size ? pick(Array.from(present)) : pick([0, 99, -1, 'x', null, undefined, 1.5]));
  for (let i = 0; i < steps; i++) {
    let r = rnd();
    let op;
    // keep the walk inside sessions most of the time: start one when idle, let time pass when one is on
    if (s.phase === 'free' && present.size && rnd() < 0.5) r = 0.22;
    else if (s.phase !== 'free' && rnd() < 0.25) r = 0.9;
    if (r < 0.10) { const id = rnd() < 0.85 ? nextId++ : anyId(); op = 'add ' + id; if (s.addPlayer(id, pick(['A', 'B', null, 5, 'x'.repeat(40)]), now)) present.add(id); }
    else if (r < 0.17) { const id = anyId(); op = 'remove ' + id; if (s.removePlayer(id, now)) present.delete(id); }
    else if (r < 0.20) { op = 'rename'; s.rename(anyId(), pick(['N', null, 7, undefined])); }
    else if (r < 0.27) {
      const cfg = rnd() < 0.85 ? { q: pick([1, 1, 2, 2, 3, 20, 99, -1, 'x', NaN]), r: pick([1, 1, 2, 2, 3, 5, 99, 1e9, null]), len: pick([LEN, LEN, LEN, LEN, LEN, 199, NaN, '300', 1e6]),
        year: rnd() < 0.7 ? pick([2010, 2014, 2024, 2026, 2100]) : pick(NASTY.concat([2009, 2101, 2024.5])), wear: rnd() < 0.7 ? pick([1, 2, 3, 4, 5]) : pick(NASTY) } : pick(NASTY);
      op = 'start ' + JSON.stringify(cfg);
      const before = s.snapshot();
      if (s.start(cfg, now)) {
        const g = s.snapshot(), y = cfg.year;
        assert.strictEqual(g.year, typeof y === 'number' && Number.isInteger(y) && y >= 2010 && y <= 2100 ? y : null, op);
      } else assert.deepStrictEqual([s.snapshot().year, s.snapshot().wear], [before.year, before.wear], 'a refused start keeps year / wear');
    }
    else if (r < 0.31) { op = 'skip'; s.skip(now); }
    else if (r < 0.34) { op = 'end'; s.end(); }
    else if (r < 0.38) {
      op = 'again';
      const before = s.snapshot();
      if (s.again(now)) assert.deepStrictEqual([s.snapshot().year, s.snapshot().wear], [before.year, before.wear], 'again keeps year / wear');
    }
    else if (r < 0.62) {
      const id = anyId(), time = rnd() < 0.85 ? MIN + rnd() * 3 : pick(NASTY);
      // the server's proof of driving (sometimes none, as in the single-player game; sometimes garbage)
      const num = (good, p) => (rnd() < (p || 0.85) ? good : pick(NASTY));
      const proof = rnd() < 0.3 ? undefined : rnd() < 0.9 ? { dist: num(rnd() * LEN * 1.4), live: num(rnd() * 8), at: num(now - rnd() * 6000 + 1000) } : pick(NASTY);
      op = 'lap ' + id + ' ' + String(time) + ' ' + JSON.stringify(proof);
      const why = s.lap(id, time, now, proof);
      assert(['', 'not-racing', 'no-session', 'done', 'bad', 'too-fast', 'too-soon', 'inconsistent', 'not-driven', 'no-data'].includes(why), 'reason ' + why);
      // (the session keeps lap times to the millisecond; a session may run on a track longer than LEN)
      if (why === '' && proof) assert(proof.dist >= LEN * 0.85 && proof.live >= Math.round(time * 1000) / 1000 * 0.75, 'a lap without the driving to back it: ' + op);
      seen[why] = (seen[why] || 0) + 1;
    }
    else if (r < 0.72) {
      op = 'progress';
      s.progress(anyId(), rnd() < 0.8 ? rnd() * 5 - 1 : pick(NASTY), rnd() < 0.4 ? undefined : rnd() < 0.8 ? rnd() * LEN : pick(NASTY));
    }
    else if (r < 0.76) { op = 'solid'; assert(typeof s.solid(anyId(), anyId(), rnd() < 0.9 ? now : pick(NASTY)) === 'boolean'); }
    else { const dt = pick([0, 1, 50, 500, 1000, 3000, 3000, 4000, 4000, 7000, 12000, 95000]); now += dt; op = 'tick +' + dt; s.tick(now); }
    trail.push(op);
    ops++;
    const g = check(s, present, lastSid, trail);
    lastSid = g.sid;
    seen[g.phase] = (seen[g.phase] || 0) + 1;
  }
  // never stuck: time passes, everybody goes home -> free practice with nobody
  now += 200000; s.tick(now);
  Array.from(present).forEach(id => { s.removePlayer(id, now); present.delete(id); });
  const g = check(s, present, lastSid, trail.concat(['everybody leaves']));
  assert.deepStrictEqual([g.phase, g.players.length], ['free', 0]);
}
console.log(RUNS + ' random sessions, ' + ops + ' operations, seed ' + SEED + ': all invariants held');
console.log('coverage: ' + Object.keys(seen).sort().map(k => (k || 'lap-accepted') + ' ' + seen[k]).join(', '));
