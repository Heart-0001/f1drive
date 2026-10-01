// Verify finding car-pit-paved-not-in-contract: a track.pit with every README field but no paved() -> car.update throws?
// node devtests/review-1/verify-driving/probe-paved.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
const F1 = global.F1;

const td = global.F1_TRACKS.find(t => t.id === 'it-1922');
const tr = F1.buildTrack(td);
const pit = tr.pit;
console.log('track.pit keys:', Object.keys(pit).join(', '));
// the contract's shape only (README-interfaces.md "js/track.js additions — pit lane")
const CONTRACT = ['side', 'limitKmh', 'from', 'to', 'entry', 'exit', 'laneD', 'laneHalfW', 'wallD', 'wallHalfT', 'boxes', 'inLane', 'contains'];
const cpit = {};
for (const k of CONTRACT) cpit[k] = pit[k];
const extra = Object.keys(pit).filter(k => !CONTRACT.includes(k));
console.log('fields beyond the contract used by the real pit:', extra.join(', '));
const proxy = Object.create(tr); proxy.pit = cpit;          // same track, contract-only pit object

function run(trk, label, dLane) {
  const car = F1.createCar(); car.tyres.setWearRate(0);
  const S = tr.samples, N = S.length;
  const mid = (pit.entry + ((pit.exit - pit.entry + N) % N >> 1)) % N;
  const s = S[mid], d = dLane === undefined ? pit.laneD(mid) : dLane;
  car.reset(tr, mid);
  car.state.x = s.x + s.nx * d; car.state.z = s.z + s.nz * d; car.state.heading = Math.atan2(s.tx, s.tz);
  try {
    car.update(1e-4, null, trk);
    for (let n = 0; n < 120; n++) car.update(1 / 120, { up: true, limiter: true }, trk);
    console.log(label, 'd=' + d.toFixed(2), 'OK: onGrass', car.state.onGrass, 'inPit', car.state.inPit, 'kmh', (car.state.speed * 3.6).toFixed(1));
  } catch (e) {
    console.log(label, 'd=' + d.toFixed(2), 'THROWS:', e.message);
  }
}
run(tr, 'real track.pit, car in the lane    ');
run(proxy, 'contract-only pit, car in the lane ');
run(proxy, 'contract-only pit, car on the road ', 0);
