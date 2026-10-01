// Scripted telemetry states shared by shots.js and the probes (plain data for F1.telemetry.draw).
const REF = { rpmIdle: 4000, rpmShift: 11800, rpmMax: 12500, limitKmh: 80 };
const GEAR_KMH = [60, 100, 140, 180, 220, 260, 300], TOP_KMH = 345;
const tyresNew = c => ({ compound: c, wear: [0.02, 0.02, 0.03, 0.03], flat: [0, 0, 0, 0], puncture: -1 });
const S = o => Object.assign({ speedKmh: 0, gear: 0, rpm: 4000, throttle: 0, brake: 0, battery: 1, deploy: 0, harvest: 0,
  limiter: false, inPit: false, tyres: tyresNew('M'), nextCompound: 'M', team: 'McLaren', car: 'MCL40', colour: '#ff8000',
  colour2: '#1a1a1a' }, REF, o);
const shiftState = g => S({ gear: g, speedKmh: g < 8 ? GEAR_KMH[g - 1] : TOP_KMH, rpm: 11800, throttle: 1, battery: 0.72 });

const SCEN = [
  ['idle-neutral', S({})],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(g => ['shift-g' + g, shiftState(g)]),
  ['brake-300-harvest', S({ speedKmh: 300, gear: 8, rpm: 11800 * 300 / 345, brake: 1, harvest: 1, battery: 0.46 })],
  ['brake-mid-harvest', S({ speedKmh: 187, gear: 5, rpm: 11800 * 187 / 220, brake: 0.62, harvest: 0.7, battery: 0.51 })],
  ['deploy', S({ speedKmh: 287, gear: 7, rpm: 11800 * 287 / 300, throttle: 1, deploy: 1, battery: 0.63 })],
  ['battery-empty', S({ speedKmh: 262, gear: 7, rpm: 11800 * 262 / 300, throttle: 1, deploy: 0, battery: 0 })],
  ['battery-low', S({ speedKmh: 262, gear: 7, rpm: 11800 * 262 / 300, throttle: 1, deploy: 1, battery: 0.08 })],
  ['no-ers-2010', S({ battery: null, team: 'Red Bull Racing', car: 'RB6', colour: '#1b2a5c', colour2: '#e8c21c',
    rpmIdle: 6000, rpmShift: 17800, rpmMax: 18000, speedKmh: 243, gear: 6, rpm: 17100, throttle: 1 })],
  ['no-ers-2010-neutral', S({ battery: null, team: 'Ferrari', car: 'F10', colour: '#d40000', rpmIdle: 6000, rpmShift: 17800,
    rpmMax: 18000 })],
  ['limiter-lane-80', S({ limiter: true, inPit: true, speedKmh: 80, gear: 3, rpm: 11800 * 80 / 140, throttle: 1, battery: 0.9 })],
  ['limiter-lane-80-off', S({ limiter: true, inPit: true, speedKmh: 80, gear: 3, rpm: 11800 * 80 / 140, throttle: 1, battery: 0.9 }),
    { end: 14250 }],
  ['limiter-before-entry', S({ limiter: true, inPit: false, speedKmh: 96, gear: 3, rpm: 11800 * 96 / 140, brake: 0.5, battery: 0.9 })],
  ['lane-no-limiter-speeding', S({ limiter: false, inPit: true, speedKmh: 97, gear: 3, rpm: 11800 * 97 / 140, throttle: 1, battery: 0.9 })],
  ['lane-no-limiter-ok', S({ limiter: false, inPit: true, speedKmh: 58, gear: 2, rpm: 11800 * 58 / 100, throttle: 0.3, battery: 0.9,
    limitKmh: 60 })],
  ['tyres-worn-flat-puncture', S({ speedKmh: 142, gear: 4, rpm: 11800 * 142 / 180, throttle: 0.6, battery: 0.4,
    tyres: { compound: 'S', wear: [0.42, 0.66, 0.83, 0.97], flat: [0.8, 0, 0, 0], puncture: 3 }, nextCompound: 'H' })],
  ['tyres-flat-light', S({ speedKmh: 142, gear: 4, rpm: 11800 * 142 / 180, throttle: 0.6, battery: 0.4,
    tyres: { compound: 'H', wear: [0.2, 0.25, 0.1, 0.12], flat: [0.2, 0.5, 0, 0], puncture: -1 }, nextCompound: 'H' })],
  ['compound-S-next-H', S({ tyres: tyresNew('S'), nextCompound: 'H', speedKmh: 120, gear: 3, rpm: 10100, throttle: 1 })],
  ['compound-M-next-M', S({ tyres: tyresNew('M'), nextCompound: 'M', speedKmh: 120, gear: 3, rpm: 10100, throttle: 1 })],
  ['compound-H-next-S', S({ tyres: tyresNew('H'), nextCompound: 'S', speedKmh: 120, gear: 3, rpm: 10100, throttle: 1 })],
  ['digits-0', S({ speedKmh: 0, gear: 1, rpm: 4000 })],
  ['digits-9', S({ speedKmh: 9.2, gear: 1, rpm: 4000, throttle: 0.4 })],
  ['digits-99', S({ speedKmh: 99, gear: 2, rpm: 11682, throttle: 1 })],
  ['digits-345', S({ speedKmh: 345, gear: 8, rpm: 11800, throttle: 1 })],
  ['reverse', S({ speedKmh: -12, gear: -1, rpm: 5200, brake: 0, throttle: 0.5 })],
  ['dark-livery-mercedes', S({ team: '賓士 Mercedes', car: 'W17', colour: '#0F100F', colour2: '#BDBCBA', speedKmh: 211, gear: 5,
    rpm: 11300, throttle: 1, battery: 0.85 })],
  ['long-names', S({ team: 'Visa Cash App Racing Bulls Formula One Team', car: 'VCARB 03 (very long chassis name)', colour: '#6c98ff',
    speedKmh: 211, gear: 5, rpm: 11300, throttle: 1 })],
  ['garbage', { speedKmh: NaN, gear: 'x', rpm: Infinity, rpmIdle: -5, rpmShift: 'a', rpmMax: null, throttle: 7, brake: -3, battery: NaN,
    deploy: {}, harvest: [], limiter: 'yes', inPit: 1, limitKmh: -80, tyres: { compound: 42, wear: 'abc', flat: null, puncture: 9 },
    nextCompound: {}, team: 12, car: null, colour: 'red' }],
  ['empty-object', {}]
];


module.exports = { SCEN, S, REF };
