// node devtests/tunnel-test/check.js        (no network, ~20 s)
// js/tunnels.js against the REAL track, scenery and car modules (node, three.js r149):
//   api        Monaco's two covered stretches, ranges, inTunnel / lightAt / sceneLight / covered, update(), NaN-free
//              buffers, deterministic, dispose, every circuit builds (empty where there is no data)
//   per circuit with data (Monaco, Monza, Madring):
//     walls    the tunnel's walls coincide with js/track.js's walls: horizontal rays from the centreline hit the barrier
//              first below its top (at its inner face) and the tunnel wall WALL_GAP behind it above (the sea openings
//              excepted); no tunnel wall where the track has no barrier
//     volume   nothing of the tunnel in the drivable volume (|d| < barrier face, up to 4.5 m above the road), nothing of it
//              (wings, portal facades) over any other part of the corridor
//     ceiling  rays straight up from the road hit the soffit H_CEIL above the centreline surface
//     car      js/car.js steered into both walls in the longest stretch: the barrier stops it (its side never past the
//              barrier face, so it never reaches the tunnel wall 0.52 m further); on the centreline: no contact
//     scenery  js/scenery.js's meshes (built in node): no triangle inside the tunnel's interior
//   synthetic  a made-up 300 m tunnel with an open side on other circuits builds NaN-free
//   impulse    F1.tunnelImpulse
//   data       F1.TUNNEL_DATA equals tools/tunnels.json's "tracks"
// Exit code 1 when a check fails. Results also in devtests/tunnel-test/out/check.json.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
require(path.join(ROOT, 'js', 'car.js'));
require(path.join(ROOT, 'js', 'scenery.js'));
require(path.join(ROOT, 'js', 'tunnels.js'));
const F1 = global.F1, THREE = global.THREE;
const out = { checks: [], tracks: {} };
let fails = 0;
function check(name, ok, detail) {
  out.checks.push({ name, ok: !!ok, detail });
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
const WALL_GAP = 0.52, OUT_T = 1.1, H_CEIL = 6.8;
const byId = id => global.F1_TRACKS.find(t => t.id === id);
function meshOf(tn, name) { return tn.group.children.find(m => m.name === name); }
function nanFree(tn) {
  for (const m of tn.group.children) {
    for (const k of Object.keys(m.geometry.attributes)) {
      const a = m.geometry.attributes[k].array;
      for (let i = 0; i < a.length; i++) if (!isFinite(a[i])) return m.name + '.' + k + '[' + i + ']';
    }
  }
  return '';
}

// ---------------------------------------------------------------- api (Monaco)
{
  const MC = byId('mc-1929');
  const tr = F1.buildTrack(MC), S = tr.samples, N = S.length, ds = tr.length / N;
  const tn = F1.buildTunnels(tr, MC);
  check('Monaco: two covered stretches (Portier underpass, the tunnel)', tn.tunnels.length === 2 &&
    tn.tunnels[0].kind === 'underpass' && tn.tunnels[1].kind === 'tunnel', tn.tunnels.map(t => t.name + ' ' + t.from + '..' + t.to + ' ' + t.length + ' m'));
  const T = tn.tunnels.find(t => t.kind === 'tunnel'), U = tn.tunnels.find(t => t.kind === 'underpass');
  check('tunnel length 330..420 m (OSM ways 4230891 + 1230247123: ~370 m on the game track; "about 400 m")', T.length >= 330 && T.length <= 420, T.length);
  check('the tunnel opens on the sea side (left, +n) over 150..230 m', T.open.length === 1 && T.open[0].side === 1 &&
    ((T.open[0].to - T.open[0].from + N) % N) * ds >= 150 && ((T.open[0].to - T.open[0].from + N) % N) * ds <= 230, T.open);
  check('stats: 4 draw calls, < 20k triangles, built in < 60 ms', tn.stats.drawCalls <= 4 && tn.stats.triangles < 20000 && tn.stats.ms < 60, tn.stats);
  check('NaN-free buffers', !nanFree(tn), nanFree(tn) || 'ok');
  const K = (T.to - T.from + N) % N, mid = (T.from + (K >> 1)) % N, rel = i => (i - T.from + N) % N;
  let okRange = true, why = '';
  for (let i = 0; i < N; i++) {
    const it = tn.inTunnel(i), l = tn.lightAt(i), h = tn.sceneLight(i, 'hemi'), su = tn.sceneLight(i, 'sun');
    if (!(it >= 0 && it <= 1 && l >= 0.29 && l <= 1 && h > 0.5 && h <= 1.36 && su >= 0 && su <= 1)) { okRange = false; why = i + ' ' + [it, l, h, su]; break; }
    const inU = (i - U.from + N) % N <= (U.to - U.from + N) % N;
    if (rel(i) > K && !inU && (it !== 0 || l !== 1 || h !== 1 || su !== 1)) { okRange = false; why = 'outside ' + i; break; }
  }
  check('inTunnel / lightAt / sceneLight in range; exactly 0 / 1 outside the covered stretches', okRange, why || 'ok');
  check('deep inside: inTunnel 1, lightAt 0.3, sun 0, hemi ~0.83', tn.inTunnel(mid + 40) === 1 && Math.abs(tn.lightAt(mid + 40) - 0.3) < 1e-6 &&
    tn.sceneLight(mid + 40, 'sun') === 0 && Math.abs(tn.sceneLight(mid + 40, 'hemi') - 0.834) < 0.01,
    { i: mid + 40, it: tn.inTunnel(mid + 40), l: tn.lightAt(mid + 40), hemi: +tn.sceneLight(mid + 40, 'hemi').toFixed(3) });
  let maxStep = 0;
  for (let r = 0; r <= K; r++) maxStep = Math.max(maxStep, Math.abs(tn.inTunnel((T.from + r) % N) - tn.inTunnel((T.from + r + 1) % N)), Math.abs(tn.lightAt((T.from + r) % N) - tn.lightAt((T.from + r + 1) % N)));
  check('ramps smooth (max change per 2 m sample <= 0.13: smootherstep over 30 m) and inTunnel = 1 from 30 m in', maxStep <= 0.13 &&
    tn.inTunnel((T.from + Math.ceil(30 / ds)) % N) > 0.999 && tn.inTunnel((T.from + 2) % N) < 0.1, { maxStep: +maxStep.toFixed(3) });
  check('beside the sea openings: lightAt 0.5', Math.abs(tn.lightAt((T.open[0].from + 30) % N) - 0.5) < 1e-6, tn.lightAt((T.open[0].from + 30) % N));
  check('covered(): strictly between the portals', tn.covered(mid) && !tn.covered(T.from) && !tn.covered(T.to) && tn.covered((T.from + 1) % N));
  const uPeak = Math.max(...Array.from({ length: (U.to - U.from + N) % N + 1 }, (_, k) => tn.inTunnel((U.from + k) % N)));
  check('the ' + U.length + ' m underpass peaks at inTunnel 0.05..0.35 (too short for a full reverb)', uPeak > 0.05 && uPeak < 0.35, +uPeak.toFixed(3));
  const shade = meshOf(tn, 'tunnel-shade'), glare = meshOf(tn, 'tunnel-glare'), inner = meshOf(tn, 'tunnel-interior');
  tn.update(1, null);
  const outside = { shade: shade.visible, shadeK: shade.material.color.r, glare: glare.visible, exp: +inner.material.color.r.toFixed(3) };
  tn.update(1, mid + 40);
  const deep = { shade: shade.visible, glare: glare.visible, glareOp: +glare.material.opacity.toFixed(3), exp: +inner.material.color.r.toFixed(3) };
  tn.update(1, mid + 40, false);
  const deepUnscaled = { shade: shade.visible, shadeK: shade.material.color.r };
  tn.update(1, undefined);
  const back = { shade: shade.visible, glare: glare.visible };
  check('update(): outside -> shade on, glare off, interior exposure 0.49; deep inside -> shade off, glare 0.9, exposure 1; ' +
    'sceneScaled false keeps the shade; undefined = outside again',
    outside.shade && outside.shadeK === 1 && !outside.glare && Math.abs(outside.exp - 0.486) < 0.01 && !deep.shade && deep.glare &&
    deep.glareOp === 0.9 && deep.exp === 1 && deepUnscaled.shade && deepUnscaled.shadeK === 1 && back.shade && !back.glare,
    { outside, deep, deepUnscaled, back });
  const tn2 = F1.buildTunnels(tr, MC);
  let same = tn2.group.children.length === tn.group.children.length;
  tn.group.children.forEach((m, k) => { const a = m.geometry.attributes.position.array, b = tn2.group.children[k].geometry.attributes.position.array; if (a.length !== b.length) same = false; else for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; } });
  check('deterministic (two builds identical)', same);
  let disposed = 0; tn2.group.children.forEach(m => m.geometry.addEventListener('dispose', () => disposed++));
  const nMesh = tn2.group.children.length; tn2.dispose();
  check('dispose() frees every geometry and empties the group', disposed === nMesh && tn2.group.children.length === 0, { disposed, nMesh });
  check('an explicit [] builds an empty group', F1.buildTunnels(tr, MC, []).group.children.length === 0);
  tn.dispose(); tr.dispose();
}

