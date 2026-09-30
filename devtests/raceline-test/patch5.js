const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
function rep(o,n){ if(!s.includes(o)) throw new Error('missing: '+o.slice(0,60)); s=s.replace(o,n); }
// constants from CAR_PERF when available
rep(`  var GRAV = 9.81;
`,`  var GRAV = 9.81;
  var BANK_GRIP = 2.0;        // lateral grip change = BANK_GRIP * g * sin(bank into the turn)

  // car.js publishes its tuning as F1.CAR_PERF; prefer that over the copies above.
  function syncCarPerf() {
    var p = F1.CAR_PERF;
    if (!p) return;
    function pick(v, fb) { return typeof v === 'number' && v === v ? v : fb; }
    TOP_SPEED = pick(p.topSpeed, TOP_SPEED); DRAG_K = pick(p.dragK, DRAG_K); ROLL = pick(p.roll, ROLL);
    TRACTION = pick(p.traction, TRACTION); POWER = pick(p.power, POWER);
    BRAKE_BASE = pick(p.brakeBase, BRAKE_BASE); BRAKE_AERO = pick(p.brakeAero, BRAKE_AERO);
    LAT_BASE = pick(p.latBase, LAT_BASE); LAT_AERO = pick(p.latAero, LAT_AERO); LAT_MAX = pick(p.latMax, LAT_MAX);
    GRAV = pick(p.gravity, GRAV); BANK_GRIP = pick(p.bankGrip, BANK_GRIP);
  }
`);
rep(`  function cornerSpeed(k) {
    k = Math.abs(k);
    if (k < 1e-6) return TOP_SPEED;
    var v2 = LAT_MAX * GRIP_MARGIN / k;
    var ka = k - LAT_AERO * GRIP_MARGIN;
    if (ka > 0) v2 = Math.min(v2, LAT_BASE * GRIP_MARGIN / ka);`,
`  // extra = grip change from banking (m/s^2, positive = banked into the turn).
  function cornerSpeed(k, extra) {
    k = Math.abs(k);
    if (k < 1e-6) return TOP_SPEED;
    var v2 = Math.max(1, LAT_MAX + extra) * GRIP_MARGIN / k;
    var ka = k - LAT_AERO * GRIP_MARGIN;
    if (ka > 0) v2 = Math.min(v2, Math.max(1, LAT_BASE + extra) * GRIP_MARGIN / ka);`);
rep(`    var THREE = global.THREE;
    var S = track.samples, N = S.length, i, j;`,`    var THREE = global.THREE;
    syncCarPerf();
    var S = track.samples, N = S.length, i, j;`);
rep(`      vCorner[i] = cornerSpeed(k);`,`      // banking: bank > 0 means the +n (left) side is higher; curv < 0 is a left turn
      var bk = S[i].bank || 0, extra = 0;
      if (bk !== 0 && k > 1e-4) {
        extra = BANK_GRIP * GRAV * Math.sin(bk) * (curv[i] < 0 ? -1 : 1);
        if (extra > 0) extra *= 0.5;          // only half credit for helpful banking
      }
      vCorner[i] = cornerSpeed(k, extra);`);
fs.writeFileSync(f,s);
