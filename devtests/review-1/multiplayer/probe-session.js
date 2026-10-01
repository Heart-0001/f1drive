// Review probe: session rule edge cases (net/session.js alone).
'use strict';
const path = require('path');
const { createSession } = require(path.join(__dirname, '..', '..', '..', 'net', 'session.js'));

function fresh() { return createSession({ random: () => 0.5 }); }

// 1. a leaver during 'grid' shifts everybody else's grid index
{
  const s = fresh();
  [1, 2, 3].forEach(id => s.addPlayer(id, 'p' + id, 0));
  s.start({ q: 1, r: 2, len: 1000 }, 0);
  s.lap(1, 30, 40000); s.lap(2, 31, 40000); s.lap(3, 32, 40000);
  console.log('grid', s.snapshot().grid);
  s.removePlayer(1, 41000);
  console.log('after pole leaves in grid phase:', s.snapshot().grid, '-> P2 now index 0 (his car was placed in box 2)');
}

// 2. a joiner during qualifying after everybody finished holds the grid
{
  const s = fresh();
  [1, 2].forEach(id => s.addPlayer(id, 'p' + id, 0));
  s.start({ q: 1, r: 2, len: 1000 }, 0);
  s.lap(1, 30, 40000);
  s.addPlayer(3, 'late', 40500);
  s.lap(2, 31, 41000);
  console.log('everyone else done, late joiner idle: phase', s.phase);
}

// 3. race time replaced by the session clock when one lap report is delayed > 1 s
{
  const s = fresh();
  [1].forEach(id => s.addPlayer(id, 'p' + id, 0));
  s.start({ q: 1, r: 2, len: 1000 }, 0);
  s.skip(0);
  const go = s.snapshot().goAt;
  s.tick(go);
  s.lap(1, 20, go + 20000 + 200);      // 200 ms latency
  s.lap(1, 20, go + 40000 + 1500);     // 1.5 s spike on the last report
  console.log('rTime with a 1.5 s spike on the flag lap:', s.snapshot().players[0].rTime, '(laps sum 40.000)');
}

// 4. DNF / chequered flag / 90 s
{
  const s = fresh();
  [1, 2, 3].forEach(id => s.addPlayer(id, 'p' + id, 0));
  s.start({ q: 1, r: 1, len: 1000 }, 0);
  s.skip(0);
  const go = s.snapshot().goAt;
  s.tick(go);
  s.lap(1, 20, go + 21000);
  s.removePlayer(2, go + 22000);
  const snap = s.snapshot();
  console.log('winner fin', snap.players[0].fin, 'leaver dnf', snap.players[1].dnf, 'endsAt-winnerAt', snap.endsAt - snap.winnerAt, 'phase', s.phase);
  s.tick(snap.endsAt);
  console.log('after timeout phase', s.phase, 'order', s.snapshot().order);
}

// 5. the same id re-added after leaving mid-race? (server ids are unique, but check the rule)
{
  const s = fresh();
  [1, 2].forEach(id => s.addPlayer(id, 'p' + id, 0));
  s.start({ q: 1, r: 3, len: 1000 }, 0); s.skip(0); s.tick(s.snapshot().goAt);
  s.removePlayer(1, 99999);
  console.log('re-add same id after DNF:', s.addPlayer(1, 'again', 100000), 'rows', s.snapshot().players.map(p => p.id + (p.left ? 'L' : '') + (p.spec ? 'S' : '')));
}
