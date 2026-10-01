// The critic's race harness (independent of sim.js): computer cars (js/ai.js) mixed with ACTORS that are not computer
// drivers - a parked / crashed car, a car driving the wrong way, an erratic "human" (a computer driver whose inputs are
// disturbed: steering noise, brake tests, lifts, weaving; optionally blind to everybody), a plain "human" (a computer
// driver whose view says pace NaN, as a human's does). The REAL js/car.js (1/120 s), js/tyres.js, js/collide.js
// (F1.AI.createContacts over every solid car), js/pit.js and js/laps.js; the start on the painted grid with a lock and
// lights out, or a rolling field.
//
//   const sc = createScenario({ track, cars: [spec...], laps, wear, seed, start: 'grid' | 'spread', lockS, maxS,
//                               forcePit: {lap, compound} })
//     car spec: { kind: 'ai' | 'parked' | 'wrong' | 'erratic' | 'human', skill, car (spec id), name, seed,
//                 at (sample), d (lateral m, default: the racing line), yaw (rad, parked), v (m/s, wrong-way /
//                 rolling start), blind (erratic: sees nobody), noise / brakeEvery / liftEvery / weave (erratic) }
//   sc.run() -> report (contacts with the striker attributed, pile-ups, per car: laps, best, resets, stuck,
//               offs, wall hits, pit stops / speeding, steering reversals per second on the straights, pedal flips)
'use strict';
const L = require('./lib'), F1 = L.F1;
const createLapCounter = require('../../js/laps.js');
const STEP = 1 / 120;