// ---------------------------------------------------------------- per circuit with data: walls, volume, ceiling, car, scenery
const ray = new THREE.Raycaster();
function firstHit(o, dir, objs) { ray.set(o, dir); ray.far = 40; const h = ray.intersectObjects(objs, false); return h.length ? h[0] : null; }
for (const id of Object.keys(F1.TUNNEL_DATA)) {
  const td = byId(id);
  if (!td) { check(id + ': in tracks-data.js', false); continue; }
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length;
  const tn = F1.buildTunnels(tr, td);
  const R0 = tn.tunnels;
  const rec = out.tracks[id] = { tunnels: R0, stats: tn.stats };
  const tag = id + ' (' + R0.map(r => r.name + ' ' + r.length + ' m').join(', ') + ')';
  check(tag + ': every data entry built', R0.length === F1.TUNNEL_DATA[id].length && !nanFree(tn), { built: R0.length, data: F1.TUNNEL_DATA[id].length, nan: nanFree(tn) || 'none' });
  const inner = meshOf(tn, 'tunnel-interior'), trackWalls = tr.group.children.filter(m => m.isMesh && m.name === 'walls');
  inner.updateMatrixWorld(true); trackWalls.forEach(m => m.updateMatrixWorld(true));
  const inStretch = (i, strict) => R0.some(R => { const r = (i - R.from + N) % N, K = (R.to - R.from + N) % N; return strict ? r > 0 && r < K : r <= K; });
  // walls + ceiling
  let wallRays = 0, wallBad = [], openRays = 0, ceilBad = [], ceilRays = 0, faceErr = 0;
  for (const R of R0) {
    const KK = (R.to - R.from + N) % N;
    for (let r = 1; r < KK; r++) {
      const i = (R.from + r) % N, s = S[i];
      for (const side of [1, -1]) {
        const flag = side > 0 ? s.wallPos : s.wallNeg, wd = side > 0 ? s.wallPosDist : s.wallNegDist;
        const inOpen = R.open.some(o => o.side === side && (i - o.from + N) % N <= (o.to - o.from + N) % N);
        // (the top one stays under the chamfer, which starts 0.7 m under the level soffit: lower beside a raised banked edge)
        const hTop = Math.min(0.75 * R.height, (s.y || 0) + R.height - 0.9 - tr.surfaceY(i, side * wd));
        for (const h of [0.3, 1.5, +(0.45 * R.height).toFixed(2), +hTop.toFixed(2)]) {
          // h above the surface AT the wall (banked roads: the wall's foot is higher / lower than the centreline)
          const o = new THREE.Vector3(s.x, tr.surfaceY(i, side * wd) + h, s.z), dir = new THREE.Vector3(s.nx * side, 0, s.nz * side);
          const hw = firstHit(o, dir, trackWalls), ht = firstHit(o, dir, [inner]);
          wallRays++;
          if (!flag) { if (ht && ht.distance < wd + 3) wallBad.push({ i, side, h, why: 'tunnel wall without a barrier' }); continue; }
          if (h < 1.15) {
            if (!hw || (ht && ht.distance < hw.distance - 1e-3)) wallBad.push({ i, side, h, why: 'barrier not first', hw: hw && +hw.distance.toFixed(2), ht: ht && +ht.distance.toFixed(2) });
            else if (Math.abs(hw.distance - wd) > 0.1) wallBad.push({ i, side, h, why: 'barrier face', at: +hw.distance.toFixed(2), wd: +wd.toFixed(2) });
          } else if (inOpen && h > 2.9 && !ht) openRays++;
          else if (!ht) wallBad.push({ i, side, h, why: 'no tunnel wall' });
          else if (!(inOpen && h > 2.9)) {
            faceErr = Math.max(faceErr, Math.abs(ht.distance - (wd + WALL_GAP)));
            if (Math.abs(ht.distance - (wd + WALL_GAP)) > 0.1) wallBad.push({ i, side, h, why: 'tunnel wall face', at: +ht.distance.toFixed(2), want: +(wd + WALL_GAP).toFixed(2) });
          } else if (ht.distance > wd + WALL_GAP + 0.05) openRays++;
        }
      }
      for (const d of [0, -6, 6, -(s.wallNegDist + WALL_GAP - 0.9), s.wallPosDist + WALL_GAP - 0.9]) {
        const o = new THREE.Vector3(s.x + s.nx * d, tr.surfaceY(i, d) + 0.5, s.z + s.nz * d);
        const ht = firstHit(o, new THREE.Vector3(0, 1, 0), [inner]);
        ceilRays++;
        const want = (s.y || 0) + R.height;    // level across, ceil (6.8 m by default) above the centreline surface
        if (!ht || ht.point.y < want - 0.2 || ht.point.y > want + 0.01) ceilBad.push({ i, d: +d.toFixed(1), y: ht ? +ht.point.y.toFixed(2) : null, want: +want.toFixed(2) });
      }
    }
  }
  check(id + ': walls - the barrier first below its top, the tunnel wall WALL_GAP behind it above (10 cm for chords on tight corners; sea openings excepted)',
    !wallBad.length, { rays: wallRays, bad: wallBad.length, first: wallBad.slice(0, 4), maxFaceErr: +faceErr.toFixed(3), throughOpenings: openRays });
  check(id + ': ceiling - rays up from the road hit the flat soffit (' + R0.map(r => r.height).join(' / ') + ' m) above the centreline surface', !ceilBad.length, { rays: ceilRays, bad: ceilBad.slice(0, 4) });
  // drivable volume + other parts of the corridor (barycentric grid on every triangle)
  let inVol = 0, inVolEx = [], foreignHits = {}, fhEx = [];
  for (const name of ['tunnel-interior', 'tunnel-exterior']) {
    const g = meshOf(tn, name).geometry.attributes.position;
    for (let t = 0; t < g.count / 3; t++) {
      const P3 = [0, 1, 2].map(c => [g.getX(t * 3 + c), g.getY(t * 3 + c), g.getZ(t * 3 + c)]);
      for (let u = 0; u <= 6; u++) for (let v = 0; v <= 6 - u; v++) {
        const w = 6 - u - v, x = (P3[0][0] * u + P3[1][0] * v + P3[2][0] * w) / 6, y = (P3[0][1] * u + P3[1][1] * v + P3[2][1] * w) / 6, z = (P3[0][2] * u + P3[1][2] * v + P3[2][2] * w) / 6;
        const q = tr.nearest(x, z), s = S[q.index], surf = tr.surfaceY(q.index, q.d);
        const lim = q.d > 0 ? s.wallPosDist : s.wallNegDist;
        const Rq = R0.find(R => (q.index - R.from + N) % N <= (R.to - R.from + N) % N), env = Rq ? Math.min(4.5, Rq.height - 1.0) : 4.5;
        if (Math.abs(q.d) < lim - 0.02 && y > surf + 0.05 && y < surf + env) { inVol++; if (inVolEx.length < 4) inVolEx.push({ name, i: q.index, d: +q.d.toFixed(2), h: +(y - surf).toFixed(2) }); }
        if (!inStretch(q.index, false) && tr.inCorridor(x, z, 0.3) && y > surf - 0.5) {
          foreignHits[q.index] = (foreignHits[q.index] || 0) + 1;
          if (fhEx.length < 4) fhEx.push({ name, i: q.index, d: +q.d.toFixed(1), h: +(y - surf).toFixed(1) });
        }
      }
    }
  }
  check(id + ': nothing of the tunnel in the drivable volume (|d| < barrier face, up to 4.5 m above the road or 1 m under a lower soffit)', inVol === 0, { inVol, ex: inVolEx });
  check(id + ': nothing of the tunnel over another part of the corridor (+0.3 m): the wings / facades stop short of the road beyond the portals and of other roads',
    !Object.keys(foreignHits).length, { foreignHits, ex: fhEx });
  // car
  const L = R0.slice().sort((a, b) => b.length - a.length)[0], KL = (L.to - L.from + N) % N;
  function drive(startI, mode, secs) {
    const car = F1.createCar(), st = car.state;
    car.reset(tr, startI);
    if (mode !== 'centre') {          // start near that wall, so that even a short underpass is reached at its wall
      const s0 = S[startI], sg = mode === 'left' ? 1 : -1, off = sg * ((sg > 0 ? s0.wallPosDist : s0.wallNegDist) - 3);
      st.x += s0.nx * off; st.z += s0.nz * off;
    }
    st.speed = mode === 'centre' ? 50 : 35;
    let maxOver = -1e9, hits = 0, maxD = 0, gotIn = false;
    const DT = 1 / 120;
    for (let t = 0; t < secs; t += DT) {
      const inp = { up: true, down: false, left: false, right: false, throttle: 0.7, brake: 0, steerAxis: 0 };
      if (mode === 'centre') {
        const q = S[(st.sampleIndex + 10) % N];
        let e = Math.atan2(q.x - st.x, q.z - st.z) - st.heading; while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
        inp.steerAxis = Math.max(-1, Math.min(1, 2 * e));
      } else inp.steerAxis = mode === 'left' ? 0.35 : -0.35;
      car.update(DT, inp, tr);
      const r = (st.sampleIndex - L.from + N) % N;
      if (r > 0 && r < KL) gotIn = true;
      if (gotIn && st.hit > 0 && r <= KL) hits++;
      const ss = S[st.sampleIndex], wd = st.d > 0 ? ss.wallPosDist : ss.wallNegDist;
      if (r <= KL) { maxOver = Math.max(maxOver, Math.abs(st.d) + 1.0 - wd); maxD = Math.max(maxD, Math.abs(st.d)); }
      if (gotIn && r > KL && r < N / 2) break;
    }
    return { hits, maxOver: +maxOver.toFixed(3), maxD: +maxD.toFixed(2) };
  }
  const startW = (L.from - 6 + N) % N;
  const dl = drive(startW, 'left', 5), dr = drive(startW, 'right', 5), dc = drive((L.from - 15 + N) % N, 'centre', 14);
  check(id + ': car steered into the left wall in "' + L.name + '": the barrier stops it (its side never past the barrier face)', dl.hits > 0 && dl.maxOver <= 0.03, dl);
  check(id + ': car steered into the right wall: same', dr.hits > 0 && dr.maxOver <= 0.03, dr);
  check(id + ': car on the centreline through it: no contact', dc.hits === 0, dc);
  // scenery
  const sc = F1.buildScenery(tr, td, global.F1_SCENERY[id]);
  const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let interior = 0, block = 0; const ex = [];
  sc.group.updateMatrixWorld(true);
  sc.group.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || o.isInstancedMesh) return;
    const g = o.geometry, pos = g.attributes.position, idx = g.index, nT = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < nT; t++) {
      for (let c = 0; c < 3; c++) { const vi = idx ? idx.getX(t * 3 + c) : t * 3 + c; tri[c].fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld); }
      const pts = [tri[0], tri[1], tri[2], tri[0].clone().add(tri[1]).add(tri[2]).multiplyScalar(1 / 3)];
      for (const p of pts) {
        const q = tr.nearest(p.x, p.z);
        if (!inStretch(q.index, true)) continue;
        const s = S[q.index], lim = (q.d > 0 ? s.wallPosDist : s.wallNegDist) + WALL_GAP, surf = tr.surfaceY(q.index, q.d);
        if (Math.abs(q.d) < lim - 0.02 && p.y > surf + 0.1 && p.y < (s.y || 0) + H_CEIL - 0.05) {
          interior++; if (ex.length < 6) ex.push({ mesh: o.name, i: q.index, d: +q.d.toFixed(2), h: +(p.y - surf).toFixed(2) }); break;
        }
        if (Math.abs(q.d) < lim + OUT_T - 0.02 && p.y > surf + 0.1 && p.y < (s.y || 0) + H_CEIL + 1.8) { block++; break; }
      }
    }
  });
  check(id + ': scenery - nothing inside the tunnel interior', interior === 0, { interior, ex, inBlockSolidPart: block });
  rec.scenery = { interior, inBlockSolidPart: block };
  sc.dispose(); tn.dispose(); tr.dispose();
}

