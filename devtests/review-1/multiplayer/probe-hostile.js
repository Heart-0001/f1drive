// Review probe: hostile wire input against the real server (prototype keys, type confusion, floods, reconnect churn).
'use strict';
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'ws'));
const { createServer } = require(path.join(__dirname, '..', '..', '..', 'net', 'server.js'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function client(port, name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const c = { ws, id: 0, msgs: [], closeCode: null, closeReason: '' };
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); c.msgs.push(m); if (m.t === 'welcome') { c.id = m.id; resolve(c); } });
    ws.on('close', (code, reason) => { c.closeCode = code; c.closeReason = reason.toString(); });
    ws.on('error', () => {});
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name, token })));
  });
}
const raw = (c, s) => c.ws.send(s);
const send = (c, m) => c.ws.send(JSON.stringify(m));

(async () => {
  const logs = [];
  const srv = await createServer({ port: 0, hostToken: 'tok', log: (s) => logs.push(s) });
  const host = await client(srv.port, 'host', 'tok');
  const evil = await client(srv.port, 'evil');
  send(host, { t: 'track', id: 'x' });
  await sleep(60);

  const bad = [
    '{"t":"hit","k":1,"to":"__proto__","i":[1,1]}',
    '{"t":"hit","k":1,"to":"constructor","i":[1,1]}',
    '{"t":"s","k":1,"c":1,"s":{"length":8,"0":1}}',
    '{"t":"s","k":1,"c":1,"s":[1,1,1,1,1,1,1,{"valueOf":1}]}',
    '{"t":"s","k":1,"c":1e400,"s":[1,1,1,1,1,1,1,1]}',
    '{"t":"gl","k":1,"sid":"1","time":"12"}',
    '{"t":"gl","k":1,"sid":1,"time":{"__proto__":{"x":1}}}',
    '{"t":"gp","a":{"toString":1}}',
    '{"t":"gp","a":"start","q":{},"r":[],"len":"5000","wear":null}',
    '{"t":"profile","name":{"__proto__":null},"colour":["#ffffff"],"car":{"a":1}}',
    '{"t":"profile","name":"\\u202e\\u0000abc\\u200b","colour":"#FFFFFF"}',
    '{"t":"lap","last":"1","best":1e309}',
    '{"t":"year","y":"2020"}',
    '{"t":"track","id":"../../etc"}',
    '{"__proto__":{"polluted":1},"t":"ping","c":1}',
    '{"t":"ping","c":{"__proto__":{"polluted":2}}}',
    '{"t":"hello","v":1,"name":"again"}',
    '{"t":{"a":1}}',
    '[]', 'null', '1', '"s"', '{', '{"t":"s","s":' + '['.repeat(900) + ']'.repeat(900) + '}',
    '{"t":"hit","k":1,"to":' + '1'.repeat(400) + ',"i":[1,1]}'
  ];
  for (const b of bad) raw(evil, b);
  raw(evil, Buffer.from([1, 2, 3]));                     // binary frame
  await sleep(200);
  console.log('Object.prototype.polluted =', ({}).polluted, '; evil still connected:', evil.ws.readyState === 1);
  console.log('server logged errors:', logs.filter(s => /error/.test(s)));
  const rosters = evil.msgs.filter(m => m.t === 'players');
  console.log('last roster names:', JSON.stringify(rosters[rosters.length - 1].players.map(p => p.name)));

  // oversized frame -> ws closes 1009 for that client only
  const big = await client(srv.port, 'big');
  raw(big, '{"t":"s","x":"' + 'a'.repeat(3000) + '"}');
  await sleep(200);
  console.log('oversized: big closed with', big.closeCode, '; host still connected:', host.ws.readyState === 1);

  // flood: how many frames before the kick, does the server keep serving
  const flood = await client(srv.port, 'flood');
  let sent = 0;
  const t0 = Date.now();
  while (flood.ws.readyState === 1 && Date.now() - t0 < 4000) {
    for (let i = 0; i < 100 && flood.ws.readyState === 1; i++) { send(flood, { t: 'ping', c: sent++ }); }
    await sleep(1);
  }
  await sleep(1200);
  console.log('flood: sent', sent, 'closed with', flood.closeCode, JSON.stringify(flood.closeReason), 'in', Date.now() - t0, 'ms');

  // reconnect churn from one IP: no ban, so the same address can repeat the flood at once
  const churn = await client(srv.port, 'flood2');
  console.log('reconnect after flood kick accepted:', churn.id > 0);

  // idle seat-holder: a client that never sends anything but answers pings (ws does that itself) keeps its seat
  const idle = await client(srv.port, 'idle');
  await sleep(11000);
  console.log('idle client still seated after 11 s:', idle.ws.readyState === 1, 'players', srv.info().players.length);

  [host, evil, big, flood, churn, idle].forEach(c => { try { c.ws.close(); } catch (e) {} });
  await srv.close();
})();
