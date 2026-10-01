// Verifier probe: rtime-latency and grid-shift-on-leave (net/session.js, js/gp.js), no network.
// node devtests/review-1/verify-multiplayer/v-session.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { createSession } = require(path.join(ROOT, 'net', 'session.js'));
require(path.join(ROOT, 'js', 'gp.js'));
const F1 = globalThis.F1;

function race(ids, r, len) {
  const s = createSession({ random: () => 0.5 });
  ids.forEach(id => s.addPlayer(id, 'p' + id, 0));
  s.start({ q: 1, r, len }, 0);
  s.skip(0);
  const go = s.snapshot().goAt;
  s.tick(go);
  return { s, go };
}

// ---- rtime-latency: A crosses the line 0.4 s before B, A's flag report is delayed 1.2 s
{
  const { s, go } = race([1, 2], 2, 1000);
  // lap 1: both at ~30 s, normal 50 ms latency
  s.lap(1, 30.0, go + 30000 + 50);
  s.lap(2, 30.2, go + 30200 + 50);
  // lap 2: A crosses at 60.0 s, B at 60.4 s; A's report arrives 1.2 s late, B's after 50 ms
  s.lap(2, 30.2, go + 60400 + 50);
  s.lap(1, 30.0, go + 60000 + 1200);
  const snap = s.snapshot();
  const row = id => snap.players.find(p => p.id === id);
  console.log('A laps sum 60.000 -> rTime', row(1).rTime, '; B laps sum 60.400 -> rTime', row(2).rTime,
    '; classified order', snap.order, '(on the road: A first)');
  // same without the spike
  const b = race([1, 2], 2, 1000);
  b.s.lap(1, 30.0, b.go + 30050); b.s.lap(2, 30.2, b.go + 30250);
  b.s.lap(1, 30.0, b.go + 60050); b.s.lap(2, 30.2, b.go + 60450);
  console.log('without the spike: order', b.s.snapshot().order);
}

// ---- why the clock fallback exists: a driver sits in the menu for 30 s (the game loop and his lap timer stop)
{
  const { s, go } = race([1, 2], 2, 1000);
  s.lap(1, 30.0, go + 30050);  s.lap(2, 31.0, go + 31050);
  // B pauses 30 s during lap 2: his timer shows 31 s for the lap, the real crossing is at 92 s
  s.lap(1, 30.0, go + 60050);
  s.lap(2, 31.0, go + 92050);
  const snap = s.snapshot(), row = id => snap.players.find(p => p.id === id);
  console.log('paused driver: laps sum 62.000, crossed at 92.0 -> rTime', row(2).rTime,
    '(the fallback is what keeps his time honest; "use the sum whenever sum <= elapsed" would give 62.0)');
}

// ---- grid-shift-on-leave: what the client does with the shifted index
{
  const s = createSession({ random: () => 0.5 });
  [1, 2, 3].forEach(id => s.addPlayer(id, 'p' + id, 0));
  s.start({ q: 1, r: 2, len: 1000 }, 0);
  s.lap(1, 30, 40000); s.lap(2, 31, 40000); s.lap(3, 32, 40000);
  const grid1 = s.snapshot();

  // js/gp.js as player 3 (P3) with a fake net
  const handlers = {};
  const fakeNet = { connected: true, isHost: false, id: 3, session: null, roster: [],
    on(n, f) { (handlers[n] = handlers[n] || []).push(f); }, serverNow: () => 41000, setProgress() {}, gp() { return true; } };
  const gp = F1.createGp();
  gp.init({ net: fakeNet });
  handlers.connected.forEach(f => f());
  const phases = [];
  gp.on('phase', (ph) => phases.push(ph + '@slot' + gp.gridSlot));
  handlers.gp.forEach(f => f(grid1));
  s.removePlayer(1, 41000);                        // pole sitter leaves during 'grid'
  const grid2 = s.snapshot();
  handlers.gp.forEach(f => f(grid2));
  console.log('phase events seen by P3:', phases, '; gridSlot afterwards', gp.gridSlot,
    '(main.js reads gridSlot only in the phase handler, so the car stays in box 3; the HUD view has no grid slot:',
    Object.keys(gp.view()).includes('gridSlot') + ')');

  // tiebreak: everybody level (no progress sent yet at lights out): order by grid
  s.tick(grid2.goAt);
  console.log('race order at lights out (all level):', s.snapshot().order, 'grid', s.snapshot().grid, '-> relative order unchanged');
}