// ---------------------------------------------------------------- every circuit builds (empty where there is no data)
{
  let allOk = true, maxMs = 0, nonEmpty = [];
  for (const td of global.F1_TRACKS) {
    const t2 = F1.buildTrack(td);
    try {
      const s0 = Date.now(), x = F1.buildTunnels(t2, td);
      maxMs = Math.max(maxMs, Date.now() - s0);
      if (x.group.children.length) nonEmpty.push(td.id);
      if (nanFree(x)) allOk = false;
      x.dispose();
    } catch (e) { allOk = false; console.log('  ' + td.id + ': ' + e.message); }
    t2.dispose();
  }
  const want = Object.keys(F1.TUNNEL_DATA).sort().join(',');
  check('all ' + global.F1_TRACKS.length + ' circuits build; only those with data get geometry', allOk && nonEmpty.sort().join(',') === want, { nonEmpty, maxMs });
}

// ---------------------------------------------------------------- synthetic tunnels elsewhere
for (const id of ['jp-1962', 'be-1925', 'sg-2008', 'us-2023']) {
  const td = byId(id), t2 = F1.buildTrack(td), L = t2.length;
  const f0 = 0.3, f1 = 0.3 + 300 / L, fo0 = f0 + 40 / L, fo1 = f1 - 40 / L;
  const x = F1.buildTunnels(t2, td, [{ name: 'test', kind: 'tunnel', facade: ['hotel', 'plain'], fFrom: f0, fTo: f1, fSplit: (f0 + f1) / 2,
    open: [{ side: -1, fFrom: fo0, fTo: fo1 }] }]);
  const bad = nanFree(x);
  check('synthetic 300 m tunnel on ' + id + ': built, NaN-free, open side', x.tunnels.length === 1 && !bad && x.tunnels[0].open.length === 1 && x.stats.triangles > 2000,
    { t: x.tunnels[0] && { from: x.tunnels[0].from, to: x.tunnels[0].to, length: x.tunnels[0].length }, stats: x.stats, bad });
  x.dispose(); t2.dispose();
}

