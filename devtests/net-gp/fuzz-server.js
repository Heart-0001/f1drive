// node devtests/net-gp/fuzz-server.js [seconds] [seed]      (port: env PORT, default 24775)
// Eight clients (one of them the host) throw random and half-valid protocol messages at the real server
// for a while; the session clock is stepped at random. Nothing may be thrown inside the server (its log
// would show "... error: ..."), every gp / players message the clients get must be well-formed, and the
// server must still serve a normal client afterwards.
'use strict';
const assert = require('assert');
const path = require('path');
const WebSocket = require('ws');
const ROOT = path.resolve(__dirname, '..', '..');
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));

const SECONDS = Number(process.argv[2]) || 12, SEED = Number(process.argv[3]) || 7;
const PORT = Number(process.env.PORT || 24775);
let seed = SEED >>> 0;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const pick = a => a[Math.floor(rnd() * a.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NASTY = ['NaN', '1e999', '-1e999', 'null', '""', '"x"', '"5"', '{}', '[]', '[1]', 'true', 'false', '-1', '0', '0.5', '1e308', '-1e308', '1e-9',
  '200', '5000', '{"__proto__":{"x":1}}', '"__proto__"', '"constructor"', '[[[[[[[[[[]]]]]]]]]]', '"' + 'x'.repeat(300) + '"', '9007199254740993', '"\\u0000\\u202e"'];
const TYPES = ['s', 'ping', 'gp', 'gl', 'hit', 'track', 'profile', 'lap', 'hello', 'nope', 'constructor', 'year', 'bots', 'bs'];
const FIELDS = ['k', 'c', 's', 'g', 'a', 'q', 'r', 'len', 'sid', 'time', 'to', 'i', 'id', 'name', 'colour', 'last', 'best', 'v', 'token',
  'y', 'car', 'wear', 'year', 'at', 'password', 'n', 'skill', 'list', 'b', 'from', 'bot'];
const LEVELS = ['rookie', 'amateur', 'pro', 'legend', 'mixed'];
const goodYear = y => y === null || (Number.isInteger(y) && y >= 2010 && y <= 2100);

(async () => {
  let now = 1800000000000;
  const errors = [], logs = [];
  const srv = await createServer({ port: PORT, host: '127.0.0.1', now: () => now, random: rnd, log: l => { logs.push(l); if (/error/i.test(l)) errors.push(l); } });
  const clients = [];
  const bad = [];
  function connect(i) {
    return new Promise(resolve => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT);
      const c = { ws, i, id: 0, seq: 0, sid: 0, n: 0, open: false, others: [] };
      ws.on('open', () => { c.open = true; ws.send(JSON.stringify({ t: 'hello', v: 1, name: 'fuzz' + i, car: pick(['2024-ferrari', '2012-lotus', 'BAD car', 7, undefined]) })); });
      ws.on('message', d => {
        let m;
        try { m = JSON.parse(d.toString()); } catch (e) { bad.push('unparsable from server'); return; }
        c.n++;
        if (m.t === 'welcome') { c.id = m.id; c.seq = m.seq; resolve(c); }
        if (m.t === 'track') c.seq = m.seq;
        if (m.t === 'players' || m.t === 'welcome') {
          c.host = m.host;
          const okBots = !m.bots || (Number.isInteger(m.bots.n) && m.bots.n >= 0 && m.bots.n <= 16 && LEVELS.includes(m.bots.skill) &&
            m.bots.n === m.players.filter(p => p.bot).length);
          // a bot row: bot true, skill 0..1 or null, owner = a player in the room, bi a whole number; slots unique
          const okRow = p => p.bot === undefined || (p.bot === true && (p.skill === null || (Number.isFinite(p.skill) && p.skill >= 0 && p.skill <= 1)) &&
            Number.isInteger(p.bi) && p.bi >= 0 && m.players.some(q => q.id === p.owner && !q.bot));
          if (!Array.isArray(m.players) || m.players.length > 16 || !goodYear(m.year) || !okBots || new Set(m.players.map(p => p.slot)).size !== m.players.length ||
            !m.players.every(p => Number.isInteger(p.id) && typeof p.name === 'string' && Array.from(p.name).length <= 16 &&
            /^#[0-9a-f]{6}$/.test(p.colour) && /^([a-z0-9-]{1,40})?$/.test(p.car) && Number.isInteger(p.slot) && (p.last === null || Number.isFinite(p.last)) && okRow(p))) bad.push('roster: ' + d.toString().slice(0, 300));
          else { c.others = m.players.map(p => p.id); c.bots = m.players.filter(p => p.bot && p.owner === c.id).map(p => p.id); }
        }
        if (m.t === 'gp') {
          const s = m.s;
          c.sid = s && s.sid;
          const text = d.toString();
          if (!Number.isFinite(m.now) || !s || !['free', 'quali', 'grid', 'race', 'results'].includes(s.phase) || !Array.isArray(s.players) || s.players.length > 32 ||
            !goodYear(s.year) || !(Number.isInteger(s.wear) && s.wear >= 1 && s.wear <= 5) ||
            text.length > 9000 || /null,"goAt"|"goAt":null|"lightsAt":null|"sid":null/.test(text) ||
            !s.players.every(p => Number.isInteger(p.id) && typeof p.name === 'string' && Number.isInteger(p.qLaps) && Number.isInteger(p.rLaps) && Number.isFinite(p.rTime) && Number.isInteger(p.down))) {
            bad.push('gp: ' + text.slice(0, 300));
          }
        }
        if (m.t === 'snap' && !m.p.every(e => e.length === 10 && e.every(Number.isFinite))) bad.push('snap: ' + d.toString().slice(0, 200));
        if (m.t === 'hit' && !(Number.isInteger(m.from) && m.i.length === 2 && m.i.every(Number.isFinite) && Math.hypot(m.i[0], m.i[1]) <= 80.01 &&
          (m.bot === undefined || (c.bots || []).includes(m.bot)))) bad.push('hit: ' + d.toString());
        if (m.t === 'glno' && m.id !== undefined && !(c.bots || []).includes(m.id)) bad.push('glno about a car that is not ours: ' + d.toString());
      });
      ws.on('close', () => { c.open = false; resolve(c); });
      ws.on('error', () => {});
    });
  }
  for (let i = 0; i < 8; i++) clients.push(await connect(i));

  const val = () => pick(NASTY);
  const info0 = () => srv.info();
  function message(c) {
    const r = rnd();
    const to = c.others.length ? pick(c.others) : 1;
    if (r < 0.22) {                                                // completely random object
      const n = Math.floor(rnd() * 6), parts = ['"t":' + (rnd() < 0.8 ? JSON.stringify(pick(TYPES)) : val())];
      for (let i = 0; i < n; i++) parts.push(JSON.stringify(pick(FIELDS)) + ':' + val());
      return '{' + parts.join(',') + '}';
    }
    if (r < 0.25) return pick(['', 'null', '[]', '{', '"x"', '5', '{"t":"s"', 'x'.repeat(100)]);
    // well-formed messages with the occasional nasty field
    const f = (good, p) => (rnd() < (p || 0.12) ? val() : JSON.stringify(good));
    if (r < 0.55) return '{"t":"s","k":' + f(c.seq) + ',"c":' + f(Date.now()) + ',"s":' + f([rnd() * 40, 0, rnd() * 40, rnd() * 6, 0, 0, rnd() * 90, 0]) + ',"g":' + f(rnd() * 3 - 0.5, 0.2) + '}';
    if (r < 0.60) return '{"t":"ping","c":' + f(rnd() * 1e6) + '}';
    if (r < (c.host === c.id ? 0.66 : 0.605)) return '{"t":"gp","a":' + f(pick(['start', 'start', 'skip', 'skip', 'end', 'again', 'again'])) + ',"q":' + f(pick([1, 2, 3])) + ',"r":' + f(pick([1, 2, 3])) + ',"len":' + f(200) + ',"wear":' + f(pick([1, 2, 5, 9])) + ',"year":' + f(1999) + '}';
    if (r < (c.host === c.id ? 0.69 : 0.62)) return '{"t":"year","y":' + f(pick([2010, 2014, 2024, 2026, 2009, 2101]), 0.2) + '}';
    if (r < 0.86) return '{"t":"gl","k":' + f(c.seq) + ',"sid":' + f(c.sid) + ',"time":' + f(2.2 + rnd() * 2) + ',"at":' + f(now - rnd() * 5000, 0.3) + '}';
    if (r < 0.92) return '{"t":"hit","k":' + f(c.seq) + ',"to":' + f(to) + ',"i":' + f([rnd() * 200 - 100, rnd() * 200 - 100]) +
      (rnd() < 0.4 ? ',"from":' + f(bot(c)) : '') + '}';
    if (r < 0.921) return '{"t":"track","id":' + f(pick(['monza', 'spa', 'suzuka'])) + '}';
    if (r < 0.95) return '{"t":"profile","name":' + f('n' + Math.floor(rnd() * 99)) + ',"colour":' + f('#a0b0c0') + ',"car":' + f(pick(['2024-ferrari', '2010-red-bull', 'x'.repeat(41), 'A b'])) + '}';
    if (r < 0.96) return '{"t":"lap","last":' + f(60 + rnd() * 30) + ',"best":' + f(60) + (rnd() < 0.5 ? ',"id":' + f(bot(c)) : '') + '}';
    // computer drivers: the host's field (anybody may try), their states, their laps
    if (r < (c.host === c.id ? 0.968 : 0.962)) {
      const n = Math.floor(rnd() * 20) - 2, list = [];
      for (let i = 0; i < Math.min(Math.max(n, 0), 16); i++) list.push(rnd() < 0.8 ? { name: 'b' + i, car: pick(['2024-ferrari', '2026-red-bull', 'BAD']), colour: '#102030', skill: rnd() * 1.4 - 0.2 } : JSON.parse(val()));
      return '{"t":"bots","n":' + f(n) + ',"skill":' + f(pick(LEVELS.concat(['godlike', '__proto__']))) + ',"list":' + f(list) + '}';
    }
    if (r < 0.99) {
      const rows = [];
      for (let i = 0, n = 1 + Math.floor(rnd() * 4); i < n; i++) rows.push([bot(c), rnd() * 40, 0, rnd() * 40, rnd() * 6, 0, 0, rnd() * 90, 0, rnd() * 3 - 0.5]);
      return '{"t":"bs","k":' + f(c.seq) + ',"c":' + f(Date.now()) + ',"b":' + f(rows, 0.08) + '}';
    }
    return '{"t":"gl","k":' + f(c.seq) + ',"sid":' + f(c.sid) + ',"time":' + f(2.2 + rnd() * 2) + ',"at":' + f(now - rnd() * 5000, 0.3) + ',"id":' + f(bot(c)) + '}';
  }
  // one of this client's bots most of the time, else anybody's / nonsense
  function bot(c) { return c.bots && c.bots.length && rnd() < 0.8 ? pick(c.bots) : pick(c.others.length ? c.others : [1]); }

  clients[0].ws.send(JSON.stringify({ t: 'track', id: 'monza' }));
  const end = Date.now() + SECONDS * 1000;
  let sent = 0, reconnects = 0;
  while (Date.now() < end) {
    for (const c of clients) {
      if (!c.open) continue;
      for (let k = 0; k < 3; k++) { try { c.ws.send(message(c)); sent++; } catch (e) {} }
    }
    if (rnd() < 0.05) {                                          // the host ends the session and picks a season (free only)
      const h = clients.find(c => c.open && c.id && c.id === c.host);
      if (h) ['{"t":"gp","a":"end"}', '{"t":"gp","a":"end"}', '{"t":"year","y":' + pick([2010, 2015, 2020, 2026]) + '}'].forEach(s => { try { h.ws.send(s); sent++; } catch (e) {} });
    }
    if (rnd() < 0.5) now += pick([0, 50, 500, 2000, 2500, 3000, 3000, 4000, 10000, 95000]);
    if (rnd() < 0.03) {                                          // somebody drops out and comes back
      const c = pick(clients);
      if (c.open) {
        c.ws.terminate(); await sleep(20); clients[c.i] = await connect(c.i); reconnects++;
        if (!info0().track) clients.forEach(x => { if (x.open) x.ws.send(JSON.stringify({ t: 'track', id: 'monza' })); });
      }
    }
    await sleep(55);                                              // ~55 messages / s per client: just under the limit
  }
  await sleep(300);
  // afterwards: a normal client is served normally (the host first ends the session and drops his bots: a room full
  // of bots during a session is rightly 'full')
  const host = clients.find(c => c.open && c.id && c.id === c.host);
  const botsLeft = srv.info().bots.n;
  if (host) ['{"t":"gp","a":"end"}', '{"t":"gp","a":"end"}', '{"t":"bots","n":0}'].forEach(s => host.ws.send(s));
  await sleep(300);
  const probe = await connect(99);
  assert(probe.id > 0 || clients.filter(c => c.open).length === 16, 'a new client can join');
  probe.ws.send(JSON.stringify({ t: 'ping', c: 42 }));
  await sleep(300);
  const info = srv.info();
  const phases = {};
  logs.forEach(l => { const m = /^gp +(.*)$/.exec(l); if (m) phases[m[1].replace(/^.*-> /, '')] = (phases[m[1].replace(/^.*-> /, '')] || 0) + 1; });
  console.log('sent ' + sent + ' messages in ' + SECONDS + ' s (seed ' + SEED + '), ' + reconnects + ' reconnects; clients got ' + clients.reduce((a, c) => a + c.n, 0) + ' messages');
  console.log('session transitions seen in the server log: ' + JSON.stringify(phases) + '; final phase ' + info.gp.phase + ', sid ' + info.gp.sid + ', players ' + info.players.length);
  console.log('room year changes in the server log: ' + logs.filter(l => /^year /.test(l)).length + ', final room year ' + info.year +
    ', session year / wear ' + info.gp.year + ' / ' + info.gp.wear + ', cars ' + JSON.stringify(info.players.map(p => p.car)));
  if (!goodYear(info.year)) bad.push('room year ' + info.year);
  const still = clients.filter(c => c.open).length;
  await srv.close();

  // a room with a password: hellos with garbage passwords are refused ('password', then 'wait'), never seated,
  // never thrown on; the right one gets in (on a room this address has not been guessing at)
  const pwLog = l => { if (/error/i.test(l)) errors.push(l); };
  const locked = await createServer({ port: PORT, host: '127.0.0.1', password: 'Fuzz pw', log: pwLog });
  const codes = {};
  for (const pw of NASTY.concat(['"fuzz pw"', '"Fuzz pw "', '"Fuzz pw"'])) {
    const got = await new Promise(resolve => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT);
      let code = 'none';
      ws.on('open', () => ws.send('{"t":"hello","v":1,"name":"pw","password":' + pw + '}'));
      ws.on('message', d => { const m = JSON.parse(d.toString()); code = m.t === 'error' ? m.code : m.t; });
      ws.on('close', () => resolve(code));
      ws.on('error', () => {});
      setTimeout(() => { ws.terminate(); resolve(code); }, 1500);
    });
    codes[got] = (codes[got] || 0) + 1;
  }
  if (locked.info().players.length !== 0 || codes.welcome) bad.push('password room seated somebody: ' + JSON.stringify(codes));
  await locked.close();
  const open2 = await createServer({ port: PORT, host: '127.0.0.1', password: 'Fuzz pw', log: pwLog });
  const right = await new Promise(resolve => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name: 'ok', password: ' Fuzz pw ' })));
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.t === 'welcome' || m.t === 'error') { ws.close(); resolve(m.t); } });
    ws.on('error', () => resolve('error'));
  });
  await open2.close();
  if (right !== 'welcome') bad.push('the right password was refused: ' + right);
  console.log('password room: garbage hellos answered ' + JSON.stringify(codes) + ', the right one: ' + right);

  console.log('exceptions caught inside the server: ' + errors.length + (errors.length ? '\n  ' + errors.slice(0, 10).join('\n  ') : ''));
  console.log('malformed messages received by clients: ' + bad.length + (bad.length ? '\n  ' + bad.slice(0, 10).join('\n  ') : ''));
  console.log('kicked for flooding: ' + logs.filter(l => /flood/.test(l)).length + ', still connected: ' + still + '/8, probe id ' + probe.id);
  console.log('bot field changes in the server log: ' + logs.filter(l => /^bots /.test(l)).length + ', bots at the end: ' + botsLeft + ' (' + info.bots.skill + ')');
  const ok = errors.length === 0 && bad.length === 0 && probe.id > 0;
  console.log(ok ? 'FUZZ OK' : 'FUZZ FAILED');
  process.exit(ok ? 0 : 1);
})();
