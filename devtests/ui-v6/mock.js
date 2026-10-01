// Mock data for the ui-v6 harness, shaped like the v6 contract (js/README-interfaces.md): F1.cars.seasons, CarSpec
// lists of 12 cars (2026 from js/cars-data.js, 2012 hand-made without ERS), GpViews with year / wear and the optional
// row.team / row.colour2, telemetry frames for updateHUD and pit states for setPit.
const path = require('path');
const CARS26 = require(path.join(__dirname, '..', '..', 'js', 'cars-data.js'));

const SEASONS = [];
for (let y = 2010; y <= 2026; y++) {
  SEASONS.push({ year: y, label: String(y), engine: y < 2014 ? '2.4 L V8 自然進氣' : '1.6 L V6 渦輪混合動力', count: 12 });
}

const ERS = { store: 5000, power: 60, harvest: 40 };
const list2026 = () => CARS26.map(c => ({
  id: '2026-' + c.id, year: 2026, team: c.teamEn, teamZh: c.teamZh, car: c.car, engine: c.engine,
  colour: c.colour, colour2: c.colour2, ratings: Object.assign({}, c.ratings), note: c.note, ers: ERS,
  cylinders: 6, aspiration: 'hybrid', cockpit: 'halo18'
}));

const T12 = [
  ['standard', 'F1Drive', 'F1Drive', '標準賽車', '標準引擎（2.4 L V8）', '#9AA0A6', '#2B2F36', [50, 50, 50, 50], '這一年的基準車：所有倍率都是 1。'],
  ['red-bull', 'Red Bull', '紅牛', 'RB8', 'Renault RS27-2012', '#1B2A5C', '#E8C21C', [52, 60, 78, 72], '下壓力最強，彎道與煞車領先全場，極速偏低。'],
  ['mclaren', 'McLaren', '麥拉倫', 'MP4-27', 'Mercedes FO 108Z', '#C0C0C0', '#E8272D', [66, 64, 70, 66], '全年最快的車之一，但可靠度與進站失誤讓它丟分。'],
  ['ferrari', 'Ferrari', '法拉利', 'F2012', 'Ferrari 056', '#D40000', '#F2F2F2', [58, 55, 56, 60], '開季很慢，靠車手把握機會一路追到最後一站。'],
  ['mercedes', 'Mercedes', '賓士', 'F1 W03', 'Mercedes FO 108Z', '#BFC4C7', '#00A19C', [70, 58, 44, 50], '長直線很快（雙 DRS），但後胎磨耗嚴重、正賽掉速。'],
  ['lotus', 'Lotus', '蓮花', 'E20', 'Renault RS27-2012', '#111111', '#C9A227', [48, 57, 66, 62], '輪胎管理出色，正賽節奏常常比排位更好。'],
  ['force-india', 'Force India', '印度力量', 'VJM05', 'Mercedes FO 108Z', '#F0F0F0', '#FF7F00', [60, 52, 45, 47], '中段班的常客，直線速度不錯。'],
  ['sauber', 'Sauber', '索伯', 'C31', 'Ferrari 056', '#FFFFFF', '#1E1E3C', [50, 54, 55, 58], '對輪胎溫和，偶爾能跑上頒獎台。'],
  ['toro-rosso', 'Toro Rosso', '紅牛二隊', 'STR7', 'Ferrari 056', '#1B2A5C', '#C8102E', [47, 46, 40, 42], '年輕車手的練兵場，整體中規中矩偏弱。'],
  ['williams', 'Williams', '威廉斯', 'FW34', 'Renault RS27-2012', '#0A1E46', '#FFFFFF', [49, 50, 52, 49], '單圈速度不差，拿下西班牙站冠軍。'],
  ['caterham', 'Caterham', '卡特漢', 'CT01', 'Renault RS27-2012', '#0C5A36', '#E6C200', [35, 30, 22, 25], '新車隊之首，但與中段班仍有一秒以上差距。'],
  ['marussia', 'Marussia', '瑪魯西亞', 'MR01', 'Cosworth CA2012', '#1A1A1A', '#C8102E', [28, 22, 15, 18], '沒有 KERS 的小車隊，常在最後一排起跑。']
];
const list2012 = () => T12.map(t => ({
  id: '2012-' + t[0], year: 2012, team: t[1], teamZh: t[2], car: t[3], engine: t[4], colour: t[5], colour2: t[6],
  ratings: { topSpeed: t[7][0], accel: t[7][1], cornering: t[7][2], braking: t[7][3], ers: null }, note: t[8], ers: null,
  cylinders: 8, aspiration: 'na', cockpit: 'modern'
}));

