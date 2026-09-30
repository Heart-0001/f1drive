const fs = require('fs');
const p = 'C:/Users/user/Desktop/f1drive/js/net.js';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b) {
  const c = s.split(a).length - 1;
  if (c !== 1) throw new Error('expected 1 match, got ' + c + ' for: ' + a.slice(0, 70));
  s = s.replace(a, () => b);
}
rep(`  var SEND_MS = 50;             // own state goes out at 20 Hz`,
    `  var SEND_MS = 45;             // own state goes out at ~20 Hz (every 3rd frame at 60 fps)`);
rep(`  var MAX_EXTRAP = 250;         // ms of dead reckoning when snapshots are late`,
    `  var LEAD = 0.1;               // s: the interpolated pose is pushed forward along its heading by speed * LEAD,
                                //   so a car at 300 km/h is not drawn (and hit) 8 m behind where it really is
  var MAX_EXTRAP = 250;         // ms of dead reckoning when snapshots are late`);
rep(`      _buf: [], _off: null, _recv: 0, _ct: -Infinity`, `      _buf: [], _off: null, _offS: null, _recv: 0, _ct: -Infinity`);
rep(`      r._buf.length = 0; r._off = null;                // the sender's clock restarted`,
    `      r._buf.length = 0; r._off = null; r._offS = null; // the sender's clock restarted`);
rep(`    r._off = r._off === null || Math.abs(d - r._off) > 2000 ? d : Math.min(r._off + 0.2, d);`,
    `    r._off = r._off === null || Math.abs(d - r._off) > 2000 ? d : Math.min(r._off + 0.05, d);`);
rep(`      r._buf.length = 0; r._off = null; r._ct = -Infinity; r.active = false;`,
    `      r._buf.length = 0; r._off = null; r._offS = null; r._ct = -Infinity; r.active = false;`);

const a = s.indexOf('  function sample(r, now) {');
const b = s.indexOf('  function clearPoses() {');
if (a < 0 || b < 0) throw new Error('sample not found');
s = s.slice(0, a) + `  function sample(r, now) {
    var b = r._buf, n = b.length, s = r.state;
    if (!n || now - r._recv > STALE_MS) { r.active = false; return; }
    r.active = true;
    // the playback clock follows the offset estimate gradually, so a correction never shows as a jump
    if (r._offS === null || Math.abs(r._off - r._offS) > 300) r._offS = r._off;
    else r._offS += (r._off - r._offS) * 0.04;
    var rt = now - r._offS - INTERP_DELAY;
    var last = b[n - 1], lead = LEAD;
    if (rt >= last.t) {
      // late: dead-reckon from the newest snapshot for a short while, then stand still
      var over = rt - last.t, ex = Math.min(over, MAX_EXTRAP) / 1000;
      var yaw = 0;
      if (n > 1) {
        var pv = b[n - 2], dtp = (last.t - pv.t) / 1000;
        if (dtp > 0.01 && dtp < 0.5) yaw = Math.max(-2, Math.min(2, wrapPi(last.h - pv.h) / dtp));
      }
      s.x = last.x; s.y = last.y; s.z = last.z;
      s.heading = last.h + yaw * ex; s.pitch = last.p; s.roll = last.r;
      s.speed = last.v; s.steer = last.st;
      lead += ex;
      if (over > MAX_EXTRAP) {                 // gave up predicting: it stays where the prediction ended
        s.x += Math.sin(s.heading) * s.speed * lead;
        s.z += Math.cos(s.heading) * s.speed * lead;
        s.speed = 0;
        return;
      }
    } else {
      var i = n - 1;
      while (i > 0 && b[i - 1].t > rt) i--;
      if (i === 0) {                 // older than everything we have
        var f0 = b[0];
        s.x = f0.x; s.y = f0.y; s.z = f0.z; s.heading = f0.h; s.pitch = f0.p; s.roll = f0.r; s.speed = f0.v; s.steer = f0.st;
      } else {
        var a = b[i - 1], c = b[i], span = c.t - a.t, k = span > 0 ? (rt - a.t) / span : 1;
        if (k < 0) k = 0; else if (k > 1) k = 1;
        s.x = a.x + (c.x - a.x) * k;
        s.y = a.y + (c.y - a.y) * k;
        s.z = a.z + (c.z - a.z) * k;
        s.heading = a.h + wrapPi(c.h - a.h) * k;
        s.pitch = a.p + (c.p - a.p) * k;
        s.roll = a.r + (c.r - a.r) * k;
        s.speed = a.v + (c.v - a.v) * k;
        s.steer = a.st + (c.st - a.st) * k;
      }
    }
    s.x += Math.sin(s.heading) * s.speed * lead;
    s.z += Math.cos(s.heading) * s.speed * lead;
  }

` + s.slice(b);
fs.writeFileSync(p, s);
console.log('ok');
