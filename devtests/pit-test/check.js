// node devtests/pit-test/check.js [track regex]
//
// The pit lane of js/track.js (track.pit) on every track, checked from the exported data (README-interfaces.md, v6):
//   exists     every track has one
//   side       on the side of the real pit buildings next to the line (scenery-data.js 'pit' footprints) where known
//   circuit    no point of the complex (lane, boxes, tapers, out to the outer wall) is nearer another part of the
//              circuit, inside its corridor, or outside inCorridor(); nearest() finds the lane's own stretch everywhere
//   walls      the pit side has a wall flag all along from..to, drawn where samples say (walls mesh)
//   boxes      16, slot order (box 1 = slot 0 next to the exit), distinct, outside the driving lane, inside the complex,
//              facing along the lane, reachable from the lane centre over asphalt
//   curtains   no painted box within BOX_CLEAR m of a light curtain (as drawn: the 'pitCurtains' mesh), and no car
//              stopped in a box (anywhere js/pit.js serves it: its origin within BOX_ALONG of the box point; nose 2.8 m,
//              tail 2.7 m) within CAR_CLEAR m, measured along the lane: a curtain that close fills the driver's view
//              (it was 5 m in front of box 1 at Monaco and Las Vegas)
//   order      entry < line < exit in lap order (Monaco: see the report; the 'late' layout puts the entry after the line)
//   path       the lane centre can be driven at the limit (lateral acceleration, clearance to both walls, on asphalt)
//   api        laneD / wallD / inLane / paved / contains agree with each other on a dense grid of points
//   same       samples: every field of the git HEAD js/track.js is identical except the pit side's wall distance / flag
//              in the lane (only ever further out); the v5 baseline (devtests/pit-test/track-v5.js, js/track.js before
//              the pit lane) gives the same grid, crossings, road / paint vertices (as a prefix), locate / nearest /
//              surfaceY / groundY / inCorridor on the racing surface. Two later deliberate changes of js/track.js are
//              allowed for (2026-10-01, folded in from devtests/track-fix/pit-check.js):
//                1. real banked corners (tracks-data.js bankOverrides): HEAD and v5 are compared with the new js/track.js
//                   built from the track WITHOUT its bankOverrides, and the build WITH them may differ from that in
//                   `bank` only, and only on the overrides' sections +- the 35 m ramps;
//                2. no kerbs on the pit lane's asphalt: the v5 paint mesh must still be a prefix of the new one once the
//                   v5 kerb triangles on the pit side of from..to (the kerb strip, halfW .. halfW + 1.3 m, where the
//                   lane's asphalt now is) are taken out, and every triangle taken out must be such a kerb triangle.
//   time       build time (median of 3) against HEAD
// Exit code 1 when a check fails. Warnings are printed and counted but do not fail.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
const TRACKS = window.F1_TRACKS, SCENERY = window.F1_SCENERY;