// ---------------------------------------------------------------- synthetic: the narrowest 60 m of Monaco, low (ceil 4, deck 4.5)
{
  const td = byId('mc-1929'), t2 = F1.buildTrack(td), S2 = t2.samples, n = S2.length, L = t2.length, span = Math.round(60 / (L / n));
  let best = -1, bw = Infinity;
  for (let i = 0; i < n; i++) {
    let w = 0;
    for (let k = 0; k <= span; k++) { const s = S2[(i + k) % n]; w = Math.max(w, Math.min(s.wallPosDist, s.wallNegDist)); }
    if (w < bw) { bw = w; best = i; }
  }
  const f0 = S2[best].s / L, f1 = S2[(best + span) % n].s / L;
  const x = F1.buildTunnels(t2, td, [{ name: 'narrow', kind: 'tunnel', facade: 'hotel', fFrom: f0, fTo: f1, ceil: 4, deck: 4.5 }]);
  let outside = 0, maxY = -Infinity;
  const own = []; for (let k = -2; k <= span + 2; k++) own.push((best + k + n) % n);
  for (const m of x.group.children.filter(m => m.name === 'tunnel-interior')) {
    const g = m.geometry.attributes.position;
    for (let v = 0; v < g.count; v++) {
      const px = g.getX(v), pz = g.getZ(v);
      let j = own[0], bd = Infinity;          // nearest sample of THIS stretch (another road may pass close by)
      for (const i of own) { const d2 = (S2[i].x - px) ** 2 + (S2[i].z - pz) ** 2; if (d2 < bd) { bd = d2; j = i; } }
      const s = S2[j], d = (px - s.x) * s.nx + (pz - s.z) * s.nz, lim = (d > 0 ? s.wallPosDist : s.wallNegDist) + WALL_GAP;
      if (Math.abs(d) > lim + 0.35) outside++;
      maxY = Math.max(maxY, g.getY(v) - (s.y || 0));
    }
  }
  check('synthetic narrow (walls <= ' + bw.toFixed(1) + ' m) and low (ceil 4 m, deck 4.5 m) tunnel at Monaco sample ' + best +
    ': NaN-free, the interior (fixtures, soffit strips) inside its walls and under its soffit (0.2 m for the grade between samples)', x.tunnels.length === 1 && !nanFree(x) &&
    outside === 0 && maxY <= 4.2 && x.tunnels[0].height === 4, { outside, maxY: +maxY.toFixed(2), stats: x.stats });
  x.dispose(); t2.dispose();
}