/* ---------- GpViews (as js/gp.js + main.js hand them to setGp) ---------- */
const COLOURS = ['#ff7a14', '#e10600', '#1e6bff', '#19c8e6', '#35d07f', '#ffd21e', '#c04bff', '#f2f4f7'];
const NAMES = ['Max 維斯塔潘', '車手417', 'Lewis', 'Charles Leclerc16', '小明', 'Fernando_Alonso!', '阿土伯', 'Yuki 角田',
  'A', '<b>x</b><img src=x>', '王大明王大明王大明王大明王大明王', 'Oscar', 'Lando', 'George R.', 'Checo', 'Nico H'];
const C26 = list2026();
const driver = (i, withCar) => Object.assign({ id: i + 1, name: NAMES[i], colour: COLOURS[i % COLOURS.length] },
  withCar ? { team: C26[i % 12].teamZh + ' ' + C26[i % 12].car, colour2: C26[i % 12].colour } : {});
const row = (i, selfIdx, o, withCar) => Object.assign({ pos: i + 1, isSelf: i === selfIdx, laps: 0, best: null, time: null, gap: null, down: 0,
  done: false, dnf: false, left: false }, driver(i, withCar), o);
const base = o => Object.assign({ phase: 'free', online: false, canControl: true, taking: false, spectating: false, q: 3, r: 5,
  year: null, wear: 1, lap: 0, lapTotal: 0, pos: 0, count: 0, done: false, endsInMs: null, rows: [], spectators: [], canStart: true, startHint: '' }, o);

const V = {
  freeTrack: base({}),
  freeNoTrack: base({ canStart: false, startHint: '先選一條賽道' }),
  freeHost: base({ online: true }),
  freeGuest: base({ online: true, canControl: false, canStart: false }),
  quali3: o => base(Object.assign({ phase: 'quali', online: true, taking: true, year: 2026, wear: 3, lap: 1, lapTotal: 3, pos: 2, count: 3, rows: [
    row(0, 1, { laps: 3, best: 83.456, done: true }, true), row(1, 1, { laps: 1, best: 84.012 }, true), row(2, 1, { laps: 0 }, true)] }, o)),
  race16: o => {
    const rows = [];
    for (let i = 0; i < 16; i++) {
      const r = { laps: 4, best: 83.4 + i * 0.37, gap: i * 2.137 };
      if (i === 0) { r.laps = 5; r.done = true; r.time = 431.234; r.gap = null; r.best = 84.9; }
      if (i === 12) { r.laps = 3; r.gap = null; r.down = 1; }
      if (i === 14) { r.laps = 2; r.gap = null; r.dnf = true; }
      rows.push(row(i, 4, r, true));
    }
    return base(Object.assign({ phase: 'race', online: true, taking: true, year: 2026, wear: 2, lap: 4, lapTotal: 5, pos: 5, count: 16, endsInMs: 83000, rows }, o));
  },
  results16: o => {
    const rows = [];
    for (let i = 0; i < 16; i++) {
      const r = { laps: 5, best: 83.4 + i * 0.37, done: true, time: 431.234 + i * 2.137, gap: i ? i * 2.137 : null };
      if (i === 2) r.best = 82.901;
      if (i === 14) { r.laps = 2; r.gap = null; r.done = false; r.time = null; }
      if (i === 15) { r.laps = 1; r.gap = null; r.done = false; r.time = null; r.dnf = true; r.left = true; r.colour = '#888888'; }
      rows.push(row(i, 4, r, true));
    }
    return base(Object.assign({ phase: 'results', online: true, taking: true, year: 2026, wear: 2, lap: 5, lapTotal: 5, pos: 5, count: 16, done: true, rows,
      spectators: [{ id: 40, name: '晚到的小華', colour: '#19c8e6' }] }, o));
  }
};
const roster = n => { const a = []; for (let i = 0; i < n; i++) a.push(Object.assign(driver(i), { best: i % 3 ? 83.4 + i : null, isHost: i === 0, isSelf: i === 1 })); return a; };
const NET = {
  off: { canCreate: true, connected: false, busy: false, isHost: false, hostInfo: null, roster: [], status: '', statusKind: '', lockText: '' },
  host: n => ({ canCreate: true, connected: true, busy: false, isHost: true, hostInfo: { port: 24500, addresses: ['192.168.1.23'] },
    roster: roster(n).map((p, i) => Object.assign(p, { isHost: i === 1 })), status: '房間已建立，你是房主。', statusKind: 'ok', lockText: '', roomTrack: true }),
  guest: n => ({ canCreate: true, connected: true, busy: false, isHost: false, hostInfo: null, roster: roster(n), status: '已加入房間。', statusKind: 'ok', lockText: '', roomTrack: true })
};

