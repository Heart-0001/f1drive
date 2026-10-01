// F1Drive - car-selection data: builds docs/cars-data-sources.md from the results of derive.js.
// Called by derive.js; every number in the document comes from the derivation, nothing is typed in here.
'use strict';
const fs = require('fs');
const path = require('path');

const SHORT = {
  standings: '積分榜', quali: 'Jolpica 排位成績', race: 'OpenF1 正賽單圈', autosport: 'Autosport 8/19', trap: 'OpenF1 測速點',
  telemetry: 'OpenF1 遙測', aduo: 'FIA ADUO', rules: '2026 規則', weakness: 'The Race 4/26', mercedesEdge: 'Autosport 3/10',
  teamByTeam: 'Autosport 逐隊', monzaEnergy: 'The Race Monza', redBullPace: 'Motorsport / PlanetF1', gradeRedBull: 'Motorsport 評分',
  gradeFerrari: 'Motorsport 評分', gradeMcLaren: 'Motorsport 評分', gradeRacingBulls: 'Motorsport 評分', gradeAlpine: 'Motorsport 評分 / F1.com',
  gradeHaas: 'Motorsport 評分', gradeAudi: 'Motorsport 評分 / Autosport', gradeWilliams: 'Motorsport 評分 / Crash.net',
  gradeAston: 'Motorsport 評分', gradeCadillac: 'Motorsport 評分', gradeMercedes: 'Motorsport 評分 / The Race',
  identity: 'formula1.com / Wikipedia', timingColour: 'OpenF1 drivers', zhNames: '台灣媒體',
  upgrades: 'Crash.net / formula1.com 升級', cadillacLivery: 'Cadillac 塗裝'
};
const TRACK_ZH = ['澳洲', '中國', '日本', '邁阿密', '加拿大', '摩納哥', '巴塞隆納', '奧地利', '英國', '比利時', '匈牙利', '荷蘭', '義大利', '馬德里', '亞塞拜然'];