// ---------------------------------------------------------------- F1.tunnelImpulse (the reverb offered to js/audio.js)
{
  const ir = F1.tunnelImpulse(48000, { width: 25, height: 6.8, rt60: 1.4 });
  const L = ir.left, R = ir.right, sr = ir.sampleRate;
  let finite = true, eA = 0, eB = 0, peak = 0;
  for (let i = 0; i < L.length; i++) {
    if (!isFinite(L[i]) || !isFinite(R[i])) { finite = false; break; }
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    if (i < sr * 0.1) eA += L[i] * L[i] + R[i] * R[i];
    else if (i >= sr * 1.2 && i < sr * 1.3) eB += L[i] * L[i] + R[i] * R[i];
  }
  const drop = 10 * Math.log10(eB / eA), flutter = Math.round(2 * 6.8 / 343 * sr), side = Math.round(25 / 343 * sr);
  const again = F1.tunnelImpulse(48000, { width: 25, height: 6.8, rt60: 1.4 });
  let same = again.left.length === L.length; for (let i = 0; same && i < L.length; i += 97) if (again.left[i] !== L[i]) same = false;
  check('F1.tunnelImpulse: stereo, finite, ' + (L.length / sr).toFixed(2) + ' s, decays (1.2 s vs the first 0.1 s <= -35 dB), taps at the flutter (2h/c) and the side walls (w/c), deterministic',
    finite && L.length === R.length && L.length >= sr * 1.5 && drop <= -35 && Math.abs(L[flutter]) > 0.2 && Math.abs(L[side]) > 0.1 && same && peak < 2,
    { seconds: +(L.length / sr).toFixed(2), dropDb: +drop.toFixed(1), flutterMs: +(flutter / sr * 1000).toFixed(1), sideMs: +(side / sr * 1000).toFixed(1), peak: +peak.toFixed(2) });
}

// ---------------------------------------------------------------- data file
{
  const jf = path.join(ROOT, 'tools', 'tunnels.json');
  if (fs.existsSync(jf)) {
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    const a = JSON.stringify(j.tracks), b = JSON.stringify(F1.TUNNEL_DATA);
    check('F1.TUNNEL_DATA (js/tunnels.js) equals tools/tunnels.json "tracks"', a === b, a === b ? 'same' : { json: a.slice(0, 300), js: b.slice(0, 300) });
  } else check('tools/tunnels.json exists', false);
}

fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', 'check.json'), JSON.stringify(out, null, 1));
console.log((fails ? 'FAILED ' + fails : 'OK') + ' (' + (out.checks.length - fails) + '/' + out.checks.length + ')');
process.exit(fails ? 1 : 0);