/* ---------- telemetry frames (the fields main.js adds to its HUD object) ---------- */
const TEL = o => Object.assign({ speedKmh: 243, gear: 6, rpm: 11100, rpmIdle: 4000, rpmShift: 11800, rpmMax: 12500, throttle: 1, brake: 0,
  battery: 0.72, deploy: 0, harvest: 0, limiter: false, inPit: false, limitKmh: 80,
  tyres: { compound: 'M', wear: [0.12, 0.14, 0.1, 0.11], flat: [0, 0, 0, 0], puncture: -1 }, nextCompound: 'H',
  team: '麥拉倫 McLaren', car: 'MCL40', colour: '#F4872C', colour2: '#141212' }, o);

/* ---------- pit states (what main.js builds from F1.createPit().state) ---------- */
// (v6.2: main.js always hands `next`, the compound of the next set: the strip's line 下一組：中性胎（T / X 切換）)
const PIT = {
  off: { inLane: false, limiter: false, speeding: false, service: null, limitKmh: 80, boxAhead: null, slot: 2, next: 'M' },
  limiterOnTrack: { inLane: false, limiter: true, speeding: false, service: null, limitKmh: 80, boxAhead: null, slot: 2, next: 'M' },
  laneAhead: { inLane: true, limiter: true, speeding: false, service: null, limitKmh: 80, boxAhead: 45.3, slot: 2, next: 'M' },
  laneNoLimiter: { inLane: true, limiter: false, speeding: false, service: null, limitKmh: 80, boxAhead: 120, slot: 2, next: 'S' },
  speeding: { inLane: true, limiter: false, speeding: true, service: null, limitKmh: 60, boxAhead: 88, slot: 2, pending: 5, next: 'H' },
  atBox: { inLane: true, limiter: true, speeding: false, service: null, limitKmh: 80, boxAhead: 0.8, slot: 2, next: 'H' },
  passed: { inLane: true, limiter: true, speeding: false, service: null, limitKmh: 80, boxAhead: -14, slot: 2, pending: 5, next: 'M' },
  serviceTyres: { inLane: true, limiter: true, speeding: false, service: { total: 3.1, left: 2.26, penalty: 0 }, limitKmh: 80, boxAhead: 0.2, slot: 2, next: 'M' },
  servicePenalty: { inLane: true, limiter: true, speeding: false, service: { total: 7.8, left: 6.5, penalty: 5 }, limitKmh: 80, boxAhead: 0.2, slot: 2, next: 'M' },
  serviceAfterPenalty: { inLane: true, limiter: true, speeding: false, service: { total: 7.8, left: 1.34, penalty: 5 }, limitKmh: 80, boxAhead: 0.2, slot: 2, next: 'H' }
};

module.exports = { SEASONS, list2026, list2012, V, NET, row, base, TEL, PIT };
