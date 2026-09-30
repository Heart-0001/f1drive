// node test/server.test.js — tests for net/server.js with real `ws` clients, plus js/net.js address parsing.
'use strict';
const assert = require('assert');
const WebSocket = require('ws');
const { createServer } = require('../net/server.js');
const netClient = require('../js/net.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;

// A test client that records every message.
function client(port, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const c = { ws, msgs: [], closed: null, id: 0 };
    c.send = o => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
    c.last = t => { for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === t) return c.msgs[i]; return null; };
    c.all = t => c.msgs.filter(m => m.t === t);
    c.wait = async (pred, ms) => {
      const end = Date.now() + (ms || 2000);
      while (Date.now() < end) { const r = pred(); if (r) return r; await sleep(10); }
      throw new Error('timeout waiting for ' + pred);
    };
    ws.on('message', d => { try { c.msgs.push(JSON.parse(d.toString())); } catch (e) { c.msgs.push({ t: '?raw' }); } });
    ws.on('close', (code, reason) => { c.closed = { code, reason: reason.toString() }; });
    ws.on('error', () => {});
    ws.on('open', async () => {
      if (hello === false) { resolve(c); return; }
      c.send(Object.assign({ t: 'hello', v: 1, name: 'P', colour: '#112233' }, hello || {}));
      try {
        await c.wait(() => c.last('welcome') || c.closed);
        const w = c.last('welcome');
        if (w) c.id = w.id;
        resolve(c);
      } catch (e) { reject(e); }
    });
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}
const state = (x, v) => ({ t: 's', k: 0, c: Date.now(), s: [x, 0, 0, 0, 0, 0, v || 0, 0] });

