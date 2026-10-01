// Review probe: js/net.js in node with a stub preload API and the real server.
'use strict';
const path = require('path');
const WS = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'ws'));
const { createServer } = require(path.join(__dirname, '..', '..', '..', 'net', 'server.js'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let srv = null, stops = 0;
  globalThis.WebSocket = WS;
  globalThis.f1host = {
    startServer: async (port) => { await sleep(300); srv = await createServer({ port: 0, hostToken: 'tok' }); return { ok: true, port: srv.port, addresses: [], token: 'tok' }; },
    stopServer: async () => { stops++; if (srv) { await srv.close(); srv = null; } return { ok: true }; }
  };
  const net = require(path.join(__dirname, '..', '..', '..', 'js', 'net.js'));
  const p = net.create(30000);
  await sleep(50);
  net.leave();                                  // the user changes his mind while the room is being created
  console.log('after leave() during create(): connecting =', net.connecting);
  const res = await p;
  await sleep(100);
  console.log('create resolved', res, '-> connected =', net.connected, 'isHost =', net.isHost, 'server running =', !!srv, 'stopServer calls =', stops);
  net.leave();
  await sleep(200);
  console.log('after real leave: connected =', net.connected, 'server running =', !!srv);

  // ---- server: Grand Prix started within 1 s of a second track pick is killed by the deferred pick
  const s2 = await createServer({ port: 0, hostToken: 'tok' });
  const ws = new WS('ws://127.0.0.1:' + s2.port);
  const gps = [];
  ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'gp') gps.push(m.s.phase); if (m.t === 'track') gps.push('track:' + m.id); });
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'hello', v: 1, name: 'h', token: 'tok' }));
  await sleep(50);
  ws.send(JSON.stringify({ t: 'track', id: 'monza' }));
  await sleep(50);
  ws.send(JSON.stringify({ t: 'track', id: 'monaco' }));          // deferred (rate limit)
  await sleep(50);
  ws.send(JSON.stringify({ t: 'gp', a: 'start', q: 2, r: 3, len: 3337 }));   // host means: on Monaco
  await sleep(1500);
  console.log('host picks monza, monaco, then start within 1 s ->', gps.join(' , '));
  ws.close(); await s2.close();
})();
