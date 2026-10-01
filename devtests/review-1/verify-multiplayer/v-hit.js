// Verifier probe: hit-spam. (1) the server relays forged impacts; (2) what the victim's game does with them,
// replaying main.js onRemoteHit() (copied verbatim below, main.js is not loaded) with the real js/collide.js.
// node devtests/review-1/verify-multiplayer/v-hit.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
require(path.join(ROOT, 'js', 'collide.js'));
const F1 = globalThis.F1;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function client(port, name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const c = { ws, id: 0, hits: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'welcome') { c.id = m.id; resolve(c); }
      if (m.t === 'hit') c.hits.push({ t: Date.now(), from: m.from, i: m.i });
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name, token })));
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));

// ---- main.js constants and onRemoteHit, copied (lines 57-58, 362-380)
const HIT_MEMORY_MS = 400, HIT_RANGE = 15;
function makeVictim() {
  const car = { state: { x: 0, z: 0, heading: 0, speed: 60 } };
  const impacts = {};
  function onRemoteHit(from, imp, now, other) {
    const o = other, dx = o.x - car.state.x, dz = o.z - car.state.z;
    if (dx * dx + dz * dz > HIT_RANGE * HIT_RANGE) return;
    const mag = Math.sqrt(imp[0] * imp[0] + imp[1] * imp[1]);
    if (!(mag > 0.2)) return;
    const ux = imp[0] / mag, uz = imp[1] / mag;
    const r = impacts[from] || (impacts[from] = { sx: 0, sz: 0, lx: 0, lz: 0, t: 0 });
    if (now - r.t > HIT_MEMORY_MS) { r.lx = 0; r.lz = 0; }
    const already = Math.max(0, r.lx * ux + r.lz * uz);
    const rest = mag - already;
    if (rest < 0.2) return;
    F1.applyCarImpulse(car.state, ux * rest, uz * rest);
    r.lx += ux * rest; r.lz += uz * rest; r.t = now;
    return true;
  }
  return { car, onRemoteHit };
}

(async () => {
  const srv = await createServer({ port: 0, hostToken: 'tok', log: () => {} });
  const host = await client(srv.port, 'host', 'tok');
  const victim = await client(srv.port, 'victim');
  const evil = await client(srv.port, 'evil');
  send(host, { t: 'track', id: 'monza' });
  await sleep(60);
  // victim drives at 60 m/s at (1000, 0, 1000); evil really is 2 km away but reports a pose 10 m beside him
  send(victim, { t: 's', k: 1, c: 1, s: [1000, 0, 1000, 0, 0, 0, 60, 0] });
  send(evil, { t: 's', k: 1, c: 1, s: [-1000, 0, -1000, 0, 0, 0, 0, 0] });
  await sleep(80);
  send(evil, { t: 'hit', k: 1, to: victim.id, i: [0, -80] });
  await sleep(80);
  console.log('relayed while evil is 2.8 km away (as reported):', victim.hits.length);
  send(evil, { t: 's', k: 1, c: 2, s: [1010, 0, 1000, 0, 0, 0, 0, 0] });
  await sleep(80);
  victim.hits.length = 0;
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < 1000) {
    // pattern: straight back against his heading (heading 0 = +z)
    send(evil, { t: 'hit', k: 1, to: victim.id, i: [0, -80] });
    k++;
    await sleep(41);
  }
  await sleep(100);
  console.log('sent', k, 'hits of 80 m/s in 1 s, relayed', victim.hits.length);

  // what the victim's game does with the relayed stream (same timing)
  function replay(hits, label) {
    const v = makeVictim();
    let applied = 0, minSpeed = Infinity, trace = [];
    const base = hits.length ? hits[0].t : 0;
    for (const h of hits) {
      if (v.onRemoteHit(h.from, h.i, h.t, { x: 10, z: 0 })) applied++;
      minSpeed = Math.min(minSpeed, v.car.state.speed);
      trace.push((h.t - base) + 'ms:' + v.car.state.speed.toFixed(0));
    }
    console.log(label, '-> applied', applied, 'of', hits.length, '; speed trace', trace.slice(0, 12).join(' '));
  }
  replay(victim.hits, 'same direction (-80 along heading)');

  // alternating back / forward: every one applies
  victim.hits.length = 0;
  const t1 = Date.now(); let s = 1;
  while (Date.now() - t1 < 1000) { send(evil, { t: 'hit', k: 1, to: victim.id, i: [0, -80 * s] }); s = -s; await sleep(41); }
  await sleep(100);
  replay(victim.hits, 'alternating -80 / +80');

  // the same car ramming legitimately head-on at 2 x 90 m/s: what one real contact asks for
  const st = { x: 0, z: 0, heading: 0, speed: 90 }, contacts = [];
  F1.resolveCarCollisions(st, [{ x: 0, z: 4.5, heading: Math.PI, speed: 90 }], 1 / 120, contacts);
  const j = contacts[0] ? Math.hypot(contacts[0].ix, contacts[0].iz) : 0;
  console.log('one real head-on contact at 90+90 m/s asks for', j.toFixed(1), 'm/s; a rear tap at 10 m/s closing asks for',
    (0.5 * 1.2 * 10).toFixed(1), 'm/s');

  [host, victim, evil].forEach(c => c.ws.close());
  await srv.close();
})();