module.exports = function (D) {
  const { CFG, RATING, SENS, DRAG_COMP, T, ORDER, PU, K, paceMed, paceMin, paceMax, iceMed, geos, stdLaps, stdMetrics, stdCorner, stdBoost, CARS,
    standingSwaps, colourPairs, standardColourNearest } = D;
  const I = D.inputs, M = D.model, S = I.SOURCES;
  const sg = (v, d) => (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(d);        // signed, real minus sign
  const fx = (v, d) => v.toFixed(d);
  // reference-style links: every URL is written once, at the end of the document
  const refs = {};
  const link = key => S[key].urls.map((u, i) => {
    const id = key + (i ? '-' + (i + 1) : '');
    refs[id] = u;
    return '[' + (i ? String(i + 1) : SHORT[key]) + '][' + id + ']';
  }).join(' ');
  const colourLink = t => { refs['paint-' + t.id] = I.COLOUR_SOURCES[t.id].url; return '[' + I.COLOUR_SOURCES[t.id].what + '][paint-' + t.id + ']'; };
  const minus = v => String(v).replace('-', '−');
  const table = (head, rows, align) => ['| ' + head.join(' | ') + ' |', '|' + head.map((h, i) => (align && align[i] === 'l' ? ' --- ' : ' ---: ')).join('|') + '|']
    .concat(rows.map(r => '| ' + r.join(' | ') + ' |')).join('\n');
  const name = t => (t.teamZh === t.teamEn ? t.teamEn : t.teamZh + ' ' + t.teamEn);
  const L = [];
  const spread = Math.max.apply(null, T.map(t => t.lapDelta)) - Math.min.apply(null, T.map(t => t.lapDelta));

  L.push('# 車輛資料：來源與換算方式（' + I.SEASON.year + ' 賽季）');
  L.push('');
  L.push('> 本檔與 `js/cars-data.js` 都是 `node devtests/cars-data/derive.js` 的輸出。要改數字請改 `devtests/cars-data/inputs.js`');
  L.push('> 或 `derive.js` 裡的常數後重跑，不要手改這兩個檔。');
  L.push('');
  L.push('**這些數字是依公開資料、為遊戲推估出來的倍率，不是車隊或 FIA 公布的官方規格。** 各車實際的馬力、風阻、下壓力與');
  L.push('車重都沒有公開。這裡有出處的是「誰快誰慢、各自擅長什麼」的順序；差距的幅度則刻意壓縮過，讓每輛車都能開、也都有特色。');
  L.push('');
  L.push('## 1. 資料時間與範圍');
  L.push('');
  L.push('- ' + I.SEASON.year + ' 年 FIA 一級方程式世界錦標賽，資料截至 ' + I.SEASON.asOf + '，已賽 ' + I.SEASON.lastRound + ' 站（最後一站是 ' + I.SEASON.lastRace + '），共 11 支車隊。');
  L.push('- 已賽的 15 站：' + TRACK_ZH.join('、') + '。遊戲裡這 15 條賽道都有，圈速估計就用這 15 條的平均。');
  L.push('- 所有真實數據都是全季平均。Racing Bulls（蒙特婁底板，' + link('gradeRacingBulls') + '）、Red Bull（邁阿密首批升級、奧地利大改，' + link('upgrades') + '）、');
  L.push('  McLaren（邁阿密–蒙特婁、匈牙利，' + link('gradeMcLaren') + '）、Aston Martin（匈牙利 B 規格，' + link('gradeAston') + '）、Alpine（荷蘭，見上面升級連結的第 3 個）、');
  L.push('  Williams（Baku 較輕的底盤，' + link('gradeWilliams') + '）在季中都大幅改過車，平均值看不出這些變化（Aston Martin 最明顯：現在比全季平均快得多）。');
  L.push('- 寫這份資料時重新查核過：車隊積分榜（' + link('standings') + '）、15 站排位差距（由 Jolpica 的官方計時重算，');
  L.push('  各隊中位數與 `tools/seasons-raw.json` 的 F1DB 數字一致）、FIA ADUO 級距、Autosport 的圈速表、2026 規則的動力配置。');
  L.push('  2026-10-01 另由第二位查核者逐項對照原始網頁與計時 API 重算，結果與更正見第 9 節。');
  L.push('');
  L.push('## 2. 結果');
  L.push('');
  L.push('倍率（標準車 = 1；**drag 越小越好**，其餘越大越好；全部在 ' + CFG.MIN + '–' + CFG.MAX + ' 之間）：');
  L.push('');
  L.push(table(['車隊', '賽車', '動力單元', 'power', 'drag', 'downforce', 'grip', 'brake', 'traction', 'ersPower', 'ersHarvest'],
    CARS.map(c => [c.team, c.car, c.pu].concat(M.KEYS.map(k => fx(c.perf[k], 4)))), ['l', 'l', 'l']));
  L.push('');
  L.push('選單評分（0–100，50 = 標準車）與模型估計值：');
  L.push('');
  L.push(table(['車隊', '極速', '加速', '過彎', '煞車', '電能', '圈速差', '極速 km/h', '0–300 km/h', '300→80 km/h'],
    [['F1Drive 標準賽車', 50, 50, 50, 50, 50, '0', fx(stdMetrics.topKmh, 1), fx(stdMetrics.t0to300, 2) + ' s', fx(stdMetrics.brake300to80, 1) + ' m']].concat(
      ORDER.map(t => [name(t), t.ratings.topSpeed, t.ratings.accel, t.ratings.cornering, t.ratings.braking, t.ratings.ers,
        sg(t.lapDelta, 2) + ' %', fx(t.metrics.topKmh, 1), fx(t.metrics.t0to300, 2) + ' s', fx(t.metrics.brake300to80, 1) + ' m'])), ['l']));
  L.push('');
  L.push('圈速差是對標準車、15 條賽道平均、不使用電池的估計值（負值較快）。最快與最慢相差 ' + fx(spread, 2) + ' %；真實世界同一組數字是 ' +
    fx(paceMax - paceMin, 2) + ' %。');
  L.push('');
  L.push('## 3. 每個倍率乘在哪裡');
  L.push('');
  const eff = k => sg(SENS[k], 3) + ' %';
  L.push(table(['倍率', '乘在 `js/car.js` 的', '主要影響', '倍率 +1 % 的圈速變化'], [
    ['power', 'POWER（W/kg）', '極速；約 300 km/h 以上的加速', eff('power')],
    ['drag', 'DRAG_K', '極速、高速段加速（煞車時略有幫助）', eff('drag')],
    ['downforce', 'DOWNFORCE', '中高速彎速度、高速煞車', eff('downforce')],
    ['grip', 'LAT_BASE 與 LAT_MAX', '所有彎的橫向抓地力（慢彎只看這一項）', eff('grip')],
    ['brake', 'BRAKE_BASE', '煞車', eff('brake')],
    ['traction', 'TRACTION', '起步到動力極限之間的加速', eff('traction')],
    ['ersPower', 'ers.power', '按住電池鍵時多出來的動力', '見下'],
    ['ersHarvest', 'ers.harvest', '電池回充速度', '不影響單圈']
  ], ['l', 'l', 'l']));
  L.push('');
  L.push('在目前的物理（v5 的 `js/car.js`）裡，317 km/h 以下的加速度被 TRACTION 上限（11 m/s²）限制，power 與電池只在接近極速時');
  L.push('才有作用：標準車整圈按住電池也只快 ' + fx(-stdBoost, 3) + ' %（極速 ' + fx(stdMetrics.topKmh, 0) + ' → ' + fx(stdMetrics.topBoostKmh, 0) +
    ' km/h）。所以車與車的圈速差距幾乎都來自 traction、grip、drag、downforce、brake；power 與兩個電池倍率');
  L.push('主要決定極速與「手感」。如果 v6 的傳動 / 電池實作改變了這一點，圈速差距要重新檢查（見第 7 節）。');
  L.push('');
  L.push('## 4. 換算公式');
  L.push('');
  L.push('所有常數都在 `devtests/cars-data/derive.js` 的 `CFG` 與 `RATING`。圈速模型在 `devtests/cars-data/model.js`：把 `js/car.js` 的');
  L.push('受力模型與 `js/raceline.js` 的速度曲線參數化；腳本每次執行都會確認標準車的結果與這兩個模組完全相同。');
  L.push('');
  L.push('**步驟 1：速度目標。** 真實差距 P = ' + CFG.W_QUALI + ' × 排位差距 + ' + CFG.W_RACE + ' × 正賽節奏差距 + ' + CFG.W_AUTOSPORT +
    ' × Autosport 預期圈速差距（都是對最快車隊的 %）。');
  L.push('遊戲目標 = K ×（P − 全場中位數），K = ' + CFG.SPREAD + ' ÷（最大 P − 最小 P）= ' + fx(K, 4) + '。也就是保留真實的順序與比例，');
  L.push('把最快到最慢壓縮成 ' + CFG.SPREAD + ' %（約為真實的 1/' + fx(1 / K, 1) + '），標準車放在中位數車隊（' + name(ORDER.find(t => Math.abs(t.pace - paceMed) < 1e-9)) + '）的位置。');
  L.push('');
  L.push(table(['車隊', '排位 %', '正賽 %', 'Autosport %', '綜合 P %', '遊戲目標 %', '模型圈速 %'],
    ORDER.map(t => [name(t), fx(t.qualiGapPct, 3), fx(t.raceGapPct, 3), fx(t.autosportGapPct, 3), fx(t.pace, 3), sg(t.target, 3), sg(t.lapDelta, 3)]), ['l']));
  L.push('');
  {
    const qualiSame = T.slice().sort((a, b) => a.qualiGapPct - b.qualiGapPct).map(t => t.id).join(' ') === ORDER.map(t => t.id).join(' ');
    L.push('這個順序' + (qualiSame ? '與 15 站排位平均的順序相同' : '與 15 站排位平均的順序略有不同') + '；和車隊積分榜相比，' +
      (standingSwaps.length ? standingSwaps.map(([f, s]) => name(f) + '（積分第 ' + f.standing.pos + '）排在 ' + name(s) + '（積分第 ' + s.standing.pos + '）前面').join('，') +
        '：積分還受可靠度、起跑與正賽際遇影響' +
        (standingSwaps.some(([f, s]) => f.id === 'cadillac' && s.id === 'aston-martin') ? '（Aston Martin 的 3 分來自摩納哥第 10 與荷蘭第 9，Cadillac 至今 0 分；Jolpica 正賽成績）' : '') + '。' : '順序完全相同。'));
  }
  L.push('');
  if (CFG.POWER_FROM === 'speed') {
    L.push('**步驟 2：引擎（power）。** 同一具動力單元的車隊共用同一個值：能讓標準車（drag = 1）的極速等於 ' + CFG.V_REF + ' + ' + CFG.GAIN +
      ' ×（使用這具動力單元的所有車隊的平均極速指數 V，見步驟 3）km/h 的 power。');
    L.push('FIA 的 ADUO 指數（' + link('aduo') + '）只衡量內燃機；2026 年的動力約一半來自電能（400 kW + 350 kW），直線速度很受電能部署影響，例如 Red Bull Ford 的內燃機是 FIA 的基準，');
    L.push('Red Bull 的全季極速卻只在中位數，平均極速最高的反而是用 Mercedes 動力的四隊。若用 ADUO 決定 power，遊戲裡的極速順序會和實測相反（第一版就是這樣：');
    L.push('Red Bull 的遊戲極速高於 Mercedes），所以 ADUO 只列在表中對照、不進公式。對照值 = 1 + ' + CFG.GAIN + ' × ' + fx(CFG.ICE_SHARE, 3) +
      ' ×（ADUO 指數 − 全場中位數 ' + minus(iceMed) + ' %）÷ 100；' + fx(CFG.ICE_SHARE, 3) + ' 是內燃機占總動力的比例（400 kW ÷ 750 kW，' + link('rules') + '）；');
    L.push('FIA 只公布級距（基準 = 0、「落後 2–4 %」取 −3、「落後超過 4 %」沒有下限，取名目值 −5，是我們的假設）。');
  } else {
    L.push('**步驟 2：引擎（power）。** 同一具動力單元的車隊共用同一個值：power = 1 + ' + CFG.GAIN + ' × ' + fx(CFG.ICE_SHARE, 3) +
      ' ×（FIA ADUO 內燃機指數 − 全場中位數）÷ 100，全場中位數是 ' + minus(iceMed) + ' %（' + link('aduo') + '）。');
    L.push(fx(CFG.ICE_SHARE, 3) + ' 是 2026 規則中內燃機占總動力的比例（400 kW ÷ 750 kW，' + link('rules') + '）。FIA 只公布級距：基準 = 0、「落後 2–4 %」取中間值 −3、');
    L.push('「落後超過 4 %」沒有下限，這裡取名目值 −5（我們的假設）。對於這個沒有下限的級距，如果該動力單元實測的極速指數');
    L.push('比名目值能解釋的還低，就改用「能重現 ' + CFG.GAIN + ' × 實測極速差」的 power。');
  }
  L.push('');
  L.push(table(['動力單元', '使用車隊', 'ADUO 指數 %', '家族極速指數 km/h', '由 ADUO（對照）', '由實測極速', 'power'],
    Object.keys(PU).map(id => { const u = PU[id]; return [u.engine, u.teams.map(x => T.find(t => t.id === x).teamEn).join('、'), (u.aduoOpenEnded ? '< −4（取 ' + minus(u.aduoIcePct) + '）' : minus(u.aduoIcePct)),
      sg(u.V, 2), fx(u.powerAduo, 4), fx(u.powerSpeed, 4), '**' + fx(u.power, 4) + '**']; }), ['l', 'l']));
  L.push('');
  L.push('**步驟 3：風阻（drag）。** 極速指數 V =（最快排位圈的遙測極速差 + 排位測速點差）÷ 2，單位 km/h，都是對全場中位數。');
  L.push('用同一具動力單元的車隊，極速差異來自車身：drag = 1 − 3 × ' + CFG.GAIN + ' ×（V − 同動力單元車隊的平均 V）÷ ' + CFG.V_REF + '（極速約與（動力 ÷ 風阻）的立方根成正比）。');
  L.push('只有一隊使用的動力單元（Audi、Honda）無法把車和引擎分開，drag 取中性值 1。' + (CFG.POWER_FROM === 'speed' ? '步驟 2 與 3 合起來，每輛車的遊戲極速 ≈ ' + CFG.V_REF + ' + ' + CFG.GAIN +
    ' × V，所以遊戲裡的極速順序與實測相同（`derive.js` 會檢查）。同一具動力單元內的差距放在 drag 上是模型的選擇：真實原因可能是風阻，也可能是電能部署策略，公開資料分不出來。' : ''));
  L.push('');
  L.push(table(['車隊', '遙測極速差', '測速點差', 'V', '家族內差', 'drag', '遊戲極速 km/h'],
    ORDER.map(t => [name(t), sg(t.vmaxKmh, 1), sg(t.trapKmh, 1), sg(t.V, 2), t.familyResidual === null ? '無法分離' : sg(t.familyResidual, 2), fx(t.perf.drag, 4), fx(t.metrics.topKmh, 1)]), ['l']));
  L.push('');
  L.push('**步驟 4：電池。** ersPower = 1 − ' + fx(CFG.E_GAIN, 1) + ' ×（長直線末段 1/3 的時間，對中位數的 %）÷ 100，以遙測當作部署能力的代理指標。');
  L.push('ersHarvest = 1 + ' + CFG.E_STEP + ' × 報導排序分數；沒有任何公開量測，分數只依媒體報導：');
  L.push('');
  L.push(table(['動力單元', '分數', '依據', '來源'],
    Object.keys(PU).map(id => { const u = PU[id]; return [u.supplier + (id === 'mercedes' ? '（廠隊再 +1）' : ''), sg(u.ersRank, 0), u.ersBasis, u.src.filter(k => k !== 'aduo').map(link).join('、')]; }), ['l', 'r', 'l', 'l']));
  L.push('');
  L.push('**步驟 5：底盤（grip、downforce、brake、traction）。** 倍率 = 1 − ' + CFG.GAIN + ' ×（對應區段的時間，對中位數的 %）÷ 100 + L。');
  L.push('區段對應：grip ← 慢彎區；downforce ←（' + CFG.W_MEDIUM + ' × 中速彎 + ' + CFG.W_FAST + ' × 高速彎）÷ ' + (CFG.W_MEDIUM + CFG.W_FAST) +
    '（權重是兩者占一圈的比例）；brake ← 慢彎入彎（煞車 + 轉向）；');
  L.push('traction ← ' + CFG.W_TRACTION_ZONE + ' × 出彎 150 m + ' + (1 - CFG.W_TRACTION_ZONE) + ' × 全油門區，再加上 ' + fx(DRAG_COMP, 3) +
    ' ×（drag − 1）：實測的區段時間已經包含各車的風阻，所以 drag 倍率');
  L.push('在圈速上的得失由 traction 補回（drag 只決定時間花在極速還是加速上）。' + fx(DRAG_COMP, 3) + ' 是模型量到的兩者圈速影響比。');
  L.push('L 是每輛車一個數、四個底盤倍率共用，用二分法解出，讓模型圈速剛好等於步驟 1 的目標；它吸收了遙測與圈速資料之間的不一致。');
  L.push('「實測差異取一半」（' + CFG.GAIN + '）是讓 L 最小的取值（`--scan` 會列出比較）。');
  L.push('');
  L.push(table(['車隊', 'grip 輸入 %', 'downforce 輸入 %', 'brake 輸入 %', 'traction 輸入 %', 'L %'],
    ORDER.map(t => [name(t), sg(t.zone.grip, 2), sg(t.zone.downforce, 2), sg(t.zone.brake, 2), sg(t.zone.traction, 2), sg(t.L * 100, 2)]), ['l']));
  L.push('');
  L.push('**步驟 6：** 倍率四捨五入到小數 4 位，並檢查都在 ' + CFG.MIN + '–' + CFG.MAX + ' 之內（沒有任何一項碰到邊界）。表中的圈速、極速與評分都用四捨五入後的值重算。');
  L.push('');
  L.push('**步驟 7：評分。** 評分 = 50 + 係數 × x，四捨五入並限制在 0–100；標準車的 x 都是 0。');
  L.push('');
  L.push(table(['評分', '係數', 'x'], [['極速 topSpeed', RATING.topSpeed.gain, RATING.topSpeed.x], ['加速 accel', RATING.accel.gain, RATING.accel.x],
    ['過彎 cornering', RATING.cornering.gain, RATING.cornering.x], ['煞車 braking', RATING.braking.gain, RATING.braking.x], ['電能 ers', RATING.ers.gain, RATING.ers.x]], ['l', 'r', 'l']));
  L.push('');
  L.push('## 5. 各車隊使用的真實數據');
  L.push('');
  L.push('分區時間與極速都是「對全場中位數」；時間為負值表示較快。來源欄是該數字的出處；標示「計算值」的欄位是研究者由官方計時 / 遙測 API 算出來的，');
  L.push('不是該網站發表的數字（見第 8 節的說明）。排位差距、測速點、積分、Autosport 圈速已逐一重算或對照，完全相符；遙測分區是估計值（見第 9 節）。');
  for (const src of I.TEAMS) {
    const t = T.find(x => x.id === src.id), u = PU[t.pu];
    L.push('');
    L.push('### ' + name(t) + '：' + t.car + '（' + u.engine + '）');
    L.push('');
    L.push('- 全名：' + t.fullName + '（' + link('identity') + '）。積分榜第 ' + t.standing.pos + ' 名，' + t.standing.points + ' 分' + (t.standing.wins ? '，' + t.standing.wins + ' 勝' : '') + '（' + link('standings') + '）。');
    L.push('- 顏色：`' + t.colour + '` / `' + t.colour2 + '`：' + t.colourNote + '（' + colourLink(t) + '，自行取樣）；計時畫面車隊色 `' + t.colourTeam + '`（' + link('timingColour') + '）。');
    L.push('- 特性依據：' + t.basis + '。來源：' + t.src.map(link).join('、') + '。');
    L.push('- 遊戲內說明：' + t.note);
    L.push('');
    const rows = I.METRICS.map(m => {
      let v;
      if (m.key === 'autosport') v = fx(t.autosport[0], 3) + ' / ' + fx(t.autosport[1], 3) + ' s（平均差距 ' + fx(t.autosportGapPct, 3) + ' %）';
      else if (m.unit === 'km/h' && m.key !== 'clipKmh') v = sg(t[m.key], 1) + ' km/h';
      else if (m.key === 'clipKmh') v = fx(t[m.key], 1) + ' km/h';
      else if (m.key === 'qualiGapPct' || m.key === 'raceGapPct') v = fx(t[m.key], 3) + ' %';
      else v = sg(t[m.key], 2) + ' %';
      return [m.label, v, link(m.src)];
    });
    rows.push(['FIA ADUO 內燃機級距（' + u.supplier + '）', u.aduoOpenEnded ? '落後超過 4 %' : (u.aduoIcePct === 0 ? '基準' : '落後 2–4 %'), link('aduo')]);
    L.push(table(['真實數據', '數值', '來源'], rows, ['l', 'r', 'l']));
  }
  L.push('');
  L.push('## 6. 估計與缺漏');
  L.push('');
  L.push('- **沒有官方規格。** 各車的馬力、風阻係數、下壓力、車重、軸距都沒有公開；所有倍率都是由圈速、測速與遙測反推的估計。');
  L.push('- **哪些是計算值。** 排位差距由 Jolpica（Ergast）的官方計時計算，寫這份資料時重算過一次。正賽節奏與遙測分區是研究者用 OpenF1 的原始資料');
  L.push('  自行計算，沒有第三方發表的版本可比對；正賽節奏沒有修正油量、輪胎與藍旗，後段車隊（Cadillac、Aston Martin）被高估零點幾個百分點。');
  L.push('- **遙測樣本小。** 每隊每站只取一圈（最快排位圈，約 3.7 Hz），車手、賽道演進與失誤都混在裡面；165 圈中有 12 圈無法對齊而捨棄，');
  L.push('  Aston Martin 只有 11 站、Racing Bulls 與 Haas 13 站。');
  L.push('- **FIA ADUO 只有級距，而且只看內燃機。** 所以 power 由實測極速決定，ADUO 只作對照；「超過 4 %」的 −5 是名目假設。Honda 真正落後多少沒有可靠數字（「約 80 hp」只見於無法查證的網站，未採用）；');
  L.push('  Ferrari「約少 20 bhp」是 The Race 標明的傳聞，也未採用。Audi 的內燃機被 FIA 評為落後超過 4 %，實測極速卻略高於中位數（報導指它用更多電池補償），');
  L.push('  遊戲照實測給它略高於 1 的 power，這一點與 ADUO 的方向相反。');
  L.push('- **drag 無資料的車：** Audi、Aston Martin 用的動力單元只有一隊，無法與車身分開，drag = 1。');
  L.push('- **電池兩項最不確定。** 各隊的部署與回收沒有任何公開量測。ersPower 的代理指標（直線末段時間）混有風阻與引擎的影響；ersHarvest 只有報導排序。');
  L.push('  「直線尖峰到末端的掉速」雖然有數字，但前段車隊是刻意 superclip，不能解讀成電能差，所以只列出、不進公式。');
  L.push('- **沒有對應倍率、因此沒用到的報導：** 車重（Williams 開季超重約 30 kg，其影響已含在它的分區時間裡）、輪胎損耗、可靠度、');
  L.push('  起跑（Ferrari 起跑快；Audi、Red Bull、Mercedes 起跑差）、正賽與排位的落差（Haas）。');
  L.push('- **顏色不是官方色碼。** `colour` / `colour2` 是從 formula1.com 官方側視圖（Audi、Cadillac 另用 2026 奧地利站照片）取樣的結果，取的是受光面，');
  L.push('  白色會偏灰；只有 `colourTeam`（F1 計時畫面的車隊色）是公布值。Cadillac 自奧地利站起改用以白為主的對稱塗裝（' + link('cadillacLivery') + '），formula1.com 的側視圖仍是發表時黑色的那一側。');
  {
    const byDot = colourPairs.slice().sort((a, b) => a.dot - b.dot), byPair = colourPairs.slice().sort((a, b) => a.pair - b.pair), byTeam = colourPairs.slice().sort((a, b) => a.team - b.team);
    const nm = p => p.a.teamEn + ' / ' + p.b.teamEn;
    const close = byDot.filter(p => p.dot < 10);
    L.push('- **分得出來嗎（CIEDE2000 色差，約 10 以上才一眼分得出）。** 只看主色（小地圖上的單色圓點）：' +
      close.map(p => nm(p) + ' ' + fx(p.dot, 1)).join('、') + (close.length ? '，' : '') + '其餘兩兩至少 ' + fx(byDot.find(p => p.dot >= 10).dot, 1) + '（' + nm(byDot.find(p => p.dot >= 10)) + '）。');
    L.push('  2026 年真的有三輛以白為主的車（Haas 白紅、Racing Bulls 白藍、Cadillac 白黑），改用它們的其他官方色（紅、藍、黑）又會撞上 Ferrari、Red Bull、Mercedes（色差只有約 7–10），');
    L.push('  所以主色照實保留，靠第二色區分：主色與第二色合計，最接近的一對是 ' + nm(byPair[0]) + '（' + fx(byPair[0].dot, 1) + ' + ' + fx(byPair[0].second, 1) + '），`derive.js` 會擋下合計低於 ' + CFG.COLOUR_MIN_PAIR_DE + ' 的一對。');
    L.push('  **建議小地圖用雙色圓點（`colour` 填色、`colour2` 外圈）或沿用玩家自選的顏色。** 官方計時色 `colourTeam` 也有撞色：' + byTeam.slice(0, 2).map(p => nm(p) + ' ' + fx(p.team, 1)).join('、') + '。');
    L.push('  標準車的灰色與 ' + standardColourNearest.t.teamEn + ' 的主色相差 ' + fx(standardColourNearest.dot, 1) + '。');
  }
  L.push('- **中文隊名。** 賓士、法拉利、麥拉倫、紅牛、哈斯、奧迪、威廉斯、奧斯頓馬丁、凱迪拉克都是台灣媒體與台灣車迷站 F-1.TW 的寫法（' + link('zhNames') + '）；');
  L.push('  Mercedes 在台灣也常寫「梅賽德斯」（ETtoday 運動雲、NOWnews），這裡用同樣常見、且是台灣品牌名的「賓士」（TVBS、民視、ETtoday 車雲、F-1.TW）。');
  L.push('  Alpine 沒有通行譯名（F-1.TW 寫「阿爾派」、中文維基寫「阿爾卑」，Red Bull 台灣官網與美麗佳人直接寫 Alpine），所以用英文；');
  L.push('  Racing Bulls 沒有固定譯名，用聯合新聞網出現過的俗稱「小紅牛」（F-1.TW 寫「視覺賽車」，並不通行）。');
  L.push('- **引述文字。** 外電報導是透過自動摘要工具讀取的；第 9 節列出的引句已再對照過一次，其餘仍請視為近似轉述，正式引用前應回原文核對。');
  L.push('- **圈速是模型估計。** 用的是賽車線速度曲線（與遊戲畫賽車線的演算法相同），不含電池、輪胎與駕駛失誤；實車物理的檢查見下一節。');
  L.push('- **校正用的是 v5 基準車的物理。** 倍率是乘在「標準車」上的相對值，1.25 % 的差距是在目前 `js/car.js` 的常數（`F1.CAR_PERF`）上量到的。');
  L.push('  如果之後 2026 年的標準車改用另一組年代物理，各倍率對圈速的影響會略有不同，要把 `model.js` 的 `BASE` 換成那組數值後重跑 `derive.js` 與 `drive-check.js`。');
  L.push('');
  L.push('## 7. 檢查與重新產生');
  L.push('');
  L.push('```');
  L.push('node devtests/cars-data/derive.js            # 重新產生 js/cars-data.js、本檔與 devtests/cars-data/derived.json（約 10 秒）');
  L.push('node devtests/cars-data/derive.js --check    # 只比對，檔案與重算結果不同就以非零狀態結束');
  L.push('node devtests/cars-data/derive.js --dry --scan   # 只計算不寫檔，並列出不同 GAIN 下 L 的大小');
  L.push('node devtests/cars-data/check.js             # js/cars-data.js 的格式檢查（node 與 window 兩種載入方式）');
  L.push('node devtests/cars-data/drive-check.js       # 用真正的 js/car.js 物理讓自動駕駛跑每輛車（約 1 分鐘）');
  L.push('```');
  L.push('');
  L.push('`derive.js` 每次都會檢查：標準車的模型與 `F1.CAR_PERF`、`F1.buildRaceLine().lapTime` 相同；遊戲內的速度順序與真實綜合差距的順序相同；');
  L.push('最快與最慢的差距在 1–1.5 % 之內；每輛車的模型圈速與目標相差不到 0.01 %；' + (CFG.POWER_FROM === 'speed' ? '遊戲極速的順序與實測極速指數 V 的順序相同；' : '') +
    '倍率都在範圍內；id 與顏色格式正確；任兩隊的塗裝（主色 + 第二色）色差合計不低於 ' + CFG.COLOUR_MIN_PAIR_DE + '；標準車在第一筆且全為 1。');
  L.push('`derived.json` 保留所有中間值（每輛車在各賽道的圈速差、標準車的圈速、L、評分的 x 等）。');
  L.push('');
  const dcFile = path.join(__dirname, 'drive-check.json');
  let dc = null;
  try { dc = JSON.parse(fs.readFileSync(dcFile, 'utf8')); } catch (e) { dc = null; }
  const fresh = dc && CARS.every(c => { const r = dc.cars.find(x => x.id === c.id); return r && r.estimatePct === c.est.lapPct; });
  if (dc && fresh) {
    L.push('**實車物理檢查（`drive-check.js`）。** `js/car.js` 目前還不接受各車規格，所以檢查時是把它的原始碼在記憶體中複製一份、把常數乘上倍率');
    L.push('（磁碟上的檔案不動），再讓賽車線自動駕駛在 15 條賽道各跑 3 圈、取飛行圈。結果（對標準車的圈速差，15 條賽道平均）：');
    L.push('');
    L.push(table(['車隊', '模型估計 %', '實際駕駛 %'], dc.cars.slice(1).sort((a, b) => a.estimatePct - b.estimatePct).map(r => {
      const c = CARS.find(x => x.id === r.id); return [c.team, sg(r.estimatePct, 2), sg(r.drivenPct, 2)];
    }), ['l']));
    L.push('');
    L.push('實際駕駛的最快與最慢相差 ' + fx(dc.spreadPct, 2) + ' %，順序' + (dc.sameOrder ? '與模型相同' : '與模型在相鄰車之間略有出入（自動駕駛的油門 / 煞車是開關式的，雜訊比相鄰車的差距大）') +
      (dc.offTrackRuns ? '；有 ' + dc.offTrackRuns + ' 輛車在某條賽道的飛行圈出界或擦牆' : '；沒有任何一圈出界或擦牆') + '。');
    L.push('等 `js/car.js` 實作 v6 的 `F1.createCar(spec)` 之後，這支腳本會改走正式介面（該路徑尚未測試過），屆時要再跑一次。');
  } else {
    L.push('**尚欠：實車物理檢查。** 圈速差距目前只由速度曲線模型驗證。`drive-check.js` 會用真正的 `js/car.js` 讓自動駕駛跑每輛車，');
    L.push('跑完後重跑 `derive.js` 就會把結果寫進這一節。');
  }
  L.push('');
  L.push('## 8. 來源');
  L.push('');
  L.push('網址集中寫在本檔最後的連結定義裡（原始檔可直接看到）。');
  L.push('');
  for (const key of Object.keys(S)) L.push('- ' + S[key].title + '：' + link(key));
  L.push('- 各車塗裝取樣用的圖：' + I.TEAMS.map(t => '[' + t.teamEn + '][paint-' + t.id + ']').join('、'));
  L.push('');
  L.push('OpenF1 與 Jolpica 是計時資料的 API：分站的網址只差 `session_key` 或站次。排位賽的 session_key：' +
    '澳洲 11230、中國 11241、日本 11249、邁阿密 11276、加拿大 11287、摩納哥 11295、巴塞隆納 11303、奧地利 11311、英國 11322、比利時 11330、匈牙利 11338、荷蘭 11349、義大利 11357、馬德里 11365、亞塞拜然 11373；');
  L.push('正賽：11234、11245、11253、11280、11291、11299、11307、11315、11326、11334、11342、11353、11361、11369、11377。');
  L.push('');
  L.push('## 9. 獨立查核（2026-10-01）');
  L.push('');
  L.push('第二位查核者沒有看研究者的筆記，逐項開啟上面的網址並用計時 API 重算。');
  L.push('');
  L.push('**相符（已驗證）**');
  L.push('');
  L.push('- 11 支車隊、全名、底盤代號、動力單元供應商：formula1.com 各隊頁與 Wikipedia 報名表一致；動力單元全名（M17 E Performance、067/6、DM01、AFR 26 Hybrid、RA626H）見 Wikipedia 車款條目。');
  L.push('  2026 年沒有 Sauber（由 Audi 廠隊取代），Cadillac 是第 11 隊；截至 9/30 沒有車隊改名。F1DB 的車隊代號與 `tools/seasons-raw.json` 一致。');
  L.push('- 積分榜（538 / 378 / 306 / 263 / 83 / 68 / 27 / 17 / 12 / 3 / 0 分）與勝場（Mercedes 11、Ferrari 2、McLaren 2）：formula1.com 與 Jolpica 一致；前 10 站桿位全是 Mercedes，Monza 桿位是 Gasly。');
  L.push('- 已賽 15 站與日期（亞塞拜然站 9/26 週六）：Jolpica 賽程；OpenF1 的 30 個 session_key 一致。');
  L.push('- 排位差距 11 隊的平均與中位數：由 Jolpica 15 站排位成績重算，到小數第 3 位完全相同。');
  L.push('- 測速點 11 隊：由 OpenF1 15 場排位的 st_speed 重算，到小數第 1 位完全相同。');
  L.push('- 正賽節奏：用不同的綠旗圈篩選重算，11 隊順序相同、數值相差 0.1 個百分點以內（Red Bull 0.61 對 0.70）。');
  L.push('- Autosport 8/19 的 22 個圈速：與原文表格完全相同（原文以 Aston Martin 開季 = 90.000 秒為基準）。');
  L.push('- FIA ADUO 級距與「只看內燃機」（Sky Sports、Pitpass）；2026 規則 400 kW / 350 kW（formula1.com）。');
  L.push('- 計時畫面車隊色 11 個：與 OpenF1 drivers 完全相同。塗裝取樣色：另行取樣官方側視圖的受光面，色相與明暗都相符。');
  L.push('- 引句（已對照原文）：The Race 4/26 的「outstanding when it comes to the integration of harvesting…」「best car in terms of corner performance」「somewhere in the region of 20bhp」（傳聞）、');
  L.push('  「overweight … 30kg … nine tenths」「lacking the load」「4.6% off」「lost places five times」「eighth-fastest」；Motorsport.com 的「snowballs into higher battery deployment」「abysmal starts」');
  L.push('  「switched the car on」「lacking downforce」「losing several tenths of lap time on the straights」；Autosport 的「less efficient energy management」「gap in hybrid usage」。');
  L.push('');
  L.push('**更正**');
  L.push('');
  L.push('- 直線速度順序：第一版的 power 取自 FIA ADUO（只看內燃機），使 Red Bull 的遊戲極速（330.7）高於 Mercedes（330.4），與實測（Mercedes +2.1 km/h、Red Bull 0.0）相反；');
  L.push('  現改由各動力單元的實測極速決定（步驟 2），遊戲極速順序與實測完全相同，並由 `derive.js` 檢查。Red Bull 的說明也改為「全季極速只在中位數」。');
  L.push('- 「和積分榜相比只有 Audi 排在 Haas 前面」不對：Cadillac 也排在 Aston Martin 前面（上文已改為自動列出）。');
  L.push('- Red Bull 的季中大改是邁阿密與奧地利，不是摩納哥（formula1.com：摩納哥只有 4 項以散熱為主的小改）。');
  L.push('- Mercedes 的電能引句原寫成「outstanding ERS integration, efficient harvesting」，已改成原文；「客戶隊的電能運用落後廠隊」只有 McLaren 領隊的說法（Autosport），不是 The Race，');
  L.push('  套用到 Williams、Alpine 是推論，已註明。McLaren 的「風阻偏大」改為「同一具動力中直線最慢」：原因是風阻還是電能部署（車隊自己說是 energy），公開資料分不出來。');
  L.push('- Haas：「均衡好開」沒有出處，刪除；「全季升級最少」改為「全季進步幅度最小」（Autosport 量的是圈速進步，不是升級數量）；「零件品質不一」出自 Motorsport.com，不是 Autosport。');
  L.push('- Alpine：The Race 說的是高速推頭，不是「彎中推頭」；「低風阻」是推論，改為只寫實測的「全場極速最高」。');
  L.push('- Racing Bulls：直線末段是第 3 佳（Williams 第 2），不是第 2；說明改為依測速點的「直線速度名列前茅」。');
  L.push('- Aston Martin：匈牙利 B 規格不是「略有起色」，Motorsport.com 說它從落後的差距中砍掉約 2 秒；Williams 的 Baku 升級是「較輕的底盤」，沒有「B 規格」的說法。');
  L.push('- The Race 的 Monza 文章標題與日期、各篇評分的日期已補上；Cadillac 塗裝改變補上出處；中文隊名補上「梅賽德斯」「阿爾派」等其他寫法。');
  L.push('');
  L.push('**無法驗證、仍是估計**');
  L.push('');
  L.push('- 遙測分區（全油門、牽引、直線末段、慢 / 中 / 高速彎、入彎）與最快圈極速：研究者的分區定義與對齊方法沒有公開版本。查核者用自己的粗略方法（以速度積分對齊、依中位數油門分區）重算，');
  L.push('  慢 / 中 / 高速彎與入彎的前後順序大致相同（Mercedes、Ferrari 最快，Cadillac 最慢），最快圈極速的順序也大致相同；全油門、牽引與直線末段的數值則隨方法變動很大，只能當作方向參考。');
  L.push('- 電池兩項（ersPower、ersHarvest）沒有公開量測；ersHarvest 的排序分數是依報導的判斷。');
  L.push('- 「正賽節奏高估後段車隊零點幾個百分點」是研究者的判斷，沒有量化來源。');
  L.push('- 各車的真實馬力、風阻、下壓力、車重都沒有公開數字。');
  L.push('');
  for (const id of Object.keys(refs)) L.push('[' + id + ']: ' + refs[id]);
  L.push('');
  return L.join('\n');
};