async function test(name, fn) {
  let srv = null;
  const ctx = { start: async o => (srv = await createServer(Object.assign({ port: 0, host: '127.0.0.1' }, o))) };
  try { await fn(ctx); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
  finally { if (srv) await srv.close(); }
}

(async () => {
  await test('join / roster / leave', async t => {
    const srv = await t.start();
    const a = await client(srv.port, { name: 'Alice' });
    assert.strictEqual(a.last('welcome').host, a.id, 'first player is host on a dedicated server');
    assert.strictEqual(a.last('welcome').track, null);
    const b = await client(srv.port, { name: 'Bob', colour: '#ABCDEF' });
    await a.wait(() => a.last('players').players.length === 2);
    const ros = a.last('players').players;
    assert.deepStrictEqual(ros.map(p => p.name), ['Alice', 'Bob']);
    assert.deepStrictEqual(ros.map(p => p.slot), [0, 1]);
    assert.strictEqual(ros[1].colour, '#abcdef');
    b.ws.close();
    await a.wait(() => a.last('players').players.length === 1);
    assert(a.last('gone') && a.last('gone').id === b.id);
    // the freed grid slot is reused
    const c = await client(srv.port, { name: 'Carol' });
    assert.strictEqual(c.last('welcome').players.find(p => p.id === c.id).slot, 1);
    a.ws.close(); c.ws.close();
  });

  await test('name / colour sanitising', async t => {
    const srv = await t.start();
    const a = await client(srv.port, { name: '  <b>very very very long name here</b>\u0000\n ', colour: 'red; x' });
    const me = a.last('welcome').players[0];
    assert(Array.from(me.name).length <= 16, me.name);
    assert(!/[\u0000-\u001f]/.test(me.name));
    assert(/^#[0-9a-f]{6}$/.test(me.colour), me.colour);
    const b = await client(srv.port, { name: 12345, colour: null });
    assert(/^Player \d+$/.test(b.last('welcome').players.find(p => p.id === b.id).name));
    a.send({ t: 'profile', name: '小明', colour: '#00ff00' });
    await b.wait(() => b.last('players').players.some(p => p.name === '小明' && p.colour === '#00ff00'));
    a.ws.close(); b.ws.close();
  });

  await test('host migration on a dedicated server', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port), c = await client(srv.port);
    assert.strictEqual(c.last('welcome').host, a.id);
    // non-host cannot change the track
    b.send({ t: 'track', id: 'monza' });
    await sleep(120);
    assert.strictEqual(c.last('track'), null);
    a.ws.close();
    await c.wait(() => c.last('players').host === b.id);
    b.send({ t: 'track', id: 'monza' });
    await c.wait(() => c.last('track'));
    assert.strictEqual(c.last('track').id, 'monza');
    b.ws.close();
    await c.wait(() => c.last('players').host === c.id);
    c.ws.close();
  });

  await test('in-game server: host is the token holder, no migration', async t => {
    const srv = await t.start({ hostToken: 'secret-token' });
    const g = await client(srv.port, { name: 'Guest' });            // joins first, but has no token
    assert.strictEqual(g.last('welcome').host, 0);
    const bad = await client(srv.port, { name: 'Liar', token: 'wrong' });
    assert.strictEqual(bad.last('welcome').host, 0);
    const h = await client(srv.port, { name: 'Host', token: 'secret-token' });
    assert.strictEqual(h.last('welcome').host, h.id);
    await g.wait(() => g.last('players').host === h.id);
    g.send({ t: 'track', id: 'spa' });
    await sleep(100);
    assert.strictEqual(h.last('track'), null, 'guest must not pick the track');
    h.ws.close();
    await g.wait(() => g.last('players').host === 0);
    g.ws.close(); bad.ws.close();
  });

  await test('track change broadcast, late joiner gets the current track', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    a.send({ t: 'track', id: 'suzuka' });
    await b.wait(() => b.last('track'));
    assert.deepStrictEqual([b.last('track').id, b.last('track').seq], ['suzuka', 1]);
    assert.strictEqual(a.last('track').id, 'suzuka', 'the host gets the broadcast too');
    const c = await client(srv.port);
    assert.deepStrictEqual([c.last('welcome').track, c.last('welcome').seq], ['suzuka', 1]);
    for (const bad of ['', '../etc', 'a b', 'x'.repeat(65), 5, null, { a: 1 }]) a.send({ t: 'track', id: bad });
    await sleep(120);
    assert.strictEqual(b.all('track').length, 1, 'invalid track ids are ignored');
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  await test('snapshot relay at ~20 Hz, validated and clamped', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    const timer = setInterval(() => a.send(state(Math.random() * 100, 50)), 25);
    await sleep(1050);
    clearInterval(timer);
    const snaps = b.all('snap');
    assert(snaps.length >= 15 && snaps.length <= 23, 'snapshots in ~1 s: ' + snaps.length);
    const e = snaps[snaps.length - 1].p[0];
    assert.strictEqual(e.length, 10);
    assert.strictEqual(e[0], a.id);
    assert(e.every(Number.isFinite));
    // nothing new -> no snapshot
    await sleep(120);
    const n0 = b.all('snap').length;
    await sleep(250);
    assert.strictEqual(b.all('snap').length, n0, 'idle players must not be rebroadcast');
    // out-of-range values are clamped, malformed states are dropped
    a.send({ t: 's', k: 0, c: 1, s: [1e30, -1e30, 5, 100, 9, -9, 1e9, 7] });
    await b.wait(() => b.all('snap').length > n0);
    const c = b.last('snap').p[0];
    assert(Math.abs(c[2]) <= 1e5 && Math.abs(c[8]) <= 130 && Math.abs(c[9]) <= 1 && Math.abs(c[6]) <= 1.2, JSON.stringify(c));
    const n1 = b.all('snap').length;
    for (const s of [[1, 2, 3], 'x', null, [1, 2, 3, 4, 5, 6, 7, 'a'], [1, 2, 3, 4, 5, 6, 7, null], [NaN, 0, 0, 0, 0, 0, 0, 0]]) {
      a.send({ t: 's', k: 0, c: 2, s });
    }
    a.send({ t: 's', k: 99, c: 3, s: [0, 0, 0, 0, 0, 0, 0, 0] });      // wrong track sequence
    a.send('{"t":"s","k":0,"c":1e999,"s":[0,0,0,0,0,0,0,0]}');         // Infinity timestamp
    await sleep(200);
    assert.strictEqual(b.all('snap').length, n1, 'malformed states must not be relayed');
    a.ws.close(); b.ws.close();
  });

  await test('lap times are shared through the roster', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    a.send({ t: 'lap', last: 83.4567, best: 82.1 });
    await b.wait(() => b.last('players').players.find(p => p.id === a.id).best === 82.1);
    a.send({ t: 'lap', last: 'x', best: -5 });
    await b.wait(() => b.last('players').players.find(p => p.id === a.id).best === null);
    a.ws.close(); b.ws.close();
  });

  await test('impact reports go to the target only, clamped and throttled', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port), c = await client(srv.port);
    a.send({ t: 'hit', k: 0, to: b.id, i: [3, -4] });
    await b.wait(() => b.last('hit'));
    assert.deepStrictEqual(b.last('hit'), { t: 'hit', from: a.id, i: [3, -4] });
    await sleep(60);
    a.send({ t: 'hit', k: 0, to: b.id, i: [3000, 0] });
    await b.wait(() => b.all('hit').length === 2);
    assert.deepStrictEqual(b.last('hit').i, [80, 0]);
    await sleep(60);
    for (let i = 0; i < 20; i++) a.send({ t: 'hit', k: 0, to: b.id, i: [1, 1] });      // burst: only one passes
    for (const bad of [{ to: a.id, i: [1, 1] }, { to: 999, i: [1, 1] }, { to: b.id, i: [1] }, { to: b.id, i: ['x', 1] },
      { to: b.id, i: [0, 0] }, { to: 'b', i: [1, 1] }, { to: b.id }]) a.send(Object.assign({ t: 'hit', k: 0 }, bad));
    a.send({ t: 'hit', k: 7, to: b.id, i: [1, 1] });
    await sleep(150);
    assert.strictEqual(b.all('hit').length, 3);
    assert.strictEqual(c.all('hit').length + a.all('hit').length, 0, 'nobody else gets it');
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  await test('malformed / oversized messages do not crash the server', async t => {
    const srv = await t.start();
    const a = await client(srv.port), good = await client(srv.port);
    for (const junk of ['', 'not json', '{', '[]', 'null', '123', '"str"', '{"t":5}', '{"t":"nope"}', '{"t":"hello"}',
      '{"t":"s"}', '{"t":"track"}', '{"t":"profile"}', '{"t":"lap"}', '{"__proto__":{"t":"track"}}',
      '{"t":"s","s":{"length":8}}', '{"t":"constructor"}', '{"t":"toString"}']) a.send(junk);
    a.ws.send(Buffer.from([0, 1, 2, 3, 255]));                 // binary frame
    await sleep(100);
    assert.strictEqual(a.closed, null, 'junk alone does not get you kicked');
    a.send('x'.repeat(5000));                                   // over maxPayload
    await a.wait(() => a.closed);
    assert.strictEqual(a.closed.code, 1009);
    // a socket that never says hello and sends only garbage
    const raw = await client(srv.port, false);
    raw.send({ t: 'track', id: 'monza' });
    raw.send(state(1, 1));
    await sleep(100);
    assert.strictEqual(good.last('track'), null, 'messages before hello are ignored');
    raw.ws.terminate();
    // the server still works
    good.send({ t: 'track', id: 'monza' });   // good is host now (a left)
    await good.wait(() => good.last('track'));
    good.ws.close();
  });

  await test('flooding is rate-limited and the flooder is dropped', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    for (let i = 0; i < 5000; i++) a.send({ t: 'profile', name: 'n' + i, colour: '#000000' });
    await a.wait(() => a.closed, 4000);
    assert.strictEqual(a.closed.code, 1008);
    const rosters = b.all('players').length;
    assert(rosters < 200, 'roster broadcasts caused by the flood: ' + rosters);
    await b.wait(() => b.last('players').players.length === 1);
    b.send({ t: 'track', id: 'ok' });
    await b.wait(() => b.last('track'));
    b.ws.close();
  });

  await test('17th player is rejected with "full"; a slot opens when someone leaves', async t => {
    const srv = await t.start();
    const cs = [];
    for (let i = 0; i < 16; i++) cs.push(await client(srv.port, { name: 'p' + i }));
    assert(cs.every(c => c.id > 0));
    const x = await client(srv.port, { name: 'late' });
    await x.wait(() => x.closed);
    assert.strictEqual(x.id, 0);
    assert.strictEqual(x.last('error').code, 'full');
    assert.strictEqual(srv.info().players.length, 16);
    cs[5].ws.close();
    await cs[0].wait(() => cs[0].last('players').players.length === 15);
    const y = await client(srv.port, { name: 'again' });
    assert(y.id > 0);
    assert.strictEqual(y.last('welcome').players.find(p => p.id === y.id).slot, 5);
    cs.forEach(c => c.ws.close()); y.ws.close();
  });

  await test('wrong protocol version is rejected', async t => {
    const srv = await t.start();
    const x = await client(srv.port, { v: 999 });
    await x.wait(() => x.closed);
    assert.strictEqual(x.last('error').code, 'version');
  });

  await test('closing the server disconnects clients with 1001; port in use is reported', async t => {
    const srv = await t.start();
    const a = await client(srv.port);
    await assert.rejects(createServer({ port: srv.port, host: '127.0.0.1' }), e => e.code === 'EADDRINUSE');
    await srv.close();
    await a.wait(() => a.closed);
    assert.strictEqual(a.closed.code, 1001);
    await srv.close();                                         // idempotent
    const again = await createServer({ port: srv.port, host: '127.0.0.1' });   // port is free again
    await again.close();
  });

  await test('client address parsing (js/net.js)', async () => {
    const p = netClient.parseAddress;
    const url = s => { const r = p(s); return r ? r.url : null; };
    assert.strictEqual(url('1.2.3.4'), 'ws://1.2.3.4:24500');
    assert.strictEqual(url(' 1.2.3.4:25565 '), 'ws://1.2.3.4:25565');
    assert.strictEqual(url('my-host.example.com'), 'ws://my-host.example.com:24500');
    assert.strictEqual(url('my-host.example.com:80'), 'ws://my-host.example.com:80');
    assert.strictEqual(url('localhost'), 'ws://localhost:24500');
    assert.strictEqual(url('[::1]'), 'ws://[::1]:24500');
    assert.strictEqual(url('[2001:db8::5]:3000'), 'ws://[2001:db8::5]:3000');
    assert.strictEqual(url('2001:db8::5'), 'ws://[2001:db8::5]:24500');
    assert.strictEqual(url('ws://1.2.3.4:24500/'), 'ws://1.2.3.4:24500');
    assert.strictEqual(url('http://1.2.3.4'), 'ws://1.2.3.4:24500');
    for (const bad of ['', '   ', '1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:abc', 'a b', 'host:', '[::1', '[abc]', 'x@y',
      '<script>', 'user:pw@host', null, undefined, 5]) {
      assert.strictEqual(p(bad), null, 'should reject ' + JSON.stringify(bad));
    }
  });

  console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall server tests passed');
  process.exit(failed ? 1 : 0);
})();