function createScenario(o) {
  const t = L.track(L.IDS[o.track] || o.track), S = t.samples, N = S.length, ds = t.length / N;
  const line = L.line(t, null), P = line.points;
  const seed = o.seed || 1, R = o.laps || 3, wear = o.wear || 1, lockS = o.lockS == null ? 2 : o.lockS;
  const rndG = F1.AI.makeRandom(seed * 101 + 7);
  let time = 0, phase = o.start === 'grid' ? 'grid' : 'race', goAt = o.start === 'grid' ? lockS : 0;
  let leaderDone = false;

  const cars = o.cars.map((c, i) => {
    const kind = c.kind || 'ai';
    const spec = c.car ? (F1.cars.get(c.car) || F1.cars.resolve(c.car)) : F1.REF_SPEC;
    const car = F1.createCar(spec, { random: F1.AI.makeRandom(seed * 31 + i * 7 + 1) });
    car.tyres.fit(c.compound || 'M'); car.tyres.setWearRate(wear);
    const id = i + 1;
    const x = { i, id, kind, name: c.name || (kind + id), skill: F1.AI.skillOf(c.skill == null ? 'pro' : c.skill), spec, car, c,
      view: F1.AI.createView(id), lap: null, ai: null, pit: null, ctx: null,
      laps: [], fin: false, finT: 0, resets: 0, stuckEv: 0, lastProgT: 0, lastPos: 0, contacts: 0, struck: 0, wallHits: 0,
      hitOn: false, offs: 0, grassOn: false, pits: [], speeding: 0, penalties: 0, steerRev: 0, straightT: 0, lastSteerD: 0, lastSteer: 0,
      pedalFlips: 0, lastPedal: 0, maxStuck: 0, maxStuckAt: -1, inp: null, sx: 0, sz: 0, rng: F1.AI.makeRandom(seed * 977 + i * 13),
      eNoise: 0, eBrakeUntil: -1, eLiftUntil: -1, eNextBrake: 0, eNextLift: 0, wrongPos: 0, laneMax: 0, pitStops: 0, boxOk: 0 };
    if (kind === 'ai' || kind === 'erratic' || kind === 'human') {
      x.ai = F1.createAIDriver({ track: t, raceLine: line, car, skill: x.skill, seed: c.seed != null ? c.seed : seed * 1000 + i * 17 + 3, id, slot: c.slot != null ? c.slot : i, name: x.name });
      x.pit = F1.createPit({ random: F1.AI.makeRandom(seed * 77 + i) });
      x.ctx = Object.assign(F1.AI.createContext(), { pit: kind === 'ai' ? x.pit.state : null, wear, laps: R, phase });
    }
    return x;
  });
  const views = cars.map(c => c.view);
  const blindViews = [];
  const entries = cars.map(c => ({ state: c.car.state, car: c.car, solid: true }));
  const resolveAll = F1.AI.createContacts();

  function place(c, k) {
    const st = c.car.state;
    if (c.kind === 'parked') {
      const at = ((c.c.at % N) + N) % N, d = c.c.d != null ? c.c.d : P[at].d;
      c.car.reset(t, at); const s = S[at];
      st.x = s.x + s.nx * d; st.z = s.z + s.nz * d; st.heading = Math.atan2(s.tx, s.tz) + (c.c.yaw || 0);
      c.car.update(1e-4, null, t); st.speed = 0;
    } else if (c.kind === 'wrong') {
      c.wrongPos = ((c.c.at % N) + N) % N; setWrong(c);
    } else if (o.start === 'grid') {
      F1.AI.placeOnGrid(c.car, t, k);
    } else {
      const at = ((c.c.at % N) + N) % N, d = c.c.d != null ? c.c.d : P[at].d;
      c.car.reset(t, at); const s = S[at];
      st.x = s.x + s.nx * d; st.z = s.z + s.nz * d; st.heading = Math.atan2(P[(at + 2) % N].x - P[at].x, P[(at + 2) % N].z - P[at].z);
      c.car.update(1e-4, null, t); st.speed = c.c.v || 0;
    }
    c.car.setBattery(1);
    c.lap = createLapCounter(N, st.sampleIndex); c.lap.reset(st.sampleIndex);
    if (o.start !== 'grid') { c.lap.arm(st.sampleIndex); c.lap.time = 0; }
    if (c.ai) c.ai.reset();
    if (c.pit) c.pit.reset();
    if (c.ai && c.kind === 'ai' && o.start === 'grid') { const cmp = c.c.compound || c.ai.startCompound(R, wear); c.car.tyres.fit(cmp); }
    c.lastProgT = 0; c.lastPos = -1e9;
  }
  // the wrong-way car: along the racing line (+ d) against the direction of the lap at v m/s
  function setWrong(c) {
    const st = c.car.state, f = c.wrongPos, k = Math.floor(f), a = f - k, p = P[k], q = P[(k + 1) % N];
    const s0 = S[k], s1 = S[(k + 1) % N], d = c.c.d != null ? c.c.d : null;
    let px = p.x + (q.x - p.x) * a, pz = p.z + (q.z - p.z) * a;
    if (d !== null) { const lx = s0.x + (s1.x - s0.x) * a, lz = s0.z + (s1.z - s0.z) * a; px = lx + s0.nx * d; pz = lz + s0.nz * d; }
    st.x = px; st.z = pz; st.heading = Math.atan2(p.x - q.x, p.z - q.z); st.speed = c.c.v || 15;
    st.sampleIndex = k; st.d = (px - s0.x) * s0.nx + (pz - s0.z) * s0.nz; st.y = s0.y || 0;
  }

  cars.forEach((c, k) => place(c, o.gridOrder ? o.gridOrder.indexOf(c.id) : k));

  // ---- report state
  const rep = { contacts: [], pileups: 0, simS: 0, finished: false };
  const pairOn = new Map();
  function along(a, b) {          // b's along-track position relative to a (m, + = b ahead)
    const sa = a.car.state, sb = b.car.state, ia = sa.sampleIndex | 0, ib = sb.sampleIndex | 0;
    let m = ib - ia; if (m > N / 2) m -= N; if (m < -N / 2) m += N;
    const A = S[ia], B = S[ib];
    return m * ds + (sb.x - B.x) * B.tx + (sb.z - B.z) * B.tz - ((sa.x - A.x) * A.tx + (sa.z - A.z) * A.tz);
  }
  function vAlong(c) { const st = c.car.state, s = S[st.sampleIndex | 0]; return st.speed * (Math.sin(st.heading) * s.tx + Math.cos(st.heading) * s.tz); }
  function onContact(i, j, dv) {
    if (i > j) return;
    const key = i * 64 + j, last = pairOn.get(key);
    pairOn.set(key, time);
    if (last !== undefined && time - last < 1.0) return;
    const A = cars[i], B = cars[j], g = along(A, B), va = vAlong(A), vb = vAlong(B);
    const h = Math.min(1, dv / 18);
    // the striker: the car behind when one is clearly behind (more than half a car), closing on the other
    let striker = null, kindC = 'side';
    if (g > 2.7) { kindC = 'rear'; striker = A; }           // B ahead: A ran into it
    else if (g < -2.7) { kindC = 'rear'; striker = B; }
    if (A.kind === 'wrong' || B.kind === 'wrong') kindC = 'head-on';
    const victim = striker === A ? B : (striker === B ? A : null);
    rep.contacts.push({ t: Math.round(time * 100) / 100, a: A.name, b: B.name, ka: A.kind, kb: B.kind, h: Math.round(h * 100) / 100, kind: kindC,
      striker: striker ? striker.name : '', strikerKind: striker ? striker.kind : '', victimKind: victim ? victim.kind : '',
      gap: Math.round(g * 10) / 10, closing: Math.round(Math.abs(va - vb) * 10) / 10, idx: A.car.state.sampleIndex,
      modes: (A.ai ? A.ai.state.mode + ':' + A.ai.state.cap : A.kind) + ' / ' + (B.ai ? B.ai.state.mode + ':' + B.ai.state.cap : B.kind),
      lap: A.lap ? A.lap.n : 0, x: A.car.state.x, z: A.car.state.z, ids: [A.id, B.id] });
    A.contacts++; B.contacts++;
    if (striker) striker.struck++;
  }

  function erraticInput(c, inp) {
    const r = c.rng, e = c.c, out = c.eOut || (c.eOut = { up: false, down: false, left: false, right: false, throttle: 0, brake: 0, steerAxis: 0, boost: false, limiter: false });
    out.throttle = inp.throttle; out.brake = inp.brake; out.steerAxis = inp.steerAxis; out.boost = inp.boost; out.limiter = inp.limiter;
    const sig = e.noise == null ? 0.12 : e.noise;
    c.eNoise += -c.eNoise * STEP / 0.5 + sig * Math.sqrt(2 * STEP / 0.5) * ((r() + r() + r() - 1.5) * 2);
    out.steerAxis = Math.max(-1, Math.min(1, out.steerAxis + c.eNoise + (e.weave ? e.weave * Math.sin(time * 1.3) : 0)));
    if (time > c.eNextBrake) {
      if (time > goAt + 3) c.eBrakeUntil = time + 0.4 + r() * 0.9;
      c.eNextBrake = time + (e.brakeEvery || 15) * (0.5 + r());
    }
    if (time > c.eNextLift) {
      if (time > goAt + 3) c.eLiftUntil = time + 0.5 + r() * 1.5;
      c.eNextLift = time + (e.liftEvery || 9) * (0.5 + r());
    }
    if (time < c.eBrakeUntil) { out.brake = 1; out.throttle = 0; out.boost = false; }
    else if (time < c.eLiftUntil) { out.throttle = Math.min(out.throttle, 0.15); out.boost = false; }
    return out;
  }

  function step() {
    time += STEP;
    if (phase === 'grid' && time >= goAt) {
      phase = 'race';
      for (const c of cars) if (c.kind !== 'parked' && c.kind !== 'wrong') { c.lap.arm(c.car.state.sampleIndex); c.lap.time = time - goAt; }
    }
    const locked = phase === 'grid';
    for (const c of cars) {
      const st = c.car.state, v = c.view;
      v.x = st.x; v.z = st.z; v.heading = st.heading; v.speed = st.speed; v.sampleIndex = st.sampleIndex; v.d = st.d;
      v.ghost = !!(t.pit && t.pit.paved && t.pit.paved(st.sampleIndex, st.d)) || (c.pit && !!c.pit.state.service);
      v.prog = c.lap ? c.lap.progress(st.sampleIndex) : 0;
      v.pace = c.kind === 'ai' ? c.ai.pace : NaN;
    }
    let leaderLaps = 0;
    for (const c of cars) leaderLaps = Math.max(leaderLaps, c.laps.length);
    for (const c of cars) {
      const st = c.car.state;
      if (c.kind === 'parked') { st.speed = 0; continue; }
      if (c.kind === 'wrong') { c.wrongPos -= (c.c.v || 15) * STEP / ds; if (c.wrongPos < 0) c.wrongPos += N; setWrong(c); continue; }
      const ctx = c.ctx;
      ctx.phase = phase; ctx.locked = locked; ctx.lap = c.laps.length; ctx.laps = R; ctx.done = c.fin; ctx.prog = c.view.prog;
      let inp = c.ai.think(STEP, c.c.blind ? blindViews : views, ctx);
      if (c.kind === 'erratic') { const r0 = inp.reset; inp = erraticInput(c, inp); inp.reset = r0; }
      c.inp = inp;
      if (locked) { st.speed = 0; continue; }
      if (c.pit.state.service) { st.speed = 0; st.hit = 0; stepPit(c, inp); c.lap.update(st.sampleIndex, 0, STEP); continue; }
      if (inp.reset) {
        const idx = F1.AI.resetCar(c.car, t, c.lap.jumping ? c.lap.prevIdx : st.sampleIndex, views, c.id); c.lap.sync(idx); c.resets++;
        continue;
      }
      c.car.update(STEP, inp, t);
    }
    for (let k = 0; k < cars.length; k++) {
      const c = cars[k], st = c.car.state;
      entries[k].solid = phase !== 'grid' && !(t.pit && t.pit.paved && t.pit.paved(st.sampleIndex, st.d)) && !(c.pit && c.pit.state.service);
    }
    resolveAll(entries, STEP, onContact);
    if (o.trace && time >= o.trace.from && time <= o.trace.to) traceStep();
    for (const c of cars) {
      if (c.kind === 'parked' || c.kind === 'wrong') continue;
      const st = c.car.state;
      if (locked) { c.lastProgT = time; c.lastPos = c.lap.progress(st.sampleIndex); continue; }
      if (!c.pit.state.service) stepPit(c, c.inp);
      // per-car bookkeeping: offs, wall hits, steering reversals on straights, pedal flips, stuck
      if (st.onGrass && !c.grassOn) c.offs++; c.grassOn = st.onGrass;
      const hn = st.hit > 0.02; if (hn && !c.hitOn) c.wallHits++; c.hitOn = hn;
      const k0 = st.sampleIndex | 0;
      if (c.kind === 'ai' && Math.abs(P[k0].curvature || 0) < 1 / 1000 && st.speed > 45 && c.ai.state.mode === 'race' && c.inp) {
        c.straightT += STEP;
        const ds1 = c.inp.steerAxis - c.lastSteer;
        if (Math.abs(ds1) > 0.004) { if (c.lastSteerD && Math.sign(ds1) !== Math.sign(c.lastSteerD)) c.steerRev++; c.lastSteerD = ds1; }
      }
      if (c.inp) {
        c.lastSteer = c.inp.steerAxis;
        const ped = c.inp.brake > 0.05 ? -1 : (c.inp.throttle > 0.05 ? 1 : 0);
        if (ped && c.lastPedal && ped !== c.lastPedal) c.pedalFlips++;
        if (ped) c.lastPedal = ped;
      }
      const pos = c.lap.progress(st.sampleIndex);
      if (c.lastPos < -1e8) c.lastPos = pos;
      if (pos > c.lastPos + 0.004 || c.fin || c.pit.state.service) { c.lastPos = Math.max(pos, c.lastPos); c.lastProgT = time; }
      const stuckFor = time - c.lastProgT;
      if (stuckFor > c.maxStuck) { c.maxStuck = stuckFor; c.maxStuckAt = st.sampleIndex; }
      if (stuckFor > 10 && !c.stuckFlag) { c.stuckEv++; c.stuckFlag = true; } else if (stuckFor < 1) c.stuckFlag = false;
      if (c.lap.update(st.sampleIndex, st.speed, STEP) === 2) {
        c.laps.push(c.lap.last);
        if (o.forcePit && c.kind === 'ai' && c.laps.length + 1 === o.forcePit.lap) c.ai.planStop(o.forcePit.compound || 'H');
        if (!c.fin && (c.laps.length >= R || leaderDone)) { c.fin = true; c.finT = time; leaderDone = true; }
      }
    }
  }
  const traceRows = [];
  function traceStep() {
    const ids = o.trace.ids, row = [Math.round(time * 1000) / 1000];
    for (const id of ids) {
      const c = cars[id - 1], st = c.car.state, a = c.ai ? c.ai.state : null, inp = c.inp || {};
      row.push(c.name + ' i' + st.sampleIndex + ' d' + st.d.toFixed(2) + ' L' + P[st.sampleIndex].d.toFixed(2) + ' h' + st.heading.toFixed(3) + ' v' + st.speed.toFixed(1) + ' va' + vAlong(c).toFixed(1) +
        (a ? ' ' + a.mode + ':' + a.cap + (a.capBy >= 0 ? '#' + a.capBy : '') + (a.tgt >= 0 ? ' T#' + a.tgt : '') + (a.obs >= 0 ? ' obs' + a.obs : '') + (a.plan ? ' plan:' + a.plan : '') + ' tg' + a.targetSpeed.toFixed(1) + ' off' + a.offset.toFixed(2) + '>' + a.offTarget.toFixed(2) : '') +
        ' T' + (inp.throttle || 0).toFixed(2) + ' B' + (inp.brake || 0).toFixed(2) + ' S' + (inp.steerAxis || 0).toFixed(2));
    }
    if (ids.length === 2) row.push('gap ' + along(cars[ids[0] - 1], cars[ids[1] - 1]).toFixed(2));
    traceRows.push(row.join(' | '));
  }
  function stepPit(c, inp) {
    const st = c.car.state;
    const ev = c.pit.update(STEP, st, t, { slot: c.c.slot != null ? c.c.slot : c.i, limiter: !!(inp && inp.limiter) });
    if (c.pit.state.inLane) c.laneMax = Math.max(c.laneMax, Math.abs(st.speed) * 3.6);
    if (!ev) return;
    if (ev === 'speeding') c.speeding++;
    if (ev === 'penaltyStart') c.penalties++;
    if (ev === 'serviceStart') c.pitStart = time;
    const fit = c.ai.onPit(ev);
    if (fit) { c.car.tyres.fit(fit); c.pits.push({ lap: c.laps.length + 1, compound: fit, held: Math.round((time - c.pitStart) * 100) / 100 }); }
  }

  function pileups() {
    // contacts within 3 s and 60 m of each other, chained: a group with 3 or more different cars is a pile-up
    const cs = rep.contacts.slice().sort((a, b) => a.t - b.t), groups = [];
    for (const k of cs) {
      let g = groups.find(G => k.t - G.t1 < 3 && Math.hypot(k.x - G.x, k.z - G.z) < 60);
      if (!g) { g = { t0: k.t, t1: k.t, x: k.x, z: k.z, cars: new Set(), n: 0, hMax: 0 }; groups.push(g); }
      g.t1 = k.t; g.n++; g.cars.add(k.ids[0]); g.cars.add(k.ids[1]); g.hMax = Math.max(g.hMax, k.h);
    }
    return groups.filter(g => g.cars.size >= 3).map(g => ({ t: g.t0, cars: g.cars.size, contacts: g.n, hMax: g.hMax }));
  }

  function run() {
    const maxS = o.maxS || (R * 200 + 60);
    const w0 = Date.now();
    const racers = cars.filter(c => c.kind === 'ai' || c.kind === 'erratic' || c.kind === 'human');
    while (time < maxS) {
      step();
      if (o.until && o.until(api)) break;
      if (racers.every(c => c.fin)) break;
    }
    rep.simS = time; rep.wallMs = Date.now() - w0; rep.finished = racers.every(c => c.fin);
    rep.pileups = pileups();
    rep.cars = cars.map(c => ({ name: c.name, kind: c.kind, skill: c.skill, car: c.spec.id, laps: c.laps.length, fin: c.fin, finT: c.finT,
      best: c.laps.length > 1 ? Math.min(...c.laps.slice(1)) : (c.laps[0] || null), lapTimes: c.laps.map(x => Math.round(x * 1000) / 1000),
      resets: c.resets, aiResets: c.ai ? c.ai.stats.resets : 0, stuck: c.stuckEv, maxStuck: Math.round(c.maxStuck * 10) / 10, maxStuckAt: c.maxStuckAt,
      offs: c.offs, walls: c.wallHits, contacts: c.contacts, struck: c.struck, pits: c.pits, speeding: c.speeding, penalties: c.penalties,
      laneMax: Math.round(c.laneMax), steerRevPerS: c.straightT > 1 ? c.steerRev / c.straightT : 0, straightT: c.straightT,
      pedalFlipsPerMin: c.pedalFlips / Math.max(1, time - goAt) * 60, stats: c.ai ? Object.assign({}, c.ai.stats) : null,
      log: c.ai ? c.ai.log.slice().sort((a, b) => a[0] - b[0]) : [] }));
    return rep;
  }
  const api = { run, step, cars, track: t, line, rep, traceRows, get time() { return time; }, get phase() { return phase; } };
  return api;
}

