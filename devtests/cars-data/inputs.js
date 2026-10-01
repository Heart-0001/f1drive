// F1Drive - car-selection data: the real-world inputs of the 2026 season, each with its source.
//
// Season: 2026 FIA Formula One World Championship, data as of 2026-09-30, after round 15 of the races held
// (Azerbaijan GP, 26 Sep 2026). 11 teams. Collected by two research passes (performance, identity) and
// spot-checked again when this file was written (standings, qualifying gaps, FIA ADUO bands, regulations).
// Nothing here is an official specification: see docs/cars-data-sources.md.
//
// "computed" = computed by the researchers from the official timing data behind the URL (the API returns raw
// laps / telemetry), not a number published by that site.
'use strict';

const SEASON = {
  year: 2026,
  asOf: '2026-09-30',
  lastRound: 15,
  lastRace: '2026-09-26 的亞塞拜然大獎賽',
  roundsHeld: ['AUS', 'CHN', 'JPN', 'MIA', 'CAN', 'MON', 'BCN', 'AUT', 'GBR', 'BEL', 'HUN', 'NED', 'ITA', 'MAD', 'AZE'],
  // the same 15 circuits in the game (tracks-data.js ids), used for the lap-time estimate
  trackIds: ['au-1953', 'cn-2004', 'jp-1962', 'us-2022', 'ca-1978', 'mc-1929', 'es-1991', 'at-1969', 'gb-1948',
    'be-1925', 'hu-1986', 'nl-1948', 'it-1922', 'es-2026', 'az-2016']
};

