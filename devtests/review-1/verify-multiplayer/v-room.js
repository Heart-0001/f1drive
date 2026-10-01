// Verifier probe: open-room (seats held from two non-loopback addresses, idle seats, reconnect after a flood kick),
// track-then-start (window), leave-during-create (how long the create window really is).
// node devtests/review-1/verify-multiplayer/v-room.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// localAddress 127.0.0.x (x > 1) is NOT loopback for server.js isLoopback(), so per-IP limits apply as for a remote peer
function client(port, name, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port, { localAddress: opts.from });
    const c = { ws, id: 0, err: null, closed: null, msgs: 0 };
    ws.on('message', (d) => {
      c.msgs++;
      const m = JSON.parse(d.toString());
      if (m.t === 'welcome') { c.id = m.id; resolve(c); }
      if (m.t === 'error') { c.err = m.code; }
    });
    ws.on('close', (code) => { c.closed = code; resolve(c); });
    ws.on('error', () => {});
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name, token: opts.token })));
  });
}

(async () => {
  // ---------- open-room
  const srv = await createServer({ port: 0, hostToken: 'tok', log: () => {} });
  const host = await client(srv.port, 'host', { token: 'tok' });
  const squat = [];
  for (let i = 0; i < 8; i++) squat.push(await client(srv.port, 'a' + i, { from: '127.0.0.2' }));
  for (let i = 0; i < 8; i++) squat.push(await client(srv.port, 'b' + i, { from: '127.0.0.3' }));
  const seated = squat.filter(c => c.id > 0).length;
  const friend = await client(srv.port, 'friend', { from: '127.0.0.4' });
  console.log('squatters seated from 2 addresses:', seated, '; room size', srv.info().players.length, '; friend ->', friend.err || ('id ' + friend.id));
  console.log('waiting 11 s (two heartbeat rounds) with the squatters silent ...');
  await sleep(11000);
  console.log('after 11 s silent: squatters still open', squat.filter(c => c.ws.readyState === 1).length, '; room size', srv.info().players.length);
  squat.forEach(c => c.ws.terminate());
  await sleep(200);

  // flood kick, then reconnect from the same address
  const fl = await client(srv.port, 'flood', { from: '127.0.0.5' });
  let n = 0;
  const t0 = Date.now();
  while (fl.ws.readyState === 1 && Date.now() - t0 < 3000) { for (let i = 0; i < 200; i++) { try { fl.ws.send('{"t":"ping","c":1}'); n++; } catch (e) {} } await sleep(1); }
  await sleep(1200);
  const again = await client(srv.port, 'flood2', { from: '127.0.0.5' });
  console.log('flood client closed', fl.closed, 'after', n, 'frames; same address rejoins at once:', again.id > 0);
  again.ws.terminate(); host.ws.terminate();
  await srv.close();

  // ---------- track-then-start
  const s2 = await createServer({ port: 0, hostToken: 'tok', log: () => {} });
  const seen = [];
  const h = await new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + s2.port);
    ws.on('message', d => {
      const m = JSON.parse(d); const t = Date.now();
      if (m.t === 'welcome') resolve(ws);
      if (m.t === 'track') seen.push({ t, e: 'track:' + m.id });
      if (m.t === 'gp') seen.push({ t, e: 'gp:' + m.s.phase });
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name: 'h', token: 'tok' })));
  });
  const T0 = Date.now();
  h.send(JSON.stringify({ t: 'track', id: 'monza' }));
  await sleep(700);                                       // host loads Monza, Esc, clicks Monaco
  h.send(JSON.stringify({ t: 'track', id: 'monaco' }));
  await sleep(150);                                       // clicks 開始大獎賽
  h.send(JSON.stringify({ t: 'gp', a: 'start', q: 1, r: 1, len: 5793 }));
  await sleep(1500);
  console.log('track-then-start:', seen.map(x => (x.t - T0) + 'ms ' + x.e).join(', '));
  // the same with the start 1.1 s after the first pick (outside the window)
  seen.length = 0;
  await sleep(1200);
  const T1 = Date.now();
  h.send(JSON.stringify({ t: 'gp', a: 'end' }));
  h.send(JSON.stringify({ t: 'track', id: 'spa' }));
  await sleep(1100);
  h.send(JSON.stringify({ t: 'gp', a: 'start', q: 1, r: 1, len: 7004 }));
  await sleep(300);
  console.log('pick then start after 1.1 s:', seen.map(x => (x.t - T1) + 'ms ' + x.e).join(', '));
  h.terminate();
  await s2.close();

  // ---------- leave-during-create: how long net/host.js startServer really awaits (fixed port, like the game)
  const times = [];
  for (let i = 0; i < 5; i++) {
    const a = process.hrtime.bigint();
    const s = await createServer({ port: 24600 + i, hostToken: 'x' });
    times.push(Number(process.hrtime.bigint() - a) / 1e6);
    await s.close();
  }
  console.log('createServer() bind times (ms):', times.map(v => v.toFixed(2)).join(', '));
})();
