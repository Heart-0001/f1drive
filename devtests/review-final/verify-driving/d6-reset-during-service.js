// D6 verification: main.js's sequence when the Grand Prix goes back to 'free' during a service: onGpPhase('free') ->
// pit.reset() (nothing else). The frame loop holds the car only while pit.state.service; tyres are fitted only on
// 'serviceDone' (or freshStart, which 'free' does not call). Replays that with the real modules.
'use strict';
const { F1, STEP, track } = require('../driving/load');
const { track: tr } = track('it-1922');
const car = F1.createCar(null, { random: () => 0.5 }), st = car.state, ty = car.tyres;
const pit = F1.createPit({ random: () => 0.5 });
const b = tr.pit.boxes[0];
car.reset(tr, b.index); st.heading = b.heading; st.x = b.x; st.z = b.z; car.update(1e-4, null, tr); st.speed = 0;
// a punctured, worn set (as if limping in)
ty.fit('M'); ty.setWearRate(1);
ty.state.puncture = 0; for (let i = 0; i < 4; i++) ty.state.wear[i] = 0.9;
const log = [];
pit.update(STEP, Object.assign({}, st, { speed: 5 }), tr, { slot: 0 });       // drove in
let ev; for (let k = 0; k < 10 && ev !== 'serviceStart'; k++) { ev = pit.update(STEP, st, tr, { slot: 0 }); if (ev) log.push(ev); }
for (let k = 0; k < 120; k++) { ev = pit.update(STEP, st, tr, { slot: 0 }); if (ev) log.push(ev); }  // 1 s of a ~2.7 s service
log.push('service left ' + pit.state.service.left.toFixed(2) + ' s -> host ends the GP: pit.reset()');
pit.reset();
let fitted = false;
// free practice: frame() no longer holds the car (pit.state.service null); the car stands still in the box for 5 s
for (let k = 0; k < 600; k++) {
  if (pit.state.service) { log.push('held again'); break; }
  car.update(STEP, {}, tr);
  ev = pit.update(STEP, st, tr, { slot: 0 });
  if (ev) { log.push(ev); if (ev === 'serviceDone') { ty.fit('M'); fitted = true; } }
}
console.log(log.join('\n'));
console.log('after 5 s standing in the box: service ' + JSON.stringify(pit.state.service) + ', fitted ' + fitted + ', puncture ' + ty.state.puncture + ', wear ' + ty.state.wear.map(w => w.toFixed(2)).join('/') + ', served ' + pit.state.served + ', stops ' + pit.state.stops);
// creep forward and stop again inside the box: a new service starts
for (let k = 0; k < 30; k++) { car.update(STEP, { up: true }, tr); ev = pit.update(STEP, st, tr, { slot: 0 }); if (ev) log.push('creep: ' + ev); }
for (let k = 0; k < 240; k++) { car.update(STEP, { down: st.speed > 0.05 }, tr); ev = pit.update(STEP, st, tr, { slot: 0 }); if (ev) { console.log('after creeping: ' + ev + ' (inBox ' + pit.state.inBox + ')'); if (ev === 'serviceStart') break; } }
console.log('after creeping: service ' + (pit.state.service ? 'running' : 'none') + ', inBox ' + pit.state.inBox);