// ---- sources ----------------------------------------------------------------------------------------------
const SOURCES = {
  standings: {
    title: 'formula1.com 2026 車隊積分榜；Jolpica (Ergast) constructorStandings，第 15 站後',
    urls: ['https://www.formula1.com/en/results/2026/team', 'https://api.jolpi.ca/ergast/f1/2026/constructorstandings.json']
  },
  quali: {
    title: 'Jolpica (Ergast) 排位賽成績，第 1–15 站（計算值：各隊 Q1/Q2/Q3 最快圈 ÷ 該場最快圈 − 1，15 站平均）',
    urls: ['https://api.jolpi.ca/ergast/f1/2026/1/qualifying.json', 'https://api.jolpi.ca/ergast/f1/2026/15/qualifying.json']
  },
  race: {
    title: 'OpenF1 正賽單圈（計算值：各隊較快車的綠旗圈中位數 ÷ 最快車隊 − 1，取 15 站中位數；未修正油量、輪胎、藍旗）',
    urls: ['https://api.openf1.org/v1/laps?session_key=11377']
  },
  autosport: {
    title: 'Autosport 2026-08-19「How much performance has each F1 team gained over 2026」：supertimes 換算的預期圈速（澳洲–中國平均、比利時–匈牙利平均）',
    urls: ['https://www.autosport.com/f1/news/how-much-performance-has-each-f1-team-gained-over-2026/10846928/']
  },
  trap: {
    title: 'OpenF1 st_speed，15 場排位賽的測速點最高速（計算值：各隊最佳 − 全場中位數，km/h，15 站平均）',
    urls: ['https://api.openf1.org/v1/laps?session_key=11357']
  },
  telemetry: {
    title: 'OpenF1 car_data，各隊每站最快排位圈的遙測（計算值：分區時間相對全場中位數，%；負值 = 較快；約 3.7 Hz，每隊每站一圈）',
    urls: ['https://api.openf1.org/v1/car_data?session_key=11357&driver_number=63']
  },
  aduo: {
    title: 'FIA ADUO 內燃機性能指數：第一次檢視（到加拿大站為止；Sky Sports 2026-06-07）Red Bull Ford 為基準、Mercedes 落後 2–4 %、Ferrari / Audi / Honda 落後超過 4 %；第二次檢視（到匈牙利站；Pitpass 2026-08-26）沒有再給任何廠商額外升級（只衡量內燃機，不含電能）',
    urls: ['https://www.skysports.com/f1/news/13551591/aduo-in-f1-red-bull-engine-top-rated-by-fia-as-mercedes-ferrari-granted-upgrades-for-2026-formula-1-season',
      'https://www.pitpass.com/83381/FIA-reveals-ADUO-rankings']
  },
  rules: {
    title: 'formula1.com 2026 規則說明：內燃機約 400 kW、電動 350 kW（約 50:50）',
    urls: ['https://www.formula1.com/en/latest/article/fia-unveils-formula-1-regulations-for-2026-and-beyond-featuring-more-agile.75qJiYOHXgeJqsVQtDr2UB']
  },
  weakness: {
    title: 'The Race 2026-04-26「Every 2026 F1 team\'s big weakness」',
    urls: ['https://www.the-race.com/formula-1/every-2026-f1-team-big-weakness/']
  },
  mercedesEdge: {
    title: 'Autosport 2026-03-10「How Mercedes\' advantage in F1 2026 goes beyond the engine」',
    urls: ['https://www.autosport.com/f1/news/how-mercedes-advantage-in-f1-2026-goes-beyond-the-engine/10803973/']
  },
  teamByTeam: {
    title: 'Autosport 2026-04-14「How every F1 2026 team has performed so far」',
    urls: ['https://www.autosport.com/f1/news/how-every-f1-2026-teams-performed-so-far-team-by-team/10812457/']
  },
  monzaEnergy: {
    title: 'The Race 2026-09-05「What F1 teams\' Monza deployment patterns have revealed」（義大利站第二次練習的電能部署分析）',
    urls: ['https://www.the-race.com/formula-1/f1-teams-monza-italian-gp-early-energy-depoyment-patterns/']
  },
  redBullPace: {
    title: 'Motorsport.com 2026-04-11「Red Bull\'s 2026 F1 pace is its slowest since 2015」；PlanetF1 2026-03-16「Why Red Bull are slow」',
    urls: ['https://www.motorsport.com/f1/news/analysis-red-bulls-2026-f1-pace-is-its-slowest-since-2015/10812084/',
      'https://www.planetf1.com/chinese-grand-prix/why-red-bull-are-slow-2026-max-verstappen-rb22-problems']
  },
  gradeRedBull: {
    title: 'Motorsport.com 2026-08-13 季中評分：Red Bull',
    urls: ['https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-red-bull-stumbles-but-summer-rally-shows-glimmer-of-progress/10845430/']
  },
  gradeFerrari: {
    title: 'Motorsport.com 2026-08-15 季中評分：Ferrari',
    urls: ['https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-innovative-ferrari-impresses-with-strong-start/10846497/']
  },
  gradeMcLaren: {
    title: 'Motorsport.com 2026-08-15 季中評分：McLaren',
    urls: ['https://motorsport.com/f1/news/f1-2026-mid-season-grades-mclaren-starts-on-the-back-foot-but-makes-rapid-progress/10846244/']
  },
  gradeRacingBulls: {
    title: 'Motorsport.com 2026-08-12 季中評分：Racing Bulls',
    urls: ['https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-racing-bulls-stuns-midfield-pack-/10845309/']
  },
  gradeAlpine: {
    title: 'Motorsport.com 2026-08-11 季中評分：Alpine；formula1.com 2026-09-05 Monza 排位賽報導',
    urls: ['https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-alpine-makes-great-strides-but-struggles-to-maintain-momentum/10845239/',
      'https://www.formula1.com/en/latest/article/gasly-charges-to-sensational-maiden-f1-pole-at-monza-over-russell-and-piastri.4CKkkbvgmqL04ijMNBfuXF']
  },
  gradeHaas: {
    title: 'Motorsport.com 2026-08-10 季中評分：Haas',
    urls: ['https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-haas-gets-left-behind-after-strong-start/10845177/']
  },
  gradeAudi: {
    title: 'Motorsport.com 2026-08-09 季中評分：Audi；Autosport 2026-08-01「Audi won\'t upgrade F1 power unit again until 2027」',
    urls: ['https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-audi-gets-off-to-solid-start-on-works-debut/10845164/',
      'https://www.autosport.com/f1/news/audi-wont-upgrade-f1-power-unit-again-until-2027/10843491/']
  },
  gradeWilliams: {
    title: 'Motorsport.com 2026-08-08 季中評分：Williams（Yahoo 轉載）；Crash.net 2026-09-25 Baku 升級（較輕的底盤與新空力套件）',
    urls: ['https://sports.yahoo.com/articles/f1-2026-mid-season-grades-williams-takes-shocking-step-backwards-090346348.html',
      'https://www.crash.net/f1/news/1105267/1/early-verdict-williams-big-azerbaijan-grand-prix-f1-upgrade-package']
  },
  gradeAston: {
    title: 'Motorsport.com 2026-08-07 季中評分：Aston Martin',
    urls: ['https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-aston-martin-seeks-redemption-after-shocking-start/10844630/']
  },
  gradeCadillac: {
    title: 'Motorsport.com 2026-08-06 季中評分：Cadillac',
    urls: ['https://au.motorsport.com/f1/news/f1-2026-mid-season-grades-cadillac-gets-off-to-respectable-start-to-its-adventure/10844401/']
  },
  gradeMercedes: {
    title: 'Motorsport.com 2026-08-16 季中評分：Mercedes（Yahoo 轉載）；The Race 2026-06-17「The true cost of Mercedes\' biggest 2026 weakness」（可靠度）',
    urls: ['https://sports.yahoo.com/articles/f1-2026-mid-season-grades-mercedes-early-dominance-evaporates-as-reliability-woes-strike-113002800.html',
      'https://www.the-race.com/formula-1/the-true-cost-of-mercedes-biggest-2026-weakness/']
  },
  identity: {
    title: 'formula1.com 各車隊頁（Full Team Name / Chassis / Power Unit，例如 /en/teams/mercedes）；Wikipedia 2026 賽季報名表；動力單元全名見 Wikipedia 車款條目（例：Mercedes W17 的「Mercedes-AMG F1 M17 E Performance」）',
    urls: ['https://www.formula1.com/en/teams', 'https://en.wikipedia.org/wiki/2026_Formula_One_World_Championship',
      'https://en.wikipedia.org/wiki/Mercedes_W17']
  },
  timingColour: {
    title: 'OpenF1 drivers（F1 官方即時計時的 team_colour）',
    urls: ['https://api.openf1.org/v1/drivers?session_key=11377']
  },
  upgrades: {
    title: '季中大改版：Red Bull 首批升級在邁阿密、奧地利站大改（Crash.net 2026-06-26；formula1.com 2026-06-26「significant upgrade package」）；Alpine 荷蘭站首個大型升級（formula1.com）',
    urls: ['https://www.crash.net/f1/news/1099336/1/red-bull-reveals-seven-part-upgrade-crucial-home-austria-f1-race',
      'https://www.formula1.com/en/latest/article/all-the-details-on-red-bulls-significant-upgrade-package-and-every-other-teams-updates-in-austria.HWTF5D6l7LfVlTD9PX59K',
      'https://www.formula1.com/en/latest/article/how-alpines-dutch-gp-upgrades-have-propelled-gasly-to-the-front-of-the-midfield-battle.66MuOGDn4ewCtYgzQUUShR']
  },
  cadillacLivery: {
    title: 'Cadillac 自奧地利站起改用左右對稱、以白為主的塗裝（Motorsport.com「Why Cadillac abandoned its split F1 livery」；Wikipedia Cadillac MAC-26）',
    urls: ['https://www.motorsport.com/f1/news/why-cadillac-has-abandoned-its-split-f1-livery/10839741/', 'https://en.wikipedia.org/wiki/Cadillac_MAC-26']
  },
  zhNames: {
    title: '台灣的隊名寫法：ETtoday、TVBS、NOWnews、民視、聯合新聞網、台灣車迷站 F-1.TW 積分榜；Alpine 寫英文的例子：Red Bull 台灣官網、美麗佳人',
    urls: ['https://speed.ettoday.net/news/3133372', 'https://news.tvbs.com.tw/sports/3151931', 'https://sports.ettoday.net/news/3156026',
      'https://www.nownews.com/news/6762442', 'https://sport.ftvnews.com.tw/news/detail/2026608W0004', 'https://udn.com/news/story/7005/9178721',
      'https://f-1.tw/standings/', 'https://www.redbull.com/tw-zh/formula-one-teams-and-drivers-guide', 'https://www.marieclaire.com.tw/lifestyle/issue/90444']
  }
};