function loadBuild(src, file, scenery) {
  const win = { THREE: global.THREE };
  if (scenery) win.F1_SCENERY = SCENERY;
  vm.runInContext(src, vm.createContext({ window: win, console }), { filename: file });
  return win.F1.buildTrack;
}
const SRC_NEW = fs.readFileSync(path.join(ROOT, 'js/track.js'), 'utf8');
const SRC_HEAD = cp.execSync('git show HEAD:js/track.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
const SRC_V5 = fs.readFileSync(path.join(__dirname, 'track-v5.js'), 'utf8');
const buildNew = loadBuild(SRC_NEW, 'js/track.js', true);
const buildNoSc = loadBuild(SRC_NEW, 'js/track.js (no scenery data)', false);
const buildHead = loadBuild(SRC_HEAD, 'HEAD:js/track.js', true);
const buildV5 = loadBuild(SRC_V5, 'track-v5.js', true);
const BOX_ALONG = require(path.join(ROOT, 'js/pit.js')).BOX_ALONG;   // how far from the box point js/pit.js still serves a car
const BOX_CLEAR = 10, CAR_CLEAR = 8;   // m along the lane from a light curtain: painted box / car stopped in a box

const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
let fails = 0, warns = 0;
const failed = new Set();
function check(ok, id, what) {
  if (!ok) { fails++; failed.add(id); if (fails < 200) console.log('  FAIL ' + id + ': ' + what); }
  return ok;
}
function warn(id, what) { warns++; console.log('  WARN ' + id + ': ' + what); }
const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
function median(a) { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; }

// side of the scenery data's 'pit' buildings next to the line (independent of js/track.js)
function dataSide(td, S) {
  const sc = SCENERY[td.id], N = S.length, ds = 2;
  if (!sc || !sc.buildings) return 0;
  let acc = 0;
  for (const b of sc.buildings) {
    if (b.k !== 'pit' || !b.p || b.p.length < 3) continue;
    let cx = 0, cz = 0, ar = 0;
    b.p.forEach((p, i) => { const q = b.p[(i + 1) % b.p.length]; cx += p[0]; cz += p[1]; ar += p[0] * q[1] - q[0] * p[1]; });
    cx /= b.p.length; cz /= b.p.length;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) { const d = (S[i].x - cx) ** 2 + (S[i].z - cz) ** 2; if (d < bd) { bd = d; bi = i; } }
    const off = bi > N / 2 ? bi - N : bi;
    if (Math.abs(off * ds) > 460 || Math.sqrt(bd) > 200) continue;
    acc += Math.sign((cx - S[bi].x) * S[bi].nx + (cz - S[bi].z) * S[bi].nz) * Math.max(1, Math.abs(ar) / 2);
  }
  return Math.sign(acc);
}

