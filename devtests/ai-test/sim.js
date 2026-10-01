// A whole Grand Prix of computer cars in node, with the REAL game modules: js/car.js (1/120 s), js/tyres.js,
// js/collide.js (every solid pair, F1.AI.createContacts), js/pit.js (one per car, box = its slot), js/laps.js (one
// counter per car, as main.js feeds it) and net/session.js (the rules: qualifying -> grid / lights -> race -> results,
// on a simulated clock). Optionally one extra car driven by a scripted "player" (devtests/gp-e2e/autopilot.js).
//
//   const sim = createRace({ track: 'it-1922', cars: [{skill, car: '<spec id>', name}], laps: 5, quali: 0 | Q,
//                            wear: 1..5, seed, grid: 'quali' | 'reverse' | 'order' | 'random', maxS })
//   sim.run() -> result (see summary())
'use strict';
const L = require('./lib'), F1 = L.F1;
const { createSession } = require('../../net/session.js');
const createLapCounter = require('../../js/laps.js');
const STEP = 1 / 120;

function createRace(o) {
  const t = L.track(L.IDS[o.track] || o.track), S = t.samples, N = S.length, ds = t.length / N;
  const line = L.line(t, null);
  const rnd = F1.AI.makeRandom(o.seed || 1);
  const session = createSession({ random: rnd });
  const wear = o.wear || 1, R = o.laps || 5, Q = o.quali || 0;
  const cars = o.cars.map((c, i) => {
    const spec = c.car ? F1.cars.get(c.car) || F1.cars.resolve(c.car) : F1.REF_SPEC;
    const car = F1.createCar(spec, { random: F1.AI.makeRandom((o.seed || 1) * 31 + i * 7 + 1) });
    const ai = F1.createAIDriver({ track: t, raceLine: line, car, skill: c.skill, seed: (o.seed || 1) * 1000 + i * 17 + 3, id: i + 1, slot: i, name: c.name });
    const pit = F1.createPit({ random: F1.AI.makeRandom((o.seed || 1) * 77 + i) });
    const view = F1.AI.createView(i + 1);
    return { i, id: i + 1, name: c.name || ('AI ' + (i + 1)), skill: F1.AI.skillOf(c.skill), spec, car, ai, pit, view, lap: null,
      ctx: Object.assign(F1.AI.createContext(), { pit: pit.state, wear }),
      laps: [], qLaps: [], pits: [], contacts: 0, hits: 0, maxHit: 0, frozenT: 0, resetAt: -1e9, grid: -1, finish: -1,
      compounds: [], thinkNs: 0, thinkN: 0, thinkMax: 0, carNs: 0, events: [] };
  });
  cars.forEach(c => session.addPlayer(c.id, c.name, 0));
  const contacts = F1.AI.createContacts();
  const entries = cars.map(c => ({ state: c.car.state, car: c.car, solid: true }));
  const others = cars.map(c => c.view);
  let time = 0, now = 0, phase = 'free';
  const res = { contactEvents: 0, contactHeavy: 0, contactMax: 0, contactSum: 0, overtakes: 0, passes: [], pairT: new Map(),
    lapsBySkill: {}, phaseLog: [] };

  function paved(st) { return !!(t.pit && t.pit.paved && t.pit.paved(st.sampleIndex, st.d)); }
  function placeAll(order) {
    order.forEach((id, k) => {
      const c = cars[id - 1];
      const idx = F1.AI.placeOnGrid(c.car, t, k);
      c.car.setBattery(1);
      c.pit.reset();
      c.lap = createLapCounter(N, idx); c.lap.reset(idx);
      c.ai.reset();
      c.grid = k;
    });
  }

  function onPhase(p, prev) {
    res.phaseLog.push([Math.round(time * 10) / 10, p]);
    const snap = session.snapshot();
    if (p === 'quali') {
      // qualifying: from the room slot, ghosts; tyres fresh mediums at x1
      placeAll(cars.map(c => c.id));
      cars.forEach(c => { c.car.tyres.fit('M'); c.car.tyres.setWearRate(1); });
    } else if (p === 'grid') {
      let order = snap.grid.slice();
      if (!Q) {
        if (o.grid === 'reverse') order = cars.slice().sort((a, b) => a.skill - b.skill || a.i - b.i).map(c => c.id);
        else if (o.grid === 'random') { order = cars.map(c => c.id); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } }
        else order = cars.map(c => c.id);
      }
      gridOrder = order;
      placeAll(order);
      cars.forEach(c => { const cmp = c.ai.startCompound(R, wear); c.car.tyres.fit(cmp); c.car.tyres.setWearRate(wear); c.compounds = [cmp]; });
    }
  }
  let gridOrder = null;

  // the session: qualifying (Q > 0) or straight to the grid with a given order
  session.start({ q: Q || 1, r: R, len: t.length, year: 2025, wear }, 0);
  if (!Q) session.skip(0);
  phase = session.phase; onPhase(phase, 'free');
  if (!Q && gridOrder) {                     // the session's grid is the join order: take ours
    // (the order only matters for placement and the classification's tie-breaks)
  }

  let lastOrder = null, orderT = 0, winnerT = null;
  const maxS = o.maxS || (Q * 140 + R * 150 + 200);
  function step() {
    time += STEP; now = Math.round(time * 1000);
    if (session.tick(now)) {}
    const snap = session.phase !== phase ? session.snapshot() : null;
    if (session.phase !== phase) { const prev = phase; phase = session.phase; onPhase(phase, prev); }
    const sp = session.snapshot();
    const locked = phase === 'grid' && now < sp.goAt;
    const go = (phase === 'grid' || phase === 'race') && now >= sp.goAt;
    // the views of every car (once per step), ghosts on the pit asphalt
    for (const c of cars) {
      const st = c.car.state, v = c.view;
      v.x = st.x; v.z = st.z; v.heading = st.heading; v.speed = st.speed; v.sampleIndex = st.sampleIndex; v.d = st.d;
      v.ghost = phase === 'quali' || paved(st);
      v.prog = c.lap ? c.lap.progress(st.sampleIndex) : 0;
      v.pace = c.ai.pace;
    }
    const pmap = {};
    for (const p of sp.players) pmap[p.id] = p;
    for (const c of cars) {
      const st = c.car.state, p = pmap[c.id], ctx = c.ctx;
      ctx.phase = phase; ctx.locked = locked;
      ctx.lap = phase === 'quali' ? p.qLaps : p.rLaps; ctx.laps = phase === 'quali' ? sp.q : sp.r;
      ctx.done = phase === 'quali' ? p.qDone : (p.fin || p.dnf); ctx.prog = c.view.prog;
      // the lap counter is armed at lights out (main.js 'go')
      if (go && !c.armed && phase !== 'quali') { c.lap.arm(st.sampleIndex); c.lap.time = (now - sp.goAt) / 1000; c.armed = true; }
      if (phase === 'quali') c.armed = false;
      const h0 = process.hrtime.bigint();
      const inp = c.ai.think(STEP, others, ctx);
      const dn = Number(process.hrtime.bigint() - h0);
      c.thinkNs += dn; c.thinkN++; if (dn > c.thinkMax) c.thinkMax = dn;
      if (locked) { st.speed = 0; continue; }
      if (c.pit.state.service) {
        st.speed = 0; st.hit = 0;
        c.frozenT += STEP;
        stepPit(c);
        c.lap.update(st.sampleIndex, 0, STEP);
        continue;
      }
      if (inp.reset && time - c.resetAt > 1) {
        c.resetAt = time;
        const idx = F1.AI.resetCar(c.car, t, c.lap && c.lap.jumping ? c.lap.prevIdx : st.sampleIndex, others, c.id);
        c.lap.sync(idx);
        c.events.push([Math.round(time), 'R ' + (c.ai.state.lastReset || '')]);
        continue;
      }
      const h1 = process.hrtime.bigint();
      c.car.update(STEP, inp, t);
      c.carNs += Number(process.hrtime.bigint() - h1);
    }
    // car against car (snapshot of all, each resolves itself): solid = not qualifying, not before the lights, not on the pit asphalt
    const solidPhase = phase !== 'quali' && !(phase === 'grid' && now < sp.lightsAt);
    for (let k = 0; k < cars.length; k++) entries[k].solid = solidPhase && !paved(cars[k].car.state) && !cars[k].pit.state.service;
    contacts(entries, STEP, onContact);
    for (const c of cars) {
      if (locked || c.pit.state.service) continue;
      stepPit(c);
      const st = c.car.state;
      if (c.lap.update(st.sampleIndex, st.speed, STEP) === 2) {
        const why = session.lap(c.id, c.lap.last, now);
        if (!why) {
          if (phase === 'quali') c.qLaps.push(c.lap.last);
          else if (phase === 'race') c.laps.push({ t: c.lap.last, pit: c.pitThisLap || false, n: c.laps.length + 1 });
        } else c.events.push([Math.round(time), 'lap refused ' + why]);
        c.pitThisLap = false;
      }
    }
    // on-track passes: the order by race distance, every 0.25 s
    if (phase === 'race' && time - orderT >= 0.25) {
      orderT = time;
      const ord = cars.filter(c => !pmap[c.id].fin).map(c => ({ c, p: c.view.prog }));
      if (lastOrder) {
        for (let a = 0; a < ord.length; a++) for (let b = 0; b < ord.length; b++) {
          const A = ord[a], B = ord[b];
          const was = lastOrder.get(A.c.id), wasB = lastOrder.get(B.c.id);
          if (was === undefined || wasB === undefined) continue;
          if (was < wasB && A.p > B.p && Math.abs(A.p - B.p) < 0.02 && A.p > 0.05) {
            // A passed B on the track: not in the pit lane, nobody reset just now
            const pitA = paved(A.c.car.state) || A.c.pit.state.inLane, pitB = paved(B.c.car.state) || B.c.pit.state.inLane;
            if (!pitA && !pitB && time - A.c.resetAt > 5 && time - B.c.resetAt > 5 && !B.c.pit.state.visit && !A.c.pit.state.visit) {
              res.overtakes++;
              if (res.passes.length < 400) res.passes.push([Math.round(time * 10) / 10, A.c.name, B.c.name, A.c.skill, B.c.skill]);
            }
          }
        }
      }
      lastOrder = new Map(ord.map(x => [x.c.id, x.p]));
    }
    if (phase === 'results' && winnerT === null) winnerT = time;
  }
  function stepPit(c) {
    const ev = c.pit.update(STEP, c.car.state, t, { slot: c.i, limiter: true });
    if (!ev) return;
    if (ev === 'speeding') c.events.push([Math.round(time), 'speeding']);
    if (ev === 'serviceStart') c.pitStart = time;
    const fit = c.ai.onPit(ev);
    if (fit) {
      c.car.tyres.fit(fit);
      c.pits.push({ lap: (c.laps.length + 1), compound: fit, held: Math.round((time - (c.pitStart || time)) * 100) / 100, wear: null, phase });
      c.compounds.push(fit);
      c.pitThisLap = true;
    }
    if (ev === 'penaltyStart' || ev === 'penaltyDone' || ev === 'serviceAbort') c.events.push([Math.round(time), ev]);
  }
  const pairOn = new Map();
  function onContact(i, j, dv, hit) {
    if (i > j) return;                                   // count every pair once (from the lower index)
    const key = i * 64 + j, last = pairOn.get(key);
    const h = Math.min(1, dv / 18);                      // js/collide.js: hit = closing / 30, dv = 0.6 * closing
    if (last === undefined || time - last > 1.0) {
      res.contactEvents++; res.contactSum += h;
      if (h > res.contactMax) res.contactMax = h;
      if (h > 0.25) res.contactHeavy++;
      cars[i].contacts++; cars[j].contacts++;
      if (res.contactList === undefined) res.contactList = [];
      if (res.contactList.length < 200) res.contactList.push([Math.round(time * 10) / 10, cars[i].name, cars[j].name, Math.round(h * 100) / 100, phase,
        cars[i].ai.state.mode + '/' + cars[j].ai.state.mode]);
    }
    pairOn.set(key, time);
  }

  function run() {
    const t0 = Date.now();
    while (time < maxS && session.phase !== 'results') step();
    res.simS = time; res.wallMs = Date.now() - t0; res.finishedPhase = session.phase;
    return summary();
  }

  function summary() {
    const sp = session.snapshot();
    const order = sp.order;
    order.forEach((id, k) => { cars[id - 1].finish = k + 1; });
    const rows = cars.map(c => {
      const p = sp.players.find(x => x.id === c.id);
      const clean = c.laps.filter(l => l.n > 1 && !l.pit).map(l => l.t);
      const s = c.ai.stats;
      return { name: c.name, id: c.id, car: c.spec.id, skill: c.skill, grid: c.grid + 1, pos: c.finish, laps: p.rLaps, fin: p.fin, dnf: p.dnf,
        best: p.rBest, time: p.rTime, qBest: p.qBest, cleanLaps: clean, pits: c.pits, compounds: c.compounds,
        mistakes: s.mistakes, big: s.bigMistakes, offs: s.offs, wall: s.wallHits, resets: s.resets, reverses: s.reverses, stuck: s.stuck,
        passTries: s.passTries, passes: s.passes, defends: s.defends, yields: s.yields, rejoin: s.rejoinWaits,
        contacts: c.contacts, events: c.events, log: c.ai.log.slice().sort((a, b) => a[0] - b[0]), thinkUs: c.thinkNs / Math.max(1, c.thinkN) / 1000, thinkMaxUs: c.thinkMax / 1000,
        carUs: c.carNs / Math.max(1, c.thinkN) / 1000 };
    });
    return { track: t.id, R, Q, wear, cars: rows, res, session: sp };
  }
  return { run, step, cars, session, track: t, get time() { return time; } };
}

// Spearman rank correlation
function spearman(a, b) {
  const rank = x => { const idx = x.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(x.length); idx.forEach((p, k) => { r[p[1]] = k + 1; }); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - 6 * d2 / (n * (n * n - 1));
}

module.exports = { createRace, spearman, STEP };