// ---- power units ------------------------------------------------------------------------------------------
// aduoIcePct: FIA ADUO internal-combustion index relative to the benchmark (source: aduo). The FIA publishes
//   bands only: benchmark = 0; "2-4 % behind" -> the middle of the band, -3; "more than 4 % behind" is open-ended:
//   the nominal value -5 (one point beyond the threshold) is OUR assumption, flagged in the documentation.
// aduoOpenEnded: the band has no lower limit, so the FIA value is only an upper bound for the engine.
// ersRank: ordinal score for energy recovery / management from the press reports (no public measurement
//   exists): +2 best .. -3 worst; the works Mercedes team gets one step more than its customers (see TEAMS).
const POWER_UNITS = {
  mercedes: {
    supplier: 'Mercedes', engine: 'Mercedes-AMG F1 M17 E Performance', aduoIcePct: -3, aduoOpenEnded: false, ersRank: 1,
    ersBasis: '「outstanding when it comes to the integration of harvesting and aerodynamic characteristics. The ERS is efficient」（The Race）；排位圈以 super clipping 為主要回充方式（Autosport）；廠隊再 +1：McLaren 領隊 Stella 承認與 Mercedes 廠隊有「gap in hybrid usage」（Autosport），其他客戶隊沒有直接報導，比照 McLaren 是我們的推論',
    src: ['aduo', 'weakness', 'mercedesEdge']
  },
  ferrari: {
    supplier: 'Ferrari', engine: 'Ferrari 067/6', aduoIcePct: -5, aduoOpenEnded: true, ersRank: -1,
    ersBasis: '小渦輪反應快、起跑好，但峰值馬力較低，電池為了補償而消耗得快（The Race）；回充較依賴 lift-and-coast（Autosport）',
    src: ['aduo', 'weakness', 'mercedesEdge']
  },
  redbullford: {
    supplier: 'Red Bull Ford', engine: 'Red Bull Ford DM01', aduoIcePct: 0, aduoOpenEnded: false, ersRank: 0,
    ersBasis: '報導不一致：內燃機是 FIA 基準，但「energy deployment and lack of driveability」被點名（Motorsport.com 8 月）；高速彎中的能量回收效率明顯不如 Mercedes（PlanetF1，3 月）→ 取中性',
    src: ['aduo', 'gradeRedBull', 'redBullPace']
  },
  audi: {
    supplier: 'Audi', engine: 'Audi AFR 26 Hybrid', aduoIcePct: -5, aduoOpenEnded: true, ersRank: -2,
    ersBasis: '「less efficient energy management」（Autosport 4 月）；動力不足「snowballs into higher battery deployment」（Motorsport.com 8 月）',
    src: ['aduo', 'teamByTeam', 'gradeAudi']
  },
  honda: {
    supplier: 'Honda', engine: 'Honda RA626H', aduoIcePct: -5, aduoOpenEnded: true, ersRank: -3,
    ersBasis: 'V6 馬力不足、更依賴電能，「energy recovery efficiency」也有問題，震動曾損壞電池（The Race）',
    src: ['aduo', 'weakness', 'gradeAston']
  }
};