const rows = [];
for (const td of TRACKS) {
  if (filter && !filter.test(td.id) && !filter.test(td.name)) continue;
  const id = td.id;
  let tr = buildNew(td), kerbsOff = 0;
  const S = tr.samples, N = S.length, ds = tr.length / N, pit = tr.pit;
  const wq = q => ((q % N) + N) % N, cyc = (a, b) => { const d = Math.abs(a - b); return Math.min(d, N - d); };
  if (!check(!!pit, id, 'track.pit is null')) { tr.dispose(); continue; }
  const sg = pit.side, K = wq(pit.to - pit.from), kOf = i => wq(i - pit.from), inLaneIdx = i => kOf(i) <= K;
  const kEn = kOf(pit.entry), kEx = kOf(pit.exit), kLine = kOf(0);
  const rel = i => Math.round((i > N / 2 ? i - N : i) * ds);
  const wallDist = i => sg > 0 ? S[i].wallPosDist : S[i].wallNegDist;
  const wallFlag = i => sg > 0 ? S[i].wallPos : S[i].wallNeg;

  // --- API shape
  check(sg === 1 || sg === -1, id, 'side ' + sg);
  check(pit.limitKmh === 80 || pit.limitKmh === 60, id, 'limitKmh ' + pit.limitKmh);
  for (const f of ['laneD', 'wallD', 'inLane', 'contains', 'paved']) check(typeof pit[f] === 'function', id, f + ' is not a function');
  for (const f of ['from', 'to', 'entry', 'exit']) check(Number.isInteger(pit[f]) && pit[f] >= 0 && pit[f] < N, id, f + ' ' + pit[f]);
  check(pit.laneHalfW >= 2.9 && pit.laneHalfW <= 3.6 && pit.wallHalfT > 0.1 && pit.wallHalfT < 1, id, 'laneHalfW / wallHalfT ' + pit.laneHalfW + ' / ' + pit.wallHalfT);
  check(typeof tr.update === 'function', id, 'track.update missing');
  tr.update(0); tr.update(1.23);

  // --- side
  const ds0 = dataSide(td, S);
  if (ds0) check(sg === ds0, id, 'pit on side ' + sg + ' but the pit buildings are on ' + ds0);
  const noSc = buildNoSc(td), sideNoSc = noSc.pit ? noSc.pit.side : 0; noSc.dispose();

  // --- order along the lap
  check(kLine > 0 && kLine <= K, id, 'the line (sample 0) is not inside from..to');
  check(kEn < kEx, id, 'entry after exit');
  let late = false;
  if (!(kEn < kLine && kLine <= kEx)) {
    late = true;
    check(kLine <= kEx && kLine > 0, id, 'the line is not before the exit line');
    warn(id, 'entry line ' + rel(pit.entry) + ' m is after the line (the last-resort layout: no room for the entry before it)');
  }

  // --- the circuit: every point of the complex belongs to this stretch and nothing else
  let nearBad = 0, corrBad = 0, overlap = 0, worstGap = Infinity;
  for (let k = 0; k <= K; k++) {
    const i = wq(pit.from + k), s = S[i], W = wallDist(i) + 0.45;   // (the corridor ends at the wall's outer face)
    for (let a = s.halfW; a <= W; a += 0.5) {
      const x = s.x + s.nx * sg * a, z = s.z + s.nz * sg * a;
      const nr = tr.nearest(x, z);
      if (cyc(nr.index, i) > 3) nearBad++;
      if (!tr.inCorridor(x, z, 0)) corrBad++;
      for (let j = 0; j < N; j++) {
        if (cyc(i, j) <= 60) continue;
        const q = S[j], dx = x - q.x, dz = z - q.z;
        if (Math.abs(dx) > 45 || Math.abs(dz) > 45) continue;
        const dn = dx * q.nx + dz * q.nz, lim = (dn > 0 ? q.wallPosDist : q.wallNegDist) + 0.5;
        const gap = Math.hypot(dx, dz) - lim;
        if (gap < worstGap) worstGap = gap;
        if (gap < 0.3) overlap++;
      }
    }
  }
  check(nearBad === 0, id, nearBad + ' points of the complex are nearer another part of the circuit');
  check(corrBad === 0, id, corrBad + ' points of the complex are outside inCorridor()');
  check(overlap === 0, id, overlap + ' points of the complex are inside (or within 0.3 m of) another part\'s corridor');

  // --- walls: flagged all along, drawn at the exported distance
  const wallMesh = tr.group.children.find(m => m.name === 'walls').geometry.attributes.position.array;
  const wset = new Set();
  for (let v = 0; v < wallMesh.length; v += 3) wset.add(Math.round(wallMesh[v] * 50) + ',' + Math.round(wallMesh[v + 2] * 50));
  let unflagged = 0, undrawn = 0;
  for (let k = 0; k <= K; k++) {
    const i = wq(pit.from + k), s = S[i];
    if (!wallFlag(i)) { unflagged++; continue; }
    const x = s.x + s.nx * sg * wallDist(i), z = s.z + s.nz * sg * wallDist(i);
    let ok = false;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (wset.has((Math.round(x * 50) + a) + ',' + (Math.round(z * 50) + b))) ok = true;
    if (!ok) undrawn++;
  }
  check(unflagged === 0, id, unflagged + ' lane samples without a wall flag on the pit side');
  check(undrawn === 0, id, undrawn + ' lane samples whose outer wall is not drawn at the exported distance');

  // --- boxes
  const B = pit.boxes;
  check(Array.isArray(B) && B.length === 16, id, 'boxes ' + (B && B.length));
  let pitch = Infinity;
  for (let a = 0; a < B.length; a++) {
    const b = B[a], s = S[b.index], k = kOf(b.index), tag = 'box ' + (a + 1);
    check(b.slot === a, id, tag + ' has slot ' + b.slot);
    if (a > 0) check(kOf(b.index) <= kOf(B[a - 1].index), id, tag + ' is downstream of box ' + a + ' (box 1 must be next to the exit)');
    for (let c = 0; c < a; c++) pitch = Math.min(pitch, Math.hypot(b.x - B[c].x, b.z - B[c].z));
    check(k >= kEn && k <= kEx && pit.inLane(b.index, b.d), id, tag + ' is not between the entry and exit lines in the lane');
    const loc = tr.locate(b.x, b.z, b.index);
    check(cyc(loc.index, b.index) <= 1 && Math.abs(loc.d - b.d) < 0.3, id, tag + ' index / d do not match x, z');
    check(Math.abs(b.y - tr.surfaceY(loc.index, loc.d)) < 0.08, id, tag + ' y ' + f1(b.y) + ' vs surface ' + f1(tr.surfaceY(loc.index, loc.d)));
    const hd = Math.atan2(Math.sin(b.heading - Math.atan2(s.tx, s.tz)), Math.cos(b.heading - Math.atan2(s.tx, s.tz)));
    check(Math.abs(hd) < 0.02, id, tag + ' heading off the lane by ' + hd.toFixed(3));
    const lane = Math.abs(pit.laneD(b.index)), ad = Math.abs(b.d);
    check(Math.sign(b.d) === sg && ad - 1.0 >= lane + pit.laneHalfW - 1e-6, id, tag + ' car reaches into the driving lane (|d| ' + f1(ad) + ', lane edge ' + f1(lane + pit.laneHalfW) + ')');
    check(ad + 1.0 <= wallDist(b.index) - 0.3, id, tag + ' car within 0.3 m of the garage face');
    // the car standing in the box: every corner on the lane's asphalt, in the lane
    const fx = Math.sin(b.heading), fz = Math.cos(b.heading), lx = Math.cos(b.heading), lz = -Math.sin(b.heading);
    for (const [al, le] of [[2.8, 1], [2.8, -1], [-2.7, 1], [-2.7, -1]]) {
      const x = b.x + fx * al + lx * le, z = b.z + fz * al + lz * le, l2 = tr.locate(x, z, b.index);
      check(pit.contains(x, z) && pit.inLane(l2.index, l2.d), id, tag + ' car corner off the lane asphalt');
    }
    // reachable: from the lane centre 20 m upstream straight into the box, the car's centre and sides on asphalt
    const i0 = wq(b.index - Math.round(20 / ds)), s0 = S[i0], d0 = pit.laneD(i0);
    let blocked = 0;
    for (let f = 0; f <= 1; f += 0.02) {
      const x = s0.x + s0.nx * d0 + (b.x - s0.x - s0.nx * d0) * f, z = s0.z + s0.nz * d0 + (b.z - s0.z - s0.nz * d0) * f;
      const l2 = tr.locate(x, z, b.index);
      for (const e of [-1, 0, 1]) if (!pit.paved(l2.index, l2.d + e)) blocked++;
    }
    check(blocked === 0, id, tag + ' not reachable from the lane centre over asphalt (' + blocked + ')');
  }
  check(pitch >= 6.99, id, 'two boxes only ' + f1(pitch) + ' m apart');

  // --- curtains: along-lane position (m from `from`) of every vertex of the light curtains as drawn, the box outlines
  //     (box length along) and the car stopped anywhere js/pit.js serves it (origin within BOX_ALONG of the box point)
  const sOf = (x, z, hint) => { const l = tr.locate(x, z, hint), s = S[l.index]; return kOf(l.index) * ds + (x - s.x) * s.tx + (z - s.z) * s.tz; };
  const cMesh = tr.group.children.find(m => m.name === 'pitCurtains');
  let boxClr = Infinity, carClr = Infinity;
  if (check(!!cMesh, id, 'no pitCurtains mesh')) {
    const cp = cMesh.geometry.attributes.position.array, cur = [[Infinity, -Infinity], [Infinity, -Infinity]];   // entry, exit
    const sEn = kEn * ds, sEx = kEx * ds;
    const dq = (i, x, z) => (S[i].x - x) ** 2 + (S[i].z - z) ** 2;
    for (let v = 0; v < cp.length; v += 3) {
      const ex = dq(pit.exit, cp[v], cp[v + 2]) < dq(pit.entry, cp[v], cp[v + 2]);
      const s = sOf(cp[v], cp[v + 2], ex ? pit.exit : pit.entry), c = cur[ex ? 1 : 0];
      c[0] = Math.min(c[0], s); c[1] = Math.max(c[1], s);
    }
    check(Math.abs(cur[0][0] - sEn) < 2 && Math.abs(cur[0][1] - sEn) < 2 && Math.abs(cur[1][0] - sEx) < 2 && Math.abs(cur[1][1] - sEx) < 2, id,
      'the curtains are not drawn at the entry / exit lines (' + cur.map(c => f1(c[0]) + '..' + f1(c[1])).join(', ') + ' vs ' + f1(sEn) + ', ' + f1(sEx) + ')');
    // clearance of the along-lane span [lo, hi] to both curtains (negative: overlapping one)
    const clr = (lo, hi) => Math.min(lo - cur[0][1], cur[1][0] - hi);
    for (const b of B) {
      const sb = sOf(b.x, b.z, b.index), half = (pit.boxLen || 7) / 2;
      boxClr = Math.min(boxClr, clr(sb - half, sb + half));
      carClr = Math.min(carClr, clr(sb - BOX_ALONG - 2.7, sb + BOX_ALONG + 2.8));
    }
    check(boxClr >= BOX_CLEAR, id, 'a painted box is ' + f1(boxClr) + ' m from a light curtain (at least ' + BOX_CLEAR + ')');
    check(carClr >= CAR_CLEAR, id, 'a car stopped in a box can be ' + f1(carClr) + ' m from a light curtain (at least ' + CAR_CLEAR + ')');
  }

  // --- the lane centre as a path at the limit
  const v = pit.limitKmh / 3.6, aMax = pit.limitKmh > 60 ? 8.05 : 12.05;
  const P = [];
  for (let k = 0; k <= K; k++) { const i = wq(pit.from + k), s = S[i], d = pit.laneD(i); P.push([s.x + s.nx * d, s.z + s.nz * d, i, d]); }
  let latMax = 0, lat80 = 0, clrWall = Infinity, clrOut = Infinity, offAsphalt = 0, noseClr = Infinity;
  for (let k = 2; k <= K - 2; k++) {
    const a = P[k - 2], b = P[k], c = P[k + 2];
    const ax = b[0] - a[0], az = b[1] - a[1], bx = c[0] - a[0], bz = c[1] - a[1];
    const kap = 2 * Math.abs(ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(c[0] - b[0], c[1] - b[1]));
    latMax = Math.max(latMax, kap * v * v); lat80 = Math.max(lat80, kap * (80 / 3.6) ** 2);
  }
  for (let k = 0; k <= K; k++) {
    const i = P[k][2], d = P[k][3], ad = Math.abs(d), w = pit.wallD(i);
    check(Number.isFinite(d) && Math.sign(d) === sg || Math.abs(d) < 1e-9, id, 'laneD at k ' + k + ' = ' + d);
    if (Number.isFinite(w)) clrWall = Math.min(clrWall, ad - 1.0 - (Math.abs(w) + pit.wallHalfT));
    clrOut = Math.min(clrOut, wallDist(i) - (ad + 1.0));
    if (!(pit.paved(i, d) || ad <= S[i].halfW)) offAsphalt++;
  }
  // the pit wall's upstream nose: the lane centre passes it with room for the car
  const kw = [...Array(K + 1).keys()].filter(k => Number.isFinite(pit.wallD(wq(pit.from + k))));
  check(kw.length > 0, id, 'no pit wall');
  if (kw.length) {
    const k0 = kw[0], k1 = kw[kw.length - 1];
    check(kw.length === k1 - k0 + 1, id, 'the pit wall has gaps');
    check(k0 < kEn && k1 > kEx, id, 'the pit wall does not cover entry..exit (' + k0 + '..' + k1 + ' vs ' + kEn + '..' + kEx + ')');
    for (const kk of [k0, k1]) { const i = wq(pit.from + kk); noseClr = Math.min(noseClr, Math.abs(pit.laneD(i)) - pit.laneHalfW - (Math.abs(pit.wallD(i)) + pit.wallHalfT)); }
    check(noseClr >= -1e-6, id, 'the lane cuts into the pit wall end by ' + f1(-noseClr) + ' m');
  }
  check(latMax <= aMax, id, 'lane centre needs ' + f1(latMax) + ' m/s^2 at ' + pit.limitKmh + ' km/h');
  check(clrWall >= 1.0, id, 'car on the lane centre passes the pit wall at ' + f1(clrWall) + ' m');
  check(clrOut >= 0.5, id, 'car on the lane centre passes the outer wall at ' + f1(clrOut) + ' m');
  check(offAsphalt === 0, id, offAsphalt + ' lane centre samples neither on the road nor on the pit asphalt');

  // --- API consistency on a dense grid
  let api = 0, apiEx = '';
  function bad(what) { api++; if (!apiEx) apiEx = what; }
  for (let q = -30; q <= K + 30; q++) {
    const i = wq(pit.from + q), s = S[i], k = kOf(i), inside = k <= K;
    const ld = pit.laneD(i), wd = pit.wallD(i);
    if (inside !== Number.isFinite(ld)) bad('laneD finite outside from..to at ' + q);
    if (!inside && Number.isFinite(wd)) bad('wallD finite outside from..to');
    if (Number.isFinite(wd) && !(Math.abs(ld) - pit.laneHalfW >= Math.abs(wd) + pit.wallHalfT - 1e-6)) bad('lane over the pit wall at ' + q);
    if (inside && k >= kEn && k <= kEx) {
      if (!Number.isFinite(wd)) bad('no pit wall between the lines at ' + q);
      if (!pit.inLane(i, ld)) bad('lane centre not inLane at ' + q);
    }
    for (let lon = 0; lon < 2; lon += 0.9) {
      for (let a = -12; a <= 32; a += 0.25) {
        const d = sg * a, x = s.x + s.nx * d + s.tx * lon, z = s.z + s.nz * d + s.tz * lon;
        const loc = tr.locate(x, z, i), ii = loc.index, dd = loc.d, kk = kOf(ii), aa = dd * sg;
        const il = pit.inLane(ii, dd), pv = pit.paved(ii, dd), ct = pit.contains(x, z), w2 = pit.wallD(ii);
        const nr = tr.nearest(x, z);
        if (nr.index === ii && ct !== pv) bad('contains != paved at ' + q + ' ' + a);
        if (il && !pv) bad('inLane but not paved at ' + q + ' ' + a);
        if (il && !(kk >= kEn && kk <= kEx)) bad('inLane outside the lines');
        if (il && !(Number.isFinite(w2) && aa >= Math.abs(w2) + pit.wallHalfT - 1e-9 && aa <= wallDist(ii) + 1e-9)) bad('inLane outside the walls at ' + q + ' ' + a);
        if (Number.isFinite(w2) && Math.abs(aa - Math.abs(w2)) < pit.wallHalfT - 1e-6 && (il || pv)) bad('inside the pit wall counts as lane at ' + q + ' ' + a);
        if (Math.abs(dd) <= S[ii].halfW && (il || pv)) bad('the racing surface counts as pit lane at ' + q + ' ' + a);
        if (aa <= 0 && (il || pv)) bad('the other side counts as pit lane');
        if (kk > K && (il || pv || ct)) bad('outside from..to counts as pit lane');
        if (pv && aa > wallDist(ii) + 1e-6) bad('paved beyond the outer wall at ' + q + ' ' + a);
      }
    }
  }
  check(api === 0, id, api + ' API inconsistencies, e.g. ' + apiEx);

  // --- nothing else changed: samples against git HEAD, the rest against the v5 baseline
  //     (adapted, see the top: trN = the new js/track.js on the track without its bankOverrides)
  const tdN = Object.assign({}, td); delete tdN.bankOverrides;
  const trN = td.bankOverrides ? buildNew(tdN) : tr, SN = trN.samples;
  if (td.bankOverrides) {
    // with / without the overrides: only bank, only near the sections
    const near = new Uint8Array(N), ramp = Math.ceil(36 / ds);
    for (const o of td.bankOverrides) {
      const a = Math.round(o.from * N), b = Math.round(o.to * N), len = ((b - a) % N + N) % N;
      for (let q = -ramp - 40; q <= len + ramp + 40; q++) near[wq(a + q)] = 1;   // (+-40 samples: the ends are placed on the samples)
    }
    let other = 0, otherEx = '', banked = 0;
    for (let i = 0; i < N; i++) {
      for (const key of Object.keys(S[i])) {
        if (S[i][key] === SN[i][key]) continue;
        if (key === 'bank' && near[i]) { banked++; continue; }
        other++; if (!otherEx) otherEx = 'sample ' + i + ' ' + key + ' ' + SN[i][key] + ' -> ' + S[i][key];
      }
    }
    check(banked > 0, id, 'bankOverrides change nothing');
    check(other === 0, id, other + ' sample fields differ between the builds with / without bankOverrides other than bank on the banked sections, e.g. ' + otherEx);
  }
  const head = buildHead(tdN), HS = head.samples;
  check(HS.length === N && head.length === tr.length, id, 'sample count / length changed');
  let fieldDiff = 0, fieldEx = '', wallMoved = 0, keysDiff = 0;
  for (let i = 0; i < Math.min(N, HS.length); i++) {
    const a = HS[i], b = SN[i], lane = inLaneIdx(i);
    if (Object.keys(a).join() !== Object.keys(b).join()) keysDiff++;
    for (const key of Object.keys(a)) {
      if (a[key] === b[key]) continue;
      const pitSide = (sg > 0 && (key === 'wallPosDist' || key === 'wallPos')) || (sg < 0 && (key === 'wallNegDist' || key === 'wallNeg'));
      if (lane && pitSide && (typeof a[key] === 'boolean' ? b[key] === true : b[key] >= a[key])) { if (typeof a[key] === 'number') wallMoved++; continue; }
      fieldDiff++; if (!fieldEx) fieldEx = 'sample ' + i + ' ' + key + ' ' + a[key] + ' -> ' + b[key];
    }
  }
  check(fieldDiff === 0, id, fieldDiff + ' sample fields differ from HEAD, e.g. ' + fieldEx);
  check(keysDiff === 0, id, keysDiff + ' samples with other fields than HEAD');
  head.dispose();

  const v5 = buildV5(tdN), VS = v5.samples;
  check(JSON.stringify(v5.grid) === JSON.stringify(tr.grid), id, 'track.grid differs from v5');
  check(JSON.stringify(v5.crossings) === JSON.stringify(tr.crossings), id, 'crossings differ from v5');
  // a v5 kerb triangle (red / white) lying on the pit side's kerb strip within from..to (the lane's asphalt is there now)
  function pitKerbTri(pos, col, t) {
    const r = col[t], g = col[t + 1], b = col[t + 2];
    const red = Math.abs(r - 0xd0 / 255) < 1e-3 && Math.abs(g - 0x20 / 255) < 1e-3, white = Math.abs(r - 0xf2 / 255) < 1e-3 && Math.abs(b - 0xf2 / 255) < 1e-3;
    if (!red && !white) return false;
    const cx = (pos[t] + pos[t + 3] + pos[t + 6]) / 3, cz = (pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3, n = trN.nearest(cx, cz);
    const k = kOf(n.index), a = n.d * sg, hw = SN[n.index].halfW;
    return (k <= K + 1 || k >= N - 1) && a > hw - 0.01 && a < hw + 1.31;
  }
  const meshOf = (t, n) => t.group.children.find(m => m.name === n);
  const tri = t => t.group.children.reduce((acc, m) => acc + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
  for (const name of ['road', 'paint']) {
    const a = meshOf(v5, name).geometry.attributes, b = meshOf(trN, name).geometry.attributes;
    let diff = 0, removed = 0;
    if (name === 'road') {
      for (const att of Object.keys(a)) {
        const x = a[att].array, y = b[att].array;
        if (y.length < x.length) { diff++; continue; }
        for (let u = 0; u < x.length; u++) if (x[u] !== y[u]) { diff++; break; }
      }
    } else {
      // walk both triangle lists: equal triangles advance both, a v5 pit-side kerb triangle may be skipped
      const xp = a.position.array, yp = b.position.array, xc = a.color.array, yc = b.color.array, xn = a.normal.array, yn = b.normal.array;
      let w = 0;
      for (let v = 0; v < xp.length; v += 9) {
        let same = w + 9 <= yp.length;
        for (let u = 0; same && u < 9; u++) if (xp[v + u] !== yp[w + u] || xc[v + u] !== yc[w + u] || xn[v + u] !== yn[w + u]) same = false;
        if (same) { w += 9; continue; }
        if (pitKerbTri(xp, xc, v)) { removed++; continue; }
        diff++; break;
      }
    }
    check(diff === 0, id, 'the v5 ' + name + ' mesh (less the pit-side kerb triangles on the lane) is not an unchanged prefix of the new one');
    if (name === 'paint') kerbsOff = removed;
  }
  let fnDiff = 0, fnEx = '';
  const trQ = tr; tr = trN;          // the queries: the build without the bankOverrides against v5
  for (let i = 0; i < N; i += 2) {
    const s = S[i];
    for (const d of [-s.halfW + 0.05, -3.3, 0, 2.2, s.halfW - 0.05]) {
      const x = s.x + s.nx * d + s.tx * 0.7, z = s.z + s.nz * d + s.tz * 0.7;
      const r1 = [tr.locate(x, z, i), tr.locate(x, z, -1), tr.nearest(x, z), tr.surfaceY(i, d), tr.groundY(x, z), tr.inCorridor(x, z, 0)];
      const r0 = [v5.locate(x, z, i), v5.locate(x, z, -1), v5.nearest(x, z), v5.surfaceY(i, d), v5.groundY(x, z), v5.inCorridor(x, z, 0)];
      if (JSON.stringify(r0) !== JSON.stringify(r1)) { fnDiff++; if (!fnEx) fnEx = 'sample ' + i + ' d ' + d + ': ' + JSON.stringify(r0) + ' vs ' + JSON.stringify(r1); }
    }
    // the other side's runoff and walls are untouched too
    const o = -sg * (sg > 0 ? s.wallNegDist : s.wallPosDist) * 0.9;
    const x = s.x + s.nx * o, z = s.z + s.nz * o;
    if (v5.groundY(x, z) !== tr.groundY(x, z) || v5.inCorridor(x, z, 0) !== tr.inCorridor(x, z, 0)) { fnDiff++; if (!fnEx) fnEx = 'other side at sample ' + i; }
  }
  tr = trQ;
  check(fnDiff === 0, id, fnDiff + ' queries on the racing surface answer differently from v5, e.g. ' + fnEx);
  if (trN !== tr) trN.dispose();
  const triV5 = tri(v5), triNew = tri(tr);
  v5.dispose();

  // --- build time against HEAD (median of 3, after a warm-up)
  const tH = [], tN = [];
  for (let r = 0; r < 3; r++) {
    let t0 = process.hrtime.bigint(); buildHead(td).dispose(); tH.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint(); buildNew(td).dispose(); tN.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  rows.push({ id, name: td.name.slice(0, 22), side: sg > 0 ? '+n' : '-n', data: ds0 ? (ds0 > 0 ? '+n' : '-n') : '', noData: sideNoSc === sg ? '' : (sideNoSc > 0 ? '+n' : '-n'),
    kmh: pit.limitKmh, lane: 2 * pit.laneHalfW, from: rel(pit.from), entry: rel(pit.entry), exit: rel(pit.exit), to: rel(pit.to), m: Math.round(K * ds),
    pitch: f1(pitch), boxCur: f1(boxClr), carCur: f1(carClr), a80: f1(lat80), aLim: f1(latMax), wallClr: f1(clrWall), outClr: f1(clrOut), gap: f1(worstGap), moved: wallMoved,
    msHead: median(tH).toFixed(0), msNew: median(tN).toFixed(0), tris: '+' + (triNew - triV5), kerbsOff });
  tr.dispose();
}
console.table(rows);
console.log('columns: side = pit side (+n = driver\'s left), data = side of the pit buildings in scenery-data.js, noData = side chosen when');
console.log('  scenery-data.js is not loaded (blank = the same), kmh = limit, lane = driving lane width (m), from / entry / exit / to = m from');
console.log('  the line, m = lane length incl. tapers, pitch = box spacing, boxCur / carCur = closest painted box / car stopped in a');
console.log('  box to a light curtain (m along the lane), a80 / aLim = lateral acceleration on the lane centre at');
console.log('  80 km/h / at the limit (m/s^2), wallClr / outClr = car (2 m wide) on the lane centre to the pit wall / outer wall,');
console.log('  gap = closest approach of the complex to another part\'s corridor, moved = samples whose pit-side wall moved out,');
console.log('  ms = build time HEAD / new, tris = triangles added, kerbsOff = v5 kerb triangles no longer drawn on the lane asphalt');
const tot = rows.reduce((a, r) => [a[0] + +r.msHead, a[1] + +r.msNew], [0, 0]);
console.log('build time, all tracks: HEAD ' + tot[0].toFixed(0) + ' ms, new ' + tot[1].toFixed(0) + ' ms');
console.log(rows.length + ' tracks, ' + warns + ' warnings, ' + (fails ? fails + ' FAILURES in ' + [...failed].join(' ') : 'all pit checks passed'));
process.exit(fails ? 1 : 0);