// summaries used by several critic scripts
function summarize(rep) {
  const c = rep.contacts;
  const aiStrikes = c.filter(k => k.strikerKind === 'ai');
  return {
    contacts: c.length, heavy: c.filter(k => k.h > 0.25).length, maxH: c.reduce((m, k) => Math.max(m, k.h), 0),
    aiRear: aiStrikes.length, aiRearHeavy: aiStrikes.filter(k => k.h > 0.25).length, aiRearMax: aiStrikes.reduce((m, k) => Math.max(m, k.h), 0),
    pileups: rep.pileups.length, resets: rep.cars.reduce((s, x) => s + x.resets, 0), stuck: rep.cars.reduce((s, x) => s + x.stuck, 0),
    maxStuck: rep.cars.filter(x => x.kind === 'ai').reduce((m, x) => Math.max(m, x.maxStuck), 0),
    offs: rep.cars.reduce((s, x) => s + x.offs, 0), walls: rep.cars.filter(x => x.kind === 'ai').reduce((s, x) => s + x.walls, 0),
    finished: rep.finished, speeding: rep.cars.reduce((s, x) => s + x.speeding, 0), penalties: rep.cars.reduce((s, x) => s + x.penalties, 0)
  };
}
function fmtSum(s) {
  return 'contacts ' + s.contacts + ' (heavy ' + s.heavy + ', max ' + s.maxH.toFixed(2) + '; AI rear-ends ' + s.aiRear + ', heavy ' + s.aiRearHeavy + ', max ' + s.aiRearMax.toFixed(2) + ')' +
    ' pileups ' + s.pileups + ' R ' + s.resets + ' stuck ' + s.stuck + ' (max ' + s.maxStuck.toFixed(1) + ' s) offs ' + s.offs + ' walls ' + s.walls +
    (s.speeding || s.penalties ? ' SPEEDING ' + s.speeding + ' pen ' + s.penalties : '') + (s.finished ? '' : ' NOT FINISHED');
}
function field(n, opts) {
  opts = opts || {};
  const rnd = F1.AI.makeRandom(opts.seed || 5), year = opts.year || 2025;
  const cars = F1.cars.list(year).filter(c => !/-standard$/.test(c.id));
  const out = [];
  for (let i = 0; i < n; i++) {
    const lv = opts.skill != null ? F1.AI.skillOf(opts.skill) : F1.AI.LEVELS[Math.floor(rnd() * 4)].skill;
    out.push({ kind: 'ai', skill: lv, car: opts.car || cars[(i * 5 + (opts.seed || 0)) % cars.length].id, name: F1.AI.levelOf(lv).id.slice(0, 3) + (i + 1) });
  }
  return out;
}
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };

module.exports = { createScenario, summarize, fmtSum, field, arg, STEP, L, F1 };