// ---- teams ------------------------------------------------------------------------------------------------
// Numbers per team (sources in METRICS below):
//   qualiGapPct    qualifying, mean gap to the fastest lap of the session, 15 rounds, %
//   raceGapPct     race pace, median gap to the fastest team, %
//   autosport      Autosport expected lap time, s: [AUS-CHN average, BEL-HUN average]
//   vmaxKmh        peak speed on the best qualifying lap vs field median, km/h
//   trapKmh        qualifying speed trap vs field median, km/h
//   ft, traction, endStraight, slow, medium, fast, entry
//                  time in the zone vs field median on the best qualifying lap, % (negative = faster):
//                  full-throttle zones; first 150 m after slow corners; last third of long straights;
//                  slow / medium / fast corner zones; slow-corner entry (braking + turn-in)
//   clipKmh        speed lost from the peak to the end of long full-throttle zones, km/h (reported only:
//                  the front-runners clip on purpose, so it is NOT used in the formula)
const TEAMS = [
  {
    id: 'mercedes', teamZh: '賓士', teamEn: 'Mercedes', fullName: 'Mercedes-AMG PETRONAS Formula One Team',
    car: 'W17', pu: 'mercedes', works: true, ersAdj: 1,
    colour: '#0F100F', colour2: '#BDBCBA', colourTeam: '#00D7B6',
    colourNote: '車身黑（引擎蓋取樣）、銀（車鼻 / 座艙周圍），Petronas 青綠飾條 #37C2B8',
    standing: { pos: 1, points: 538, wins: 11 },
    qualiGapPct: 0.039, raceGapPct: 0.000, autosport: [86.211, 85.218],
    vmaxKmh: 2.3, trapKmh: 1.9,
    ft: -1.08, traction: -1.17, endStraight: -0.90, slow: -1.57, medium: -2.88, fast: -2.31, entry: -1.88, clipKmh: 26.5,
    note: '全能標竿：加速、煞車與電能管理都是全場最佳，彎道也是頂尖；真實弱點是起跑與可靠度。',
    basis: '前 10 站全部桿位、11 勝；The Race：ERS 整合、後下壓力、牽引與煞車強，起跑與亂流中部署較弱；遙測：全油門區、牽引區、直線末段、中速彎皆最快',
    src: ['weakness', 'mercedesEdge', 'gradeMercedes', 'telemetry']
  },
  {
    id: 'ferrari', teamZh: '法拉利', teamEn: 'Ferrari', fullName: 'Scuderia Ferrari HP',
    car: 'SF-26', pu: 'ferrari', works: true,
    colour: '#BB1320', colour2: '#DDDDDC', colourTeam: '#ED1131',
    colourNote: '亮面紅（官方圖有陰影，受光處可達 #D22A2F）、引擎蓋 / 進氣口白',
    standing: { pos: 2, points: 378, wins: 2 },
    qualiGapPct: 0.402, raceGapPct: 0.343, autosport: [86.990, 85.301],
    vmaxKmh: -0.1, trapKmh: 1.2,
    ft: -0.16, traction: -1.11, endStraight: 0.43, slow: -1.95, medium: -2.86, fast: -2.40, entry: -1.76, clipKmh: 29.7,
    note: '彎道頂尖、出彎俐落，但動力單元偏弱，長直線尾段會掉速。',
    basis: 'The Race：「best car in terms of corner performance」、引擎約少 20 bhp（傳聞）；Motorsport.com：直線上輸 Mercedes 數個十分之一秒；遙測：慢彎、高速彎最快，直線末段慢於中位數',
    src: ['weakness', 'gradeFerrari', 'monzaEnergy', 'telemetry']
  },
  {
    id: 'mclaren', teamZh: '麥拉倫', teamEn: 'McLaren', fullName: 'McLaren Mastercard F1 Team',
    car: 'MCL40', pu: 'mercedes', works: false,
    colour: '#F4872C', colour2: '#141212', colourTeam: '#F47600',
    colourNote: '木瓜橘、黑 / 碳灰，進氣口藍綠 #1C6B8A',
    standing: { pos: 3, points: 306, wins: 2 },
    qualiGapPct: 0.454, raceGapPct: 0.527, autosport: [87.011, 85.255],
    vmaxKmh: -1.5, trapKmh: -0.9,
    ft: -0.58, traction: -0.68, endStraight: 0.43, slow: -1.28, medium: -2.35, fast: -2.35, entry: -1.58, clipKmh: 28.2,
    note: '彎道強，季中升級後拿下分站冠軍；但在同一具 Mercedes 動力中直線最慢，極速是前段班最低。',
    basis: '開季下壓力 / 氣動效率不足（The Race 4 月、Autosport 3 月），邁阿密–蒙特婁與匈牙利的升級後匈牙利、荷蘭奪勝（Motorsport.com）；Stella 承認與 Mercedes 廠隊有「gap in hybrid usage」（Autosport）；Monza 在三條長直線上都輸，技術總監稱「from an energy perspective」仍待加強（The Race）；用同一具 Mercedes 動力的四隊中極速最低（遙測 −1.5 km/h、測速點 −0.9 km/h）。遊戲把這個差距放在 drag 上（見步驟 3），真實原因是風阻還是電能運用，公開資料分不出來',
    src: ['weakness', 'mercedesEdge', 'gradeMcLaren', 'monzaEnergy', 'trap', 'telemetry']
  },
  {
    id: 'red-bull', teamZh: '紅牛', teamEn: 'Red Bull', fullName: 'Oracle Red Bull Racing',
    car: 'RB22', pu: 'redbullford', works: true,
    colour: '#051F94', colour2: '#D9131C', colourTeam: '#4781D7',
    colourNote: '亮面深藍、紅（黃色 #E9D254 點綴），下車身黑',
    standing: { pos: 4, points: 263, wins: 0 },
    qualiGapPct: 0.591, raceGapPct: 0.700, autosport: [87.390, 85.493],
    vmaxKmh: 0.1, trapKmh: -0.1,
    ft: -0.65, traction: -0.47, endStraight: -0.47, slow: -1.24, medium: -1.75, fast: -0.87, entry: -1.51, clipKmh: 26.1,
    note: '內燃機是 FIA 評定的基準（最強），但全季極速只在中位數；底盤難調，高速彎是前四強中最弱。',
    basis: 'FIA ADUO：Red Bull Ford 內燃機為基準；Motorsport.com 4 月：時間主要輸在彎道，車子太偏向低風阻、下壓力不足；PlanetF1：高速彎後輪不穩；Motorsport.com 8 月：車子難調、操控難以預測；The Race：彎中推頭；全季平均的測速點 −0.1 km/h、最快圈極速 +0.1 km/h（中位數）；遙測：全油門區第 2，高速彎僅 −0.87 %（前四隊其餘三隊約 −2.3 %）',
    src: ['aduo', 'redBullPace', 'gradeRedBull', 'weakness', 'trap', 'telemetry']
  },
  {
    id: 'racing-bulls', teamZh: '小紅牛', teamEn: 'Racing Bulls', fullName: 'Visa Cash App Racing Bulls Formula One Team',
    car: 'VCARB 03', pu: 'redbullford', works: false,
    colour: '#D6D6D5', colour2: '#08419E', colourTeam: '#6C98FF',
    colourNote: '白（官方圖取樣偏灰）、藍，紅色 #DD111B 點綴',
    standing: { pos: 5, points: 83, wins: 0 },
    qualiGapPct: 1.441, raceGapPct: 1.916, autosport: [88.123, 86.006],
    vmaxKmh: -0.2, trapKmh: 1.9,
    ft: -0.30, traction: 0.16, endStraight: -0.52, slow: -0.23, medium: -0.06, fast: 0.62, entry: -0.78, clipKmh: 23.5,
    note: '中段班最快：直線速度名列前茅（測速點全季平均僅次於 Alpine），彎道中規中矩、調校窗口窄。',
    basis: 'Motorsport.com：蒙特婁的新底板讓車「switched on」、「better-than-expected power unit」；The Race：調校窗口窄、很容易開過頭，煞車仍有些不穩；測速點全季平均 +1.9 km/h（與 Mercedes 並列第 2）；遙測：直線末段第 3 佳、掉速最少，高速彎與慢彎出彎略慢；全季進步幅度最大（Autosport 2.117 秒）',
    src: ['gradeRacingBulls', 'weakness', 'autosport', 'trap', 'telemetry']
  },
  {
    id: 'alpine', teamZh: 'Alpine', teamEn: 'Alpine', fullName: 'BWT Alpine Formula One Team',
    car: 'A526', pu: 'mercedes', works: false,
    colour: '#3190D5', colour2: '#EC6EAF', colourTeam: '#00A1E8',
    colourNote: 'Alpine 藍、BWT 粉紅',
    standing: { pos: 6, points: 68, wins: 0 },
    qualiGapPct: 1.555, raceGapPct: 1.762, autosport: [87.853, 86.835],
    vmaxKmh: 4.0, trapKmh: 3.3,
    ft: -0.15, traction: 0.09, endStraight: -0.28, slow: 0.33, medium: 0.82, fast: 0.76, entry: 0.36, clipKmh: 28.7,
    note: '全場極速最高（Monza 桿位），但高速彎推頭、下壓力不足。',
    basis: '測速點全季平均最高（+3.3 km/h）、最快圈極速最高（+4.0 km/h）；荷蘭站大型升級後 Gasly 在 Monza 奪下生涯首個桿位；The Race：「understeer that\'s particularly costly at high speed」；Motorsport.com：匈牙利時「lacking downforce」；遙測：三種彎都慢於中位數。同一具 Mercedes 動力卻最快，遊戲把它放在 drag 上（見步驟 3）',
    src: ['trap', 'gradeAlpine', 'upgrades', 'weakness', 'telemetry']
  },
  {
    id: 'haas', teamZh: '哈斯', teamEn: 'Haas', fullName: 'TGR Haas F1 Team',
    car: 'VF-26', pu: 'ferrari', works: false,
    colour: '#D0D0CF', colour2: '#E51112', colourTeam: '#9C9FA2',
    colourNote: '白（取樣偏灰）、紅（取樣的點綴色；Wikipedia：「white and red livery」），另有黑 #161616',
    standing: { pos: 7, points: 27, wins: 0 },
    qualiGapPct: 2.275, raceGapPct: 2.307, autosport: [88.064, 87.529],
    vmaxKmh: -0.2, trapKmh: -0.5,
    ft: 0.63, traction: 0.31, endStraight: 0.06, slow: 1.10, medium: 1.65, fast: 0.87, entry: 1.91, clipKmh: 24.0,
    note: '開季正賽表現亮眼，但全季進步幅度最小、單圈速度偏弱，慢彎入彎是弱點。',
    basis: 'The Race：單圈只是第 8 快，但正賽穩定得分；Autosport：開季到比利時–匈牙利只快了 0.535 秒，全場最少；Motorsport.com：跟不上對手的升級節奏、部分零件品質不一；遙測：慢彎入彎 +1.91 %（它最弱的區段）、出彎接近中位數、掉速第 2 少',
    src: ['weakness', 'gradeHaas', 'autosport', 'telemetry']
  },
  {
    id: 'audi', teamZh: '奧迪', teamEn: 'Audi', fullName: 'Audi Revolut F1 Team',
    car: 'R26', pu: 'audi', works: true,
    colour: '#8F8881', colour2: '#EA0F06', colourTeam: '#F50537',
    colourNote: '鈦銀灰、Audi 紅（2026 奧地利站照片取樣；官方圖為 #C8C6C4 / #FF3835），引擎蓋碳黑',
    standing: { pos: 8, points: 17, wins: 0 },
    qualiGapPct: 1.728, raceGapPct: 2.074, autosport: [88.250, 86.416],
    vmaxKmh: -0.3, trapKmh: 1.0,
    ft: 0.23, traction: 0.14, endStraight: 0.05, slow: 0.18, medium: -0.72, fast: -0.47, entry: 0.41, clipKmh: 29.1,
    note: '底盤不錯，中高速彎是中段班最好的之一；自製動力單元能量管理較差、起跑吃虧。',
    basis: 'Motorsport.com：Binotto「Regarding the chassis, however, I\'m very satisfied」、動力單元不及 Mercedes、起跑「abysmal」；Autosport：「less efficient energy management」；The Race：前 6 次起跑 5 次掉位；遙測：中速彎 −0.72 %、高速彎 −0.47 %（前四隊之外最快），直線掉速第 3 多',
    src: ['gradeAudi', 'teamByTeam', 'weakness', 'telemetry']
  },
  {
    id: 'williams', teamZh: '威廉斯', teamEn: 'Williams', fullName: 'Atlassian Williams F1 Team',
    car: 'FW48', pu: 'mercedes', works: false,
    colour: '#0B33F2', colour2: '#27A3CF', colourTeam: '#1868DB',
    colourNote: '亮面藍、淺藍（側箱），另有白 #C9C9C8',
    standing: { pos: 9, points: 12, wins: 0 },
    qualiGapPct: 2.736, raceGapPct: 2.725, autosport: [88.975, 88.026],
    vmaxKmh: 0.4, trapKmh: 0.5,
    ft: 0.58, traction: 0.21, endStraight: -0.55, slow: 1.79, medium: 1.69, fast: 2.74, entry: 2.17, clipKmh: 26.5,
    note: '開季超重又缺下壓力，彎道與煞車吃虧；靠 Mercedes 動力，直線速度仍在中位數以上。',
    basis: 'The Race：開季超重達 30 kg（約 0.9 秒）、下壓力也不夠；Motorsport.com：「significantly overweight and lacked aerodynamic load」，在高速、高下壓力賽道最差；測速點 +0.5 km/h、最快圈極速 +0.4 km/h；遙測：直線末段 −0.55 %，高速彎 +2.74 %、入彎 +2.17 %；Baku 起用較輕的底盤與新空力套件（Crash.net，只有一站資料）',
    src: ['weakness', 'gradeWilliams', 'trap', 'telemetry']
  },
  {
    id: 'aston-martin', teamZh: '奧斯頓馬丁', teamEn: 'Aston Martin', fullName: 'Aston Martin Aramco Formula One Team',
    car: 'AMR26', pu: 'honda', works: true,
    colour: '#0C5F49', colour2: '#D1CE48', colourTeam: '#229971',
    colourNote: '緞面賽車綠、萊姆黃飾線（下車身為黑）',
    standing: { pos: 10, points: 3, wins: 0 },
    qualiGapPct: 4.332, raceGapPct: 4.439, autosport: [90.000, 88.960],
    vmaxKmh: -5.7, trapKmh: -8.7,
    ft: 2.54, traction: 2.59, endStraight: 2.92, slow: 1.79, medium: 3.14, fast: 2.63, entry: 1.97, clipKmh: 33.8,
    note: '被 Honda 動力單元拖累：極速、加速、電能都是全場最弱，慢彎相對沒那麼差。',
    basis: 'The Race：Honda 動力單元是首要問題（估計占約 2 秒 / 圈）、能量回收效率差；測速點全季最後（−8.7 km/h）；遙測：全油門區、牽引區、直線末段皆最慢，慢彎差距（+1.79 %）小於中高速彎。匈牙利站的 B 規格大改版據報從落後領先者的差距中砍掉約 2 秒，荷蘭站起 Honda 引擎也更強（Motorsport.com）：現在的 AMR26 比全季平均快得多，遊戲用的是全季平均',
    src: ['weakness', 'gradeAston', 'teamByTeam', 'monzaEnergy', 'trap', 'telemetry']
  },
  {
    id: 'cadillac', teamZh: '凱迪拉克', teamEn: 'Cadillac', fullName: 'Cadillac Formula 1 Team',
    car: 'MAC-26', pu: 'ferrari', works: false,
    colour: '#DBDDDB', colour2: '#232327', colourTeam: '#909090',
    colourNote: '白、黑（2026 奧地利站照片取樣；奧地利站起改用左右對稱、以白為主的塗裝，formula1.com 官方側視圖仍是發表時的黑色那一側）',
    standing: { pos: 11, points: 0, wins: 0 },
    qualiGapPct: 4.043, raceGapPct: 4.107, autosport: [90.479, 88.626],
    vmaxKmh: -1.3, trapKmh: -2.1,
    ft: 1.55, traction: 1.84, endStraight: 0.61, slow: 3.10, medium: 4.44, fast: 4.94, entry: 3.59, clipKmh: 26.5,
    note: '新車隊首作：平衡尚可但嚴重缺下壓力，三種彎都是全場最慢，極速略低於中位數。',
    basis: 'The Race：Pérez「The balance itself is not too bad. It\'s just that we are lacking the load」、平均落後 4.6 %；Motorsport.com：煞車過熱（奧地利兩車、匈牙利再發生）、9 次退賽；遙測：慢 / 中 / 高速彎與入彎皆最慢，最快圈極速比中位數低 1.3 km/h、測速點低 2.1 km/h',
    src: ['weakness', 'gradeCadillac', 'teamByTeam', 'telemetry', 'cadillacLivery']
  }
];

const METRICS = [
  { key: 'qualiGapPct', label: '排位差距（對該場最快，15 站平均）', unit: '%', src: 'quali' },
  { key: 'raceGapPct', label: '正賽節奏差距（對最快車隊，中位數）', unit: '%', src: 'race' },
  { key: 'autosport', label: 'Autosport 預期圈速（AUS–CHN / BEL–HUN）', unit: 's', src: 'autosport' },
  { key: 'vmaxKmh', label: '最快排位圈極速（對全場中位數）', unit: 'km/h', src: 'telemetry' },
  { key: 'trapKmh', label: '排位測速點（對全場中位數）', unit: 'km/h', src: 'trap' },
  { key: 'ft', label: '全油門區時間', unit: '%', src: 'telemetry' },
  { key: 'traction', label: '慢彎出彎 150 m（牽引）時間', unit: '%', src: 'telemetry' },
  { key: 'endStraight', label: '長直線末段 1/3 時間', unit: '%', src: 'telemetry' },
  { key: 'slow', label: '慢彎區時間', unit: '%', src: 'telemetry' },
  { key: 'medium', label: '中速彎區時間', unit: '%', src: 'telemetry' },
  { key: 'fast', label: '高速彎區時間', unit: '%', src: 'telemetry' },
  { key: 'entry', label: '慢彎入彎（煞車 + 轉向）時間', unit: '%', src: 'telemetry' },
  { key: 'clipKmh', label: '長直線尖峰到末端的掉速（僅列出，不進公式）', unit: 'km/h', src: 'telemetry' }
];

// Where the livery colours were sampled (by the identity research: median of the lit pixels of the dominant
// hue of the image; NOT published colour codes). formula1.com's official 2026 side-view renders, except the two
// cars whose current paint the render does not show well (photos of the 2026 Austrian GP, Wikimedia Commons).
const RENDER = slug => 'https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/' + slug + '/2026' + slug + 'carright.png';
const COLOUR_SOURCES = {
  mercedes: { what: 'formula1.com 官方圖', url: RENDER('mercedes') },
  ferrari: { what: 'formula1.com 官方圖', url: RENDER('ferrari') },
  mclaren: { what: 'formula1.com 官方圖', url: RENDER('mclaren') },
  'red-bull': { what: 'formula1.com 官方圖', url: RENDER('redbullracing') },
  'racing-bulls': { what: 'formula1.com 官方圖', url: RENDER('racingbulls') },
  alpine: { what: 'formula1.com 官方圖', url: RENDER('alpine') },
  haas: { what: 'formula1.com 官方圖', url: RENDER('haasf1team') },
  audi: { what: '2026 奧地利站照片', url: 'https://commons.wikimedia.org/wiki/File:FIA_F1_Austria_2026_Nr._5_Bortoleto_(3).jpg' },
  williams: { what: 'formula1.com 官方圖', url: RENDER('williams') },
  'aston-martin': { what: 'formula1.com 官方圖', url: RENDER('astonmartin') },
  cadillac: { what: '2026 奧地利站照片', url: 'https://commons.wikimedia.org/wiki/File:FIA_F1_Austria_2026_Nr._11_Perez_(3).jpg' }
};

module.exports = { SEASON, SOURCES, POWER_UNITS, TEAMS, METRICS, COLOUR_SOURCES };
