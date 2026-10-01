# 車輛資料：來源與換算方式（2026 賽季）

> 本檔與 `js/cars-data.js` 都是 `node devtests/cars-data/derive.js` 的輸出。要改數字請改 `devtests/cars-data/inputs.js`
> 或 `derive.js` 裡的常數後重跑，不要手改這兩個檔。

**這些數字是依公開資料、為遊戲推估出來的倍率，不是車隊或 FIA 公布的官方規格。** 各車實際的馬力、風阻、下壓力與
車重都沒有公開。這裡有出處的是「誰快誰慢、各自擅長什麼」的順序；差距的幅度則刻意壓縮過，讓每輛車都能開、也都有特色。

## 1. 資料時間與範圍

- 2026 年 FIA 一級方程式世界錦標賽，資料截至 2026-09-30，已賽 15 站（最後一站是 2026-09-26 的亞塞拜然大獎賽），共 11 支車隊。
- 已賽的 15 站：澳洲、中國、日本、邁阿密、加拿大、摩納哥、巴塞隆納、奧地利、英國、比利時、匈牙利、荷蘭、義大利、馬德里、亞塞拜然。遊戲裡這 15 條賽道都有，圈速估計就用這 15 條的平均。
- 所有真實數據都是全季平均。Racing Bulls（蒙特婁底板，[Motorsport 評分][gradeRacingBulls]）、Red Bull（邁阿密首批升級、奧地利大改，[Crash.net / formula1.com 升級][upgrades] [2][upgrades-2] [3][upgrades-3]）、
  McLaren（邁阿密–蒙特婁、匈牙利，[Motorsport 評分][gradeMcLaren]）、Aston Martin（匈牙利 B 規格，[Motorsport 評分][gradeAston]）、Alpine（荷蘭，見上面升級連結的第 3 個）、
  Williams（Baku 較輕的底盤，[Motorsport 評分 / Crash.net][gradeWilliams] [2][gradeWilliams-2]）在季中都大幅改過車，平均值看不出這些變化（Aston Martin 最明顯：現在比全季平均快得多）。
- 寫這份資料時重新查核過：車隊積分榜（[積分榜][standings] [2][standings-2]）、15 站排位差距（由 Jolpica 的官方計時重算，
  各隊中位數與 `tools/seasons-raw.json` 的 F1DB 數字一致）、FIA ADUO 級距、Autosport 的圈速表、2026 規則的動力配置。
  2026-10-01 另由第二位查核者逐項對照原始網頁與計時 API 重算，結果與更正見第 9 節。

## 2. 結果

倍率（標準車 = 1；**drag 越小越好**，其餘越大越好；全部在 0.95–1.05 之間）：

| 車隊 | 賽車 | 動力單元 | power | drag | downforce | grip | brake | traction | ersPower | ersHarvest |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| F1Drive | 標準賽車 | F1Drive | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| 賓士 Mercedes | W17 | Mercedes | 1.0055 | 0.9961 | 1.0150 | 1.0095 | 1.0110 | 1.0057 | 1.0090 | 1.0200 |
| 法拉利 Ferrari | SF-26 | Ferrari | 0.9978 | 0.9952 | 1.0135 | 1.0098 | 1.0088 | 1.0014 | 0.9957 | 0.9900 |
| 麥拉倫 McLaren | MCL40 | Mercedes | 1.0055 | 1.0111 | 1.0126 | 1.0073 | 1.0088 | 1.0084 | 0.9957 | 1.0100 |
| 紅牛 Red Bull | RB22 | Red Bull Ford | 1.0019 | 1.0019 | 1.0078 | 1.0068 | 1.0082 | 1.0042 | 1.0047 | 1.0000 |
| 小紅牛 Racing Bulls | VCARB 03 | Red Bull Ford | 1.0019 | 0.9981 | 0.9987 | 1.0008 | 1.0035 | 0.9992 | 1.0052 | 1.0000 |
| Alpine | A526 | Mercedes | 1.0055 | 0.9891 | 0.9971 | 0.9995 | 0.9993 | 0.9970 | 1.0028 | 1.0100 |
| 哈斯 Haas | VF-26 | Ferrari | 0.9978 | 0.9993 | 0.9944 | 0.9958 | 0.9917 | 0.9987 | 0.9994 | 0.9900 |
| 奧迪 Audi | R26 | Audi | 1.0015 | 1.0000 | 1.0027 | 0.9987 | 0.9975 | 0.9986 | 0.9995 | 0.9800 |
| 威廉斯 Williams | FW48 | Mercedes | 1.0055 | 1.0036 | 0.9899 | 0.9912 | 0.9893 | 0.9996 | 1.0055 | 1.0100 |
| 奧斯頓馬丁 Aston Martin | AMR26 | Honda | 0.9686 | 1.0000 | 0.9830 | 0.9889 | 0.9880 | 0.9850 | 0.9708 | 0.9700 |
| 凱迪拉克 Cadillac | MAC-26 | Ferrari | 0.9978 | 1.0055 | 0.9779 | 0.9855 | 0.9830 | 0.9946 | 0.9939 | 0.9900 |

選單評分（0–100，50 = 標準車）與模型估計值：

| 車隊 | 極速 | 加速 | 過彎 | 煞車 | 電能 | 圈速差 | 極速 km/h | 0–300 km/h | 300→80 km/h |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| F1Drive 標準賽車 | 50 | 50 | 50 | 50 | 50 | 0 | 330.0 | 12.66 s | 122.4 m |
| 賓士 Mercedes | 62 | 69 | 71 | 75 | 69 | −0.48 % | 331.0 | 12.46 s | 120.9 m |
| 法拉利 Ferrari | 53 | 59 | 71 | 71 | 41 | −0.37 % | 330.3 | 12.56 s | 121.1 m |
| 麥拉倫 McLaren | 44 | 58 | 67 | 74 | 54 | −0.35 % | 329.4 | 12.57 s | 120.9 m |
| 紅牛 Red Bull | 50 | 58 | 65 | 68 | 53 | −0.29 % | 330.0 | 12.57 s | 121.3 m |
| 小紅牛 Racing Bulls | 55 | 50 | 51 | 54 | 53 | −0.02 % | 330.4 | 12.65 s | 122.1 m |
| Alpine | 70 | 56 | 47 | 44 | 58 | +0.00 % | 331.8 | 12.60 s | 122.7 m |
| 奧迪 Audi | 52 | 46 | 49 | 48 | 37 | +0.05 % | 330.2 | 12.69 s | 122.5 m |
| 哈斯 Haas | 48 | 48 | 39 | 33 | 43 | +0.18 % | 329.8 | 12.68 s | 123.4 m |
| 威廉斯 Williams | 53 | 45 | 28 | 28 | 60 | +0.33 % | 330.2 | 12.71 s | 123.8 m |
| 凱迪拉克 Cadillac | 41 | 29 | 10 | 11 | 40 | +0.71 % | 329.2 | 12.88 s | 124.8 m |
| 奧斯頓馬丁 Aston Martin | 10 | 10 | 19 | 21 | 12 | +0.77 % | 326.4 | 13.07 s | 124.2 m |

圈速差是對標準車、15 條賽道平均、不使用電池的估計值（負值較快）。最快與最慢相差 1.25 %；真實世界同一組數字是 4.36 %。

## 3. 每個倍率乘在哪裡

| 倍率 | 乘在 `js/car.js` 的 | 主要影響 | 倍率 +1 % 的圈速變化 |
| --- | --- | --- | ---: |
| power | POWER（W/kg） | 極速；約 300 km/h 以上的加速 | −0.005 % |
| drag | DRAG_K | 極速、高速段加速（煞車時略有幫助） | +0.090 % |
| downforce | DOWNFORCE | 中高速彎速度、高速煞車 | −0.062 % |
| grip | LAT_BASE 與 LAT_MAX | 所有彎的橫向抓地力（慢彎只看這一項） | −0.185 % |
| brake | BRAKE_BASE | 煞車 | −0.042 % |
| traction | TRACTION | 起步到動力極限之間的加速 | −0.231 % |
| ersPower | ers.power | 按住電池鍵時多出來的動力 | 見下 |
| ersHarvest | ers.harvest | 電池回充速度 | 不影響單圈 |

在目前的物理（v5 的 `js/car.js`）裡，317 km/h 以下的加速度被 TRACTION 上限（11 m/s²）限制，power 與電池只在接近極速時
才有作用：標準車整圈按住電池也只快 0.011 %（極速 330 → 347 km/h）。所以車與車的圈速差距幾乎都來自 traction、grip、drag、downforce、brake；power 與兩個電池倍率
主要決定極速與「手感」。如果 v6 的傳動 / 電池實作改變了這一點，圈速差距要重新檢查（見第 7 節）。

## 4. 換算公式

所有常數都在 `devtests/cars-data/derive.js` 的 `CFG` 與 `RATING`。圈速模型在 `devtests/cars-data/model.js`：把 `js/car.js` 的
受力模型與 `js/raceline.js` 的速度曲線參數化；腳本每次執行都會確認標準車的結果與這兩個模組完全相同。

**步驟 1：速度目標。** 真實差距 P = 0.5 × 排位差距 + 0.3 × 正賽節奏差距 + 0.2 × Autosport 預期圈速差距（都是對最快車隊的 %）。
遊戲目標 = K ×（P − 全場中位數），K = 1.25 ÷（最大 P − 最小 P）= 0.2869。也就是保留真實的順序與比例，
把最快到最慢壓縮成 1.25 %（約為真實的 1/3.5），標準車放在中位數車隊（Alpine）的位置。

| 車隊 | 排位 % | 正賽 % | Autosport % | 綜合 P % | 遊戲目標 % | 模型圈速 % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 賓士 Mercedes | 0.039 | 0.000 | 0.000 | 0.019 | −0.478 | −0.479 |
| 法拉利 Ferrari | 0.402 | 0.343 | 0.500 | 0.404 | −0.368 | −0.369 |
| 麥拉倫 McLaren | 0.454 | 0.527 | 0.486 | 0.482 | −0.345 | −0.347 |
| 紅牛 Red Bull | 0.591 | 0.700 | 0.845 | 0.675 | −0.290 | −0.291 |
| 小紅牛 Racing Bulls | 1.441 | 1.916 | 1.571 | 1.610 | −0.022 | −0.022 |
| Alpine | 1.555 | 1.762 | 1.901 | 1.686 | 0.000 | +0.001 |
| 奧迪 Audi | 1.728 | 2.074 | 1.885 | 1.863 | +0.051 | +0.051 |
| 哈斯 Haas | 2.275 | 2.307 | 2.431 | 2.316 | +0.181 | +0.180 |
| 威廉斯 Williams | 2.736 | 2.725 | 3.251 | 2.836 | +0.330 | +0.330 |
| 凱迪拉克 Cadillac | 4.043 | 4.107 | 4.475 | 4.149 | +0.706 | +0.708 |
| 奧斯頓馬丁 Aston Martin | 4.332 | 4.439 | 4.393 | 4.376 | +0.772 | +0.771 |

這個順序與 15 站排位平均的順序相同；和車隊積分榜相比，奧迪 Audi（積分第 8）排在 哈斯 Haas（積分第 7）前面，凱迪拉克 Cadillac（積分第 11）排在 奧斯頓馬丁 Aston Martin（積分第 10）前面：積分還受可靠度、起跑與正賽際遇影響（Aston Martin 的 3 分來自摩納哥第 10 與荷蘭第 9，Cadillac 至今 0 分；Jolpica 正賽成績）。

**步驟 2：引擎（power）。** 同一具動力單元的車隊共用同一個值：能讓標準車（drag = 1）的極速等於 330 + 0.5 ×（使用這具動力單元的所有車隊的平均極速指數 V，見步驟 3）km/h 的 power。
FIA 的 ADUO 指數（[FIA ADUO][aduo] [2][aduo-2]）只衡量內燃機；2026 年的動力約一半來自電能（400 kW + 350 kW），直線速度很受電能部署影響，例如 Red Bull Ford 的內燃機是 FIA 的基準，
Red Bull 的全季極速卻只在中位數，平均極速最高的反而是用 Mercedes 動力的四隊。若用 ADUO 決定 power，遊戲裡的極速順序會和實測相反（第一版就是這樣：
Red Bull 的遊戲極速高於 Mercedes），所以 ADUO 只列在表中對照、不進公式。對照值 = 1 + 0.5 × 0.533 ×（ADUO 指數 − 全場中位數 −3 %）÷ 100；0.533 是內燃機占總動力的比例（400 kW ÷ 750 kW，[2026 規則][rules]）；
FIA 只公布級距（基準 = 0、「落後 2–4 %」取 −3、「落後超過 4 %」沒有下限，取名目值 −5，是我們的假設）。

| 動力單元 | 使用車隊 | ADUO 指數 % | 家族極速指數 km/h | 由 ADUO（對照） | 由實測極速 | power |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Mercedes-AMG F1 M17 E Performance | Mercedes、McLaren、Alpine、Williams | −3 | +1.25 | 1.0000 | 1.0055 | **1.0055** |
| Ferrari 067/6 | Ferrari、Haas、Cadillac | < −4（取 −5） | −0.50 | 0.9947 | 0.9978 | **0.9978** |
| Red Bull Ford DM01 | Red Bull、Racing Bulls | 0 | +0.42 | 1.0080 | 1.0019 | **1.0019** |
| Audi AFR 26 Hybrid | Audi | < −4（取 −5） | +0.35 | 0.9947 | 1.0015 | **1.0015** |
| Honda RA626H | Aston Martin | < −4（取 −5） | −7.20 | 0.9947 | 0.9686 | **0.9686** |

**步驟 3：風阻（drag）。** 極速指數 V =（最快排位圈的遙測極速差 + 排位測速點差）÷ 2，單位 km/h，都是對全場中位數。
用同一具動力單元的車隊，極速差異來自車身：drag = 1 − 3 × 0.5 ×（V − 同動力單元車隊的平均 V）÷ 330（極速約與（動力 ÷ 風阻）的立方根成正比）。
只有一隊使用的動力單元（Audi、Honda）無法把車和引擎分開，drag 取中性值 1。步驟 2 與 3 合起來，每輛車的遊戲極速 ≈ 330 + 0.5 × V，所以遊戲裡的極速順序與實測相同（`derive.js` 會檢查）。同一具動力單元內的差距放在 drag 上是模型的選擇：真實原因可能是風阻，也可能是電能部署策略，公開資料分不出來。

| 車隊 | 遙測極速差 | 測速點差 | V | 家族內差 | drag | 遊戲極速 km/h |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 賓士 Mercedes | +2.3 | +1.9 | +2.10 | +0.85 | 0.9961 | 331.0 |
| 法拉利 Ferrari | −0.1 | +1.2 | +0.55 | +1.05 | 0.9952 | 330.3 |
| 麥拉倫 McLaren | −1.5 | −0.9 | −1.20 | −2.45 | 1.0111 | 329.4 |
| 紅牛 Red Bull | +0.1 | −0.1 | 0.00 | −0.42 | 1.0019 | 330.0 |
| 小紅牛 Racing Bulls | −0.2 | +1.9 | +0.85 | +0.42 | 0.9981 | 330.4 |
| Alpine | +4.0 | +3.3 | +3.65 | +2.40 | 0.9891 | 331.8 |
| 奧迪 Audi | −0.3 | +1.0 | +0.35 | 無法分離 | 1.0000 | 330.2 |
| 哈斯 Haas | −0.2 | −0.5 | −0.35 | +0.15 | 0.9993 | 329.8 |
| 威廉斯 Williams | +0.4 | +0.5 | +0.45 | −0.80 | 1.0036 | 330.2 |
| 凱迪拉克 Cadillac | −1.3 | −2.1 | −1.70 | −1.20 | 1.0055 | 329.2 |
| 奧斯頓馬丁 Aston Martin | −5.7 | −8.7 | −7.20 | 無法分離 | 1.0000 | 326.4 |

**步驟 4：電池。** ersPower = 1 − 1.0 ×（長直線末段 1/3 的時間，對中位數的 %）÷ 100，以遙測當作部署能力的代理指標。
ersHarvest = 1 + 0.01 × 報導排序分數；沒有任何公開量測，分數只依媒體報導：

| 動力單元 | 分數 | 依據 | 來源 |
| --- | ---: | --- | --- |
| Mercedes（廠隊再 +1） | +1 | 「outstanding when it comes to the integration of harvesting and aerodynamic characteristics. The ERS is efficient」（The Race）；排位圈以 super clipping 為主要回充方式（Autosport）；廠隊再 +1：McLaren 領隊 Stella 承認與 Mercedes 廠隊有「gap in hybrid usage」（Autosport），其他客戶隊沒有直接報導，比照 McLaren 是我們的推論 | [The Race 4/26][weakness]、[Autosport 3/10][mercedesEdge] |
| Ferrari | −1 | 小渦輪反應快、起跑好，但峰值馬力較低，電池為了補償而消耗得快（The Race）；回充較依賴 lift-and-coast（Autosport） | [The Race 4/26][weakness]、[Autosport 3/10][mercedesEdge] |
| Red Bull Ford | 0 | 報導不一致：內燃機是 FIA 基準，但「energy deployment and lack of driveability」被點名（Motorsport.com 8 月）；高速彎中的能量回收效率明顯不如 Mercedes（PlanetF1，3 月）→ 取中性 | [Motorsport 評分][gradeRedBull]、[Motorsport / PlanetF1][redBullPace] [2][redBullPace-2] |
| Audi | −2 | 「less efficient energy management」（Autosport 4 月）；動力不足「snowballs into higher battery deployment」（Motorsport.com 8 月） | [Autosport 逐隊][teamByTeam]、[Motorsport 評分 / Autosport][gradeAudi] [2][gradeAudi-2] |
| Honda | −3 | V6 馬力不足、更依賴電能，「energy recovery efficiency」也有問題，震動曾損壞電池（The Race） | [The Race 4/26][weakness]、[Motorsport 評分][gradeAston] |

**步驟 5：底盤（grip、downforce、brake、traction）。** 倍率 = 1 − 0.5 ×（對應區段的時間，對中位數的 %）÷ 100 + L。
區段對應：grip ← 慢彎區；downforce ←（13 × 中速彎 + 7 × 高速彎）÷ 20（權重是兩者占一圈的比例）；brake ← 慢彎入彎（煞車 + 轉向）；
traction ← 0.5 × 出彎 150 m + 0.5 × 全油門區，再加上 0.390 ×（drag − 1）：實測的區段時間已經包含各車的風阻，所以 drag 倍率
在圈速上的得失由 traction 補回（drag 只決定時間花在極速還是加速上）。0.390 是模型量到的兩者圈速影響比。
L 是每輛車一個數、四個底盤倍率共用，用二分法解出，讓模型圈速剛好等於步驟 1 的目標；它吸收了遙測與圈速資料之間的不一致。
「實測差異取一半」（0.5）是讓 L 最小的取值（`--scan` 會列出比較）。

| 車隊 | grip 輸入 % | downforce 輸入 % | brake 輸入 % | traction 輸入 % | L % |
| --- | ---: | ---: | ---: | ---: | ---: |
| 賓士 Mercedes | −1.57 | −2.68 | −1.88 | −1.13 | +0.16 |
| 法拉利 Ferrari | −1.95 | −2.70 | −1.76 | −0.64 | +0.00 |
| 麥拉倫 McLaren | −1.28 | −2.35 | −1.58 | −0.63 | +0.09 |
| 紅牛 Red Bull | −1.24 | −1.44 | −1.51 | −0.56 | +0.06 |
| 小紅牛 Racing Bulls | −0.23 | +0.18 | −0.78 | −0.07 | −0.04 |
| Alpine | +0.33 | +0.80 | +0.36 | −0.03 | +0.11 |
| 奧迪 Audi | +0.18 | −0.63 | +0.41 | +0.18 | −0.04 |
| 哈斯 Haas | +1.10 | +1.38 | +1.91 | +0.47 | +0.13 |
| 威廉斯 Williams | +1.79 | +2.06 | +2.17 | +0.39 | +0.02 |
| 凱迪拉克 Cadillac | +3.10 | +4.62 | +3.59 | +1.70 | +0.10 |
| 奧斯頓馬丁 Aston Martin | +1.79 | +2.96 | +1.97 | +2.56 | −0.22 |

**步驟 6：** 倍率四捨五入到小數 4 位，並檢查都在 0.95–1.05 之內（沒有任何一項碰到邊界）。表中的圈速、極速與評分都用四捨五入後的值重算。

**步驟 7：評分。** 評分 = 50 + 係數 × x，四捨五入並限制在 0–100；標準車的 x 都是 0。

| 評分 | 係數 | x |
| --- | ---: | --- |
| 極速 topSpeed | 11 | 極速（不含電池）與標準車的差，km/h |
| 加速 accel | 12 | 0–300 km/h 所需時間比標準車少的百分比 |
| 過彎 cornering | 23 | 半徑 30 / 60 / 120 m 平地彎的過彎速度，比標準車高的百分比（三者平均） |
| 煞車 braking | 20 | 300→80 km/h 煞車距離比標準車短的百分比 |
| 電能 ers | 13 | (ersPower − 1) 與 (ersHarvest − 1) 的平均，% |

## 5. 各車隊使用的真實數據

分區時間與極速都是「對全場中位數」；時間為負值表示較快。來源欄是該數字的出處；標示「計算值」的欄位是研究者由官方計時 / 遙測 API 算出來的，
不是該網站發表的數字（見第 8 節的說明）。排位差距、測速點、積分、Autosport 圈速已逐一重算或對照，完全相符；遙測分區是估計值（見第 9 節）。

### 賓士 Mercedes：W17（Mercedes-AMG F1 M17 E Performance）

- 全名：Mercedes-AMG PETRONAS Formula One Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 1 名，538 分，11 勝（[積分榜][standings] [2][standings-2]）。
- 顏色：`#0F100F` / `#BDBCBA`：車身黑（引擎蓋取樣）、銀（車鼻 / 座艙周圍），Petronas 青綠飾條 #37C2B8（[formula1.com 官方圖][paint-mercedes]，自行取樣）；計時畫面車隊色 `#00D7B6`（[OpenF1 drivers][timingColour]）。
- 特性依據：前 10 站全部桿位、11 勝；The Race：ERS 整合、後下壓力、牽引與煞車強，起跑與亂流中部署較弱；遙測：全油門區、牽引區、直線末段、中速彎皆最快。來源：[The Race 4/26][weakness]、[Autosport 3/10][mercedesEdge]、[Motorsport 評分 / The Race][gradeMercedes] [2][gradeMercedes-2]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：全能標竿：加速、煞車與電能管理都是全場最佳，彎道也是頂尖；真實弱點是起跑與可靠度。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 0.039 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 0.000 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 86.211 / 85.218 s（平均差距 0.000 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | +2.3 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | +1.9 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | −1.08 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | −1.17 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | −0.90 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | −1.57 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | −2.88 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | −2.31 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | −1.88 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 26.5 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Mercedes） | 落後 2–4 % | [FIA ADUO][aduo] [2][aduo-2] |

### 法拉利 Ferrari：SF-26（Ferrari 067/6）

- 全名：Scuderia Ferrari HP（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 2 名，378 分，2 勝（[積分榜][standings] [2][standings-2]）。
- 顏色：`#BB1320` / `#DDDDDC`：亮面紅（官方圖有陰影，受光處可達 #D22A2F）、引擎蓋 / 進氣口白（[formula1.com 官方圖][paint-ferrari]，自行取樣）；計時畫面車隊色 `#ED1131`（[OpenF1 drivers][timingColour]）。
- 特性依據：The Race：「best car in terms of corner performance」、引擎約少 20 bhp（傳聞）；Motorsport.com：直線上輸 Mercedes 數個十分之一秒；遙測：慢彎、高速彎最快，直線末段慢於中位數。來源：[The Race 4/26][weakness]、[Motorsport 評分][gradeFerrari]、[The Race Monza][monzaEnergy]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：彎道頂尖、出彎俐落，但動力單元偏弱，長直線尾段會掉速。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 0.402 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 0.343 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 86.990 / 85.301 s（平均差距 0.500 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | −0.1 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | +1.2 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | −0.16 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | −1.11 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | +0.43 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | −1.95 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | −2.86 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | −2.40 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | −1.76 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 29.7 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Ferrari） | 落後超過 4 % | [FIA ADUO][aduo] [2][aduo-2] |

### 麥拉倫 McLaren：MCL40（Mercedes-AMG F1 M17 E Performance）

- 全名：McLaren Mastercard F1 Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 3 名，306 分，2 勝（[積分榜][standings] [2][standings-2]）。
- 顏色：`#F4872C` / `#141212`：木瓜橘、黑 / 碳灰，進氣口藍綠 #1C6B8A（[formula1.com 官方圖][paint-mclaren]，自行取樣）；計時畫面車隊色 `#F47600`（[OpenF1 drivers][timingColour]）。
- 特性依據：開季下壓力 / 氣動效率不足（The Race 4 月、Autosport 3 月），邁阿密–蒙特婁與匈牙利的升級後匈牙利、荷蘭奪勝（Motorsport.com）；Stella 承認與 Mercedes 廠隊有「gap in hybrid usage」（Autosport）；Monza 在三條長直線上都輸，技術總監稱「from an energy perspective」仍待加強（The Race）；用同一具 Mercedes 動力的四隊中極速最低（遙測 −1.5 km/h、測速點 −0.9 km/h）。遊戲把這個差距放在 drag 上（見步驟 3），真實原因是風阻還是電能運用，公開資料分不出來。來源：[The Race 4/26][weakness]、[Autosport 3/10][mercedesEdge]、[Motorsport 評分][gradeMcLaren]、[The Race Monza][monzaEnergy]、[OpenF1 測速點][trap]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：彎道強，季中升級後拿下分站冠軍；但在同一具 Mercedes 動力中直線最慢，極速是前段班最低。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 0.454 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 0.527 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 87.011 / 85.255 s（平均差距 0.486 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | −1.5 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | −0.9 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | −0.58 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | −0.68 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | +0.43 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | −1.28 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | −2.35 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | −2.35 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | −1.58 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 28.2 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Mercedes） | 落後 2–4 % | [FIA ADUO][aduo] [2][aduo-2] |

### 紅牛 Red Bull：RB22（Red Bull Ford DM01）

- 全名：Oracle Red Bull Racing（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 4 名，263 分（[積分榜][standings] [2][standings-2]）。
- 顏色：`#051F94` / `#D9131C`：亮面深藍、紅（黃色 #E9D254 點綴），下車身黑（[formula1.com 官方圖][paint-red-bull]，自行取樣）；計時畫面車隊色 `#4781D7`（[OpenF1 drivers][timingColour]）。
- 特性依據：FIA ADUO：Red Bull Ford 內燃機為基準；Motorsport.com 4 月：時間主要輸在彎道，車子太偏向低風阻、下壓力不足；PlanetF1：高速彎後輪不穩；Motorsport.com 8 月：車子難調、操控難以預測；The Race：彎中推頭；全季平均的測速點 −0.1 km/h、最快圈極速 +0.1 km/h（中位數）；遙測：全油門區第 2，高速彎僅 −0.87 %（前四隊其餘三隊約 −2.3 %）。來源：[FIA ADUO][aduo] [2][aduo-2]、[Motorsport / PlanetF1][redBullPace] [2][redBullPace-2]、[Motorsport 評分][gradeRedBull]、[The Race 4/26][weakness]、[OpenF1 測速點][trap]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：內燃機是 FIA 評定的基準（最強），但全季極速只在中位數；底盤難調，高速彎是前四強中最弱。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 0.591 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 0.700 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 87.390 / 85.493 s（平均差距 0.845 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | +0.1 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | −0.1 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | −0.65 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | −0.47 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | −0.47 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | −1.24 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | −1.75 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | −0.87 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | −1.51 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 26.1 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Red Bull Ford） | 基準 | [FIA ADUO][aduo] [2][aduo-2] |

### 小紅牛 Racing Bulls：VCARB 03（Red Bull Ford DM01）

- 全名：Visa Cash App Racing Bulls Formula One Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 5 名，83 分（[積分榜][standings] [2][standings-2]）。
- 顏色：`#D6D6D5` / `#08419E`：白（官方圖取樣偏灰）、藍，紅色 #DD111B 點綴（[formula1.com 官方圖][paint-racing-bulls]，自行取樣）；計時畫面車隊色 `#6C98FF`（[OpenF1 drivers][timingColour]）。
- 特性依據：Motorsport.com：蒙特婁的新底板讓車「switched on」、「better-than-expected power unit」；The Race：調校窗口窄、很容易開過頭，煞車仍有些不穩；測速點全季平均 +1.9 km/h（與 Mercedes 並列第 2）；遙測：直線末段第 3 佳、掉速最少，高速彎與慢彎出彎略慢；全季進步幅度最大（Autosport 2.117 秒）。來源：[Motorsport 評分][gradeRacingBulls]、[The Race 4/26][weakness]、[Autosport 8/19][autosport]、[OpenF1 測速點][trap]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：中段班最快：直線速度名列前茅（測速點全季平均僅次於 Alpine），彎道中規中矩、調校窗口窄。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 1.441 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 1.916 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 88.123 / 86.006 s（平均差距 1.571 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | −0.2 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | +1.9 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | −0.30 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | +0.16 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | −0.52 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | −0.23 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | −0.06 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | +0.62 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | −0.78 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 23.5 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Red Bull Ford） | 基準 | [FIA ADUO][aduo] [2][aduo-2] |

### Alpine：A526（Mercedes-AMG F1 M17 E Performance）

- 全名：BWT Alpine Formula One Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 6 名，68 分（[積分榜][standings] [2][standings-2]）。
- 顏色：`#3190D5` / `#EC6EAF`：Alpine 藍、BWT 粉紅（[formula1.com 官方圖][paint-alpine]，自行取樣）；計時畫面車隊色 `#00A1E8`（[OpenF1 drivers][timingColour]）。
- 特性依據：測速點全季平均最高（+3.3 km/h）、最快圈極速最高（+4.0 km/h）；荷蘭站大型升級後 Gasly 在 Monza 奪下生涯首個桿位；The Race：「understeer that's particularly costly at high speed」；Motorsport.com：匈牙利時「lacking downforce」；遙測：三種彎都慢於中位數。同一具 Mercedes 動力卻最快，遊戲把它放在 drag 上（見步驟 3）。來源：[OpenF1 測速點][trap]、[Motorsport 評分 / F1.com][gradeAlpine] [2][gradeAlpine-2]、[Crash.net / formula1.com 升級][upgrades] [2][upgrades-2] [3][upgrades-3]、[The Race 4/26][weakness]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：全場極速最高（Monza 桿位），但高速彎推頭、下壓力不足。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 1.555 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 1.762 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 87.853 / 86.835 s（平均差距 1.901 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | +4.0 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | +3.3 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | −0.15 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | +0.09 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | −0.28 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | +0.33 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | +0.82 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | +0.76 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | +0.36 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 28.7 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Mercedes） | 落後 2–4 % | [FIA ADUO][aduo] [2][aduo-2] |

### 哈斯 Haas：VF-26（Ferrari 067/6）

- 全名：TGR Haas F1 Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 7 名，27 分（[積分榜][standings] [2][standings-2]）。
- 顏色：`#D0D0CF` / `#E51112`：白（取樣偏灰）、紅（取樣的點綴色；Wikipedia：「white and red livery」），另有黑 #161616（[formula1.com 官方圖][paint-haas]，自行取樣）；計時畫面車隊色 `#9C9FA2`（[OpenF1 drivers][timingColour]）。
- 特性依據：The Race：單圈只是第 8 快，但正賽穩定得分；Autosport：開季到比利時–匈牙利只快了 0.535 秒，全場最少；Motorsport.com：跟不上對手的升級節奏、部分零件品質不一；遙測：慢彎入彎 +1.91 %（它最弱的區段）、出彎接近中位數、掉速第 2 少。來源：[The Race 4/26][weakness]、[Motorsport 評分][gradeHaas]、[Autosport 8/19][autosport]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：開季正賽表現亮眼，但全季進步幅度最小、單圈速度偏弱，慢彎入彎是弱點。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 2.275 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 2.307 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 88.064 / 87.529 s（平均差距 2.431 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | −0.2 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | −0.5 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | +0.63 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | +0.31 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | +0.06 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | +1.10 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | +1.65 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | +0.87 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | +1.91 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 24.0 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Ferrari） | 落後超過 4 % | [FIA ADUO][aduo] [2][aduo-2] |

### 奧迪 Audi：R26（Audi AFR 26 Hybrid）

- 全名：Audi Revolut F1 Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 8 名，17 分（[積分榜][standings] [2][standings-2]）。
- 顏色：`#8F8881` / `#EA0F06`：鈦銀灰、Audi 紅（2026 奧地利站照片取樣；官方圖為 #C8C6C4 / #FF3835），引擎蓋碳黑（[2026 奧地利站照片][paint-audi]，自行取樣）；計時畫面車隊色 `#F50537`（[OpenF1 drivers][timingColour]）。
- 特性依據：Motorsport.com：Binotto「Regarding the chassis, however, I'm very satisfied」、動力單元不及 Mercedes、起跑「abysmal」；Autosport：「less efficient energy management」；The Race：前 6 次起跑 5 次掉位；遙測：中速彎 −0.72 %、高速彎 −0.47 %（前四隊之外最快），直線掉速第 3 多。來源：[Motorsport 評分 / Autosport][gradeAudi] [2][gradeAudi-2]、[Autosport 逐隊][teamByTeam]、[The Race 4/26][weakness]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：底盤不錯，中高速彎是中段班最好的之一；自製動力單元能量管理較差、起跑吃虧。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 1.728 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 2.074 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 88.250 / 86.416 s（平均差距 1.885 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | −0.3 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | +1.0 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | +0.23 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | +0.14 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | +0.05 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | +0.18 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | −0.72 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | −0.47 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | +0.41 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 29.1 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Audi） | 落後超過 4 % | [FIA ADUO][aduo] [2][aduo-2] |

### 威廉斯 Williams：FW48（Mercedes-AMG F1 M17 E Performance）

- 全名：Atlassian Williams F1 Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 9 名，12 分（[積分榜][standings] [2][standings-2]）。
- 顏色：`#0B33F2` / `#27A3CF`：亮面藍、淺藍（側箱），另有白 #C9C9C8（[formula1.com 官方圖][paint-williams]，自行取樣）；計時畫面車隊色 `#1868DB`（[OpenF1 drivers][timingColour]）。
- 特性依據：The Race：開季超重達 30 kg（約 0.9 秒）、下壓力也不夠；Motorsport.com：「significantly overweight and lacked aerodynamic load」，在高速、高下壓力賽道最差；測速點 +0.5 km/h、最快圈極速 +0.4 km/h；遙測：直線末段 −0.55 %，高速彎 +2.74 %、入彎 +2.17 %；Baku 起用較輕的底盤與新空力套件（Crash.net，只有一站資料）。來源：[The Race 4/26][weakness]、[Motorsport 評分 / Crash.net][gradeWilliams] [2][gradeWilliams-2]、[OpenF1 測速點][trap]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：開季超重又缺下壓力，彎道與煞車吃虧；靠 Mercedes 動力，直線速度仍在中位數以上。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 2.736 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 2.725 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 88.975 / 88.026 s（平均差距 3.251 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | +0.4 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | +0.5 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | +0.58 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | +0.21 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | −0.55 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | +1.79 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | +1.69 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | +2.74 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | +2.17 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 26.5 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Mercedes） | 落後 2–4 % | [FIA ADUO][aduo] [2][aduo-2] |

### 奧斯頓馬丁 Aston Martin：AMR26（Honda RA626H）

- 全名：Aston Martin Aramco Formula One Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 10 名，3 分（[積分榜][standings] [2][standings-2]）。
- 顏色：`#0C5F49` / `#D1CE48`：緞面賽車綠、萊姆黃飾線（下車身為黑）（[formula1.com 官方圖][paint-aston-martin]，自行取樣）；計時畫面車隊色 `#229971`（[OpenF1 drivers][timingColour]）。
- 特性依據：The Race：Honda 動力單元是首要問題（估計占約 2 秒 / 圈）、能量回收效率差；測速點全季最後（−8.7 km/h）；遙測：全油門區、牽引區、直線末段皆最慢，慢彎差距（+1.79 %）小於中高速彎。匈牙利站的 B 規格大改版據報從落後領先者的差距中砍掉約 2 秒，荷蘭站起 Honda 引擎也更強（Motorsport.com）：現在的 AMR26 比全季平均快得多，遊戲用的是全季平均。來源：[The Race 4/26][weakness]、[Motorsport 評分][gradeAston]、[Autosport 逐隊][teamByTeam]、[The Race Monza][monzaEnergy]、[OpenF1 測速點][trap]、[OpenF1 遙測][telemetry]。
- 遊戲內說明：被 Honda 動力單元拖累：極速、加速、電能都是全場最弱，慢彎相對沒那麼差。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 4.332 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 4.439 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 90.000 / 88.960 s（平均差距 4.393 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | −5.7 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | −8.7 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | +2.54 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | +2.59 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | +2.92 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | +1.79 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | +3.14 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | +2.63 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | +1.97 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 33.8 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Honda） | 落後超過 4 % | [FIA ADUO][aduo] [2][aduo-2] |

### 凱迪拉克 Cadillac：MAC-26（Ferrari 067/6）

- 全名：Cadillac Formula 1 Team（[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]）。積分榜第 11 名，0 分（[積分榜][standings] [2][standings-2]）。
- 顏色：`#DBDDDB` / `#232327`：白、黑（2026 奧地利站照片取樣；奧地利站起改用左右對稱、以白為主的塗裝，formula1.com 官方側視圖仍是發表時的黑色那一側）（[2026 奧地利站照片][paint-cadillac]，自行取樣）；計時畫面車隊色 `#909090`（[OpenF1 drivers][timingColour]）。
- 特性依據：The Race：Pérez「The balance itself is not too bad. It's just that we are lacking the load」、平均落後 4.6 %；Motorsport.com：煞車過熱（奧地利兩車、匈牙利再發生）、9 次退賽；遙測：慢 / 中 / 高速彎與入彎皆最慢，最快圈極速比中位數低 1.3 km/h、測速點低 2.1 km/h。來源：[The Race 4/26][weakness]、[Motorsport 評分][gradeCadillac]、[Autosport 逐隊][teamByTeam]、[OpenF1 遙測][telemetry]、[Cadillac 塗裝][cadillacLivery] [2][cadillacLivery-2]。
- 遊戲內說明：新車隊首作：平衡尚可但嚴重缺下壓力，三種彎都是全場最慢，極速略低於中位數。

| 真實數據 | 數值 | 來源 |
| --- | ---: | --- |
| 排位差距（對該場最快，15 站平均） | 4.043 % | [Jolpica 排位成績][quali] [2][quali-2] |
| 正賽節奏差距（對最快車隊，中位數） | 4.107 % | [OpenF1 正賽單圈][race] |
| Autosport 預期圈速（AUS–CHN / BEL–HUN） | 90.479 / 88.626 s（平均差距 4.475 %） | [Autosport 8/19][autosport] |
| 最快排位圈極速（對全場中位數） | −1.3 km/h | [OpenF1 遙測][telemetry] |
| 排位測速點（對全場中位數） | −2.1 km/h | [OpenF1 測速點][trap] |
| 全油門區時間 | +1.55 % | [OpenF1 遙測][telemetry] |
| 慢彎出彎 150 m（牽引）時間 | +1.84 % | [OpenF1 遙測][telemetry] |
| 長直線末段 1/3 時間 | +0.61 % | [OpenF1 遙測][telemetry] |
| 慢彎區時間 | +3.10 % | [OpenF1 遙測][telemetry] |
| 中速彎區時間 | +4.44 % | [OpenF1 遙測][telemetry] |
| 高速彎區時間 | +4.94 % | [OpenF1 遙測][telemetry] |
| 慢彎入彎（煞車 + 轉向）時間 | +3.59 % | [OpenF1 遙測][telemetry] |
| 長直線尖峰到末端的掉速（僅列出，不進公式） | 26.5 km/h | [OpenF1 遙測][telemetry] |
| FIA ADUO 內燃機級距（Ferrari） | 落後超過 4 % | [FIA ADUO][aduo] [2][aduo-2] |

## 6. 估計與缺漏

- **沒有官方規格。** 各車的馬力、風阻係數、下壓力、車重、軸距都沒有公開；所有倍率都是由圈速、測速與遙測反推的估計。
- **哪些是計算值。** 排位差距由 Jolpica（Ergast）的官方計時計算，寫這份資料時重算過一次。正賽節奏與遙測分區是研究者用 OpenF1 的原始資料
  自行計算，沒有第三方發表的版本可比對；正賽節奏沒有修正油量、輪胎與藍旗，後段車隊（Cadillac、Aston Martin）被高估零點幾個百分點。
- **遙測樣本小。** 每隊每站只取一圈（最快排位圈，約 3.7 Hz），車手、賽道演進與失誤都混在裡面；165 圈中有 12 圈無法對齊而捨棄，
  Aston Martin 只有 11 站、Racing Bulls 與 Haas 13 站。
- **FIA ADUO 只有級距，而且只看內燃機。** 所以 power 由實測極速決定，ADUO 只作對照；「超過 4 %」的 −5 是名目假設。Honda 真正落後多少沒有可靠數字（「約 80 hp」只見於無法查證的網站，未採用）；
  Ferrari「約少 20 bhp」是 The Race 標明的傳聞，也未採用。Audi 的內燃機被 FIA 評為落後超過 4 %，實測極速卻略高於中位數（報導指它用更多電池補償），
  遊戲照實測給它略高於 1 的 power，這一點與 ADUO 的方向相反。
- **drag 無資料的車：** Audi、Aston Martin 用的動力單元只有一隊，無法與車身分開，drag = 1。
- **電池兩項最不確定。** 各隊的部署與回收沒有任何公開量測。ersPower 的代理指標（直線末段時間）混有風阻與引擎的影響；ersHarvest 只有報導排序。
  「直線尖峰到末端的掉速」雖然有數字，但前段車隊是刻意 superclip，不能解讀成電能差，所以只列出、不進公式。
- **沒有對應倍率、因此沒用到的報導：** 車重（Williams 開季超重約 30 kg，其影響已含在它的分區時間裡）、輪胎損耗、可靠度、
  起跑（Ferrari 起跑快；Audi、Red Bull、Mercedes 起跑差）、正賽與排位的落差（Haas）。
- **顏色不是官方色碼。** `colour` / `colour2` 是從 formula1.com 官方側視圖（Audi、Cadillac 另用 2026 奧地利站照片）取樣的結果，取的是受光面，
  白色會偏灰；只有 `colourTeam`（F1 計時畫面的車隊色）是公布值。Cadillac 自奧地利站起改用以白為主的對稱塗裝（[Cadillac 塗裝][cadillacLivery] [2][cadillacLivery-2]），formula1.com 的側視圖仍是發表時黑色的那一側。
- **分得出來嗎（CIEDE2000 色差，約 10 以上才一眼分得出）。** 只看主色（小地圖上的單色圓點）：Racing Bulls / Haas 1.4、Racing Bulls / Cadillac 1.9、Haas / Cadillac 3.2，其餘兩兩至少 13.3（Red Bull / Williams）。
  2026 年真的有三輛以白為主的車（Haas 白紅、Racing Bulls 白藍、Cadillac 白黑），改用它們的其他官方色（紅、藍、黑）又會撞上 Ferrari、Red Bull、Mercedes（色差只有約 7–10），
  所以主色照實保留，靠第二色區分：主色與第二色合計，最接近的一對是 Haas / Audi（20.8 + 1.8），`derive.js` 會擋下合計低於 15 的一對。
  **建議小地圖用雙色圓點（`colour` 填色、`colour2` 外圈）或沿用玩家自選的顏色。** 官方計時色 `colourTeam` 也有撞色：Ferrari / Audi 1.9、Haas / Cadillac 5.1。
  標準車的灰色與 Audi 的主色相差 11.1。
- **中文隊名。** 賓士、法拉利、麥拉倫、紅牛、哈斯、奧迪、威廉斯、奧斯頓馬丁、凱迪拉克都是台灣媒體與台灣車迷站 F-1.TW 的寫法（[台灣媒體][zhNames] [2][zhNames-2] [3][zhNames-3] [4][zhNames-4] [5][zhNames-5] [6][zhNames-6] [7][zhNames-7] [8][zhNames-8] [9][zhNames-9]）；
  Mercedes 在台灣也常寫「梅賽德斯」（ETtoday 運動雲、NOWnews），這裡用同樣常見、且是台灣品牌名的「賓士」（TVBS、民視、ETtoday 車雲、F-1.TW）。
  Alpine 沒有通行譯名（F-1.TW 寫「阿爾派」、中文維基寫「阿爾卑」，Red Bull 台灣官網與美麗佳人直接寫 Alpine），所以用英文；
  Racing Bulls 沒有固定譯名，用聯合新聞網出現過的俗稱「小紅牛」（F-1.TW 寫「視覺賽車」，並不通行）。
- **引述文字。** 外電報導是透過自動摘要工具讀取的；第 9 節列出的引句已再對照過一次，其餘仍請視為近似轉述，正式引用前應回原文核對。
- **圈速是模型估計。** 用的是賽車線速度曲線（與遊戲畫賽車線的演算法相同），不含電池、輪胎與駕駛失誤；實車物理的檢查見下一節。
- **校正用的是 v5 基準車的物理。** 倍率是乘在「標準車」上的相對值，1.25 % 的差距是在目前 `js/car.js` 的常數（`F1.CAR_PERF`）上量到的。
  如果之後 2026 年的標準車改用另一組年代物理，各倍率對圈速的影響會略有不同，要把 `model.js` 的 `BASE` 換成那組數值後重跑 `derive.js` 與 `drive-check.js`。

## 7. 檢查與重新產生

```
node devtests/cars-data/derive.js            # 重新產生 js/cars-data.js、本檔與 devtests/cars-data/derived.json（約 10 秒）
node devtests/cars-data/derive.js --check    # 只比對，檔案與重算結果不同就以非零狀態結束
node devtests/cars-data/derive.js --dry --scan   # 只計算不寫檔，並列出不同 GAIN 下 L 的大小
node devtests/cars-data/check.js             # js/cars-data.js 的格式檢查（node 與 window 兩種載入方式）
node devtests/cars-data/drive-check.js       # 用真正的 js/car.js 物理讓自動駕駛跑每輛車（約 1 分鐘）
```

`derive.js` 每次都會檢查：標準車的模型與 `F1.CAR_PERF`、`F1.buildRaceLine().lapTime` 相同；遊戲內的速度順序與真實綜合差距的順序相同；
最快與最慢的差距在 1–1.5 % 之內；每輛車的模型圈速與目標相差不到 0.01 %；遊戲極速的順序與實測極速指數 V 的順序相同；倍率都在範圍內；id 與顏色格式正確；任兩隊的塗裝（主色 + 第二色）色差合計不低於 15；標準車在第一筆且全為 1。
`derived.json` 保留所有中間值（每輛車在各賽道的圈速差、標準車的圈速、L、評分的 x 等）。

**實車物理檢查（`drive-check.js`）。** `js/car.js` 目前還不接受各車規格，所以檢查時是把它的原始碼在記憶體中複製一份、把常數乘上倍率
（磁碟上的檔案不動），再讓賽車線自動駕駛在 15 條賽道各跑 3 圈、取飛行圈。結果（對標準車的圈速差，15 條賽道平均）：

| 車隊 | 模型估計 % | 實際駕駛 % |
| --- | ---: | ---: |
| 賓士 Mercedes | −0.48 | −0.48 |
| 法拉利 Ferrari | −0.37 | −0.38 |
| 麥拉倫 McLaren | −0.35 | −0.35 |
| 紅牛 Red Bull | −0.29 | −0.30 |
| 小紅牛 Racing Bulls | −0.02 | −0.04 |
| Alpine | 0.00 | −0.01 |
| 奧迪 Audi | +0.05 | +0.04 |
| 哈斯 Haas | +0.18 | +0.17 |
| 威廉斯 Williams | +0.33 | +0.32 |
| 凱迪拉克 Cadillac | +0.71 | +0.69 |
| 奧斯頓馬丁 Aston Martin | +0.77 | +0.75 |

實際駕駛的最快與最慢相差 1.23 %，順序與模型相同；沒有任何一圈出界或擦牆。
等 `js/car.js` 實作 v6 的 `F1.createCar(spec)` 之後，這支腳本會改走正式介面（該路徑尚未測試過），屆時要再跑一次。

## 8. 來源

網址集中寫在本檔最後的連結定義裡（原始檔可直接看到）。

- formula1.com 2026 車隊積分榜；Jolpica (Ergast) constructorStandings，第 15 站後：[積分榜][standings] [2][standings-2]
- Jolpica (Ergast) 排位賽成績，第 1–15 站（計算值：各隊 Q1/Q2/Q3 最快圈 ÷ 該場最快圈 − 1，15 站平均）：[Jolpica 排位成績][quali] [2][quali-2]
- OpenF1 正賽單圈（計算值：各隊較快車的綠旗圈中位數 ÷ 最快車隊 − 1，取 15 站中位數；未修正油量、輪胎、藍旗）：[OpenF1 正賽單圈][race]
- Autosport 2026-08-19「How much performance has each F1 team gained over 2026」：supertimes 換算的預期圈速（澳洲–中國平均、比利時–匈牙利平均）：[Autosport 8/19][autosport]
- OpenF1 st_speed，15 場排位賽的測速點最高速（計算值：各隊最佳 − 全場中位數，km/h，15 站平均）：[OpenF1 測速點][trap]
- OpenF1 car_data，各隊每站最快排位圈的遙測（計算值：分區時間相對全場中位數，%；負值 = 較快；約 3.7 Hz，每隊每站一圈）：[OpenF1 遙測][telemetry]
- FIA ADUO 內燃機性能指數：第一次檢視（到加拿大站為止；Sky Sports 2026-06-07）Red Bull Ford 為基準、Mercedes 落後 2–4 %、Ferrari / Audi / Honda 落後超過 4 %；第二次檢視（到匈牙利站；Pitpass 2026-08-26）沒有再給任何廠商額外升級（只衡量內燃機，不含電能）：[FIA ADUO][aduo] [2][aduo-2]
- formula1.com 2026 規則說明：內燃機約 400 kW、電動 350 kW（約 50:50）：[2026 規則][rules]
- The Race 2026-04-26「Every 2026 F1 team's big weakness」：[The Race 4/26][weakness]
- Autosport 2026-03-10「How Mercedes' advantage in F1 2026 goes beyond the engine」：[Autosport 3/10][mercedesEdge]
- Autosport 2026-04-14「How every F1 2026 team has performed so far」：[Autosport 逐隊][teamByTeam]
- The Race 2026-09-05「What F1 teams' Monza deployment patterns have revealed」（義大利站第二次練習的電能部署分析）：[The Race Monza][monzaEnergy]
- Motorsport.com 2026-04-11「Red Bull's 2026 F1 pace is its slowest since 2015」；PlanetF1 2026-03-16「Why Red Bull are slow」：[Motorsport / PlanetF1][redBullPace] [2][redBullPace-2]
- Motorsport.com 2026-08-13 季中評分：Red Bull：[Motorsport 評分][gradeRedBull]
- Motorsport.com 2026-08-15 季中評分：Ferrari：[Motorsport 評分][gradeFerrari]
- Motorsport.com 2026-08-15 季中評分：McLaren：[Motorsport 評分][gradeMcLaren]
- Motorsport.com 2026-08-12 季中評分：Racing Bulls：[Motorsport 評分][gradeRacingBulls]
- Motorsport.com 2026-08-11 季中評分：Alpine；formula1.com 2026-09-05 Monza 排位賽報導：[Motorsport 評分 / F1.com][gradeAlpine] [2][gradeAlpine-2]
- Motorsport.com 2026-08-10 季中評分：Haas：[Motorsport 評分][gradeHaas]
- Motorsport.com 2026-08-09 季中評分：Audi；Autosport 2026-08-01「Audi won't upgrade F1 power unit again until 2027」：[Motorsport 評分 / Autosport][gradeAudi] [2][gradeAudi-2]
- Motorsport.com 2026-08-08 季中評分：Williams（Yahoo 轉載）；Crash.net 2026-09-25 Baku 升級（較輕的底盤與新空力套件）：[Motorsport 評分 / Crash.net][gradeWilliams] [2][gradeWilliams-2]
- Motorsport.com 2026-08-07 季中評分：Aston Martin：[Motorsport 評分][gradeAston]
- Motorsport.com 2026-08-06 季中評分：Cadillac：[Motorsport 評分][gradeCadillac]
- Motorsport.com 2026-08-16 季中評分：Mercedes（Yahoo 轉載）；The Race 2026-06-17「The true cost of Mercedes' biggest 2026 weakness」（可靠度）：[Motorsport 評分 / The Race][gradeMercedes] [2][gradeMercedes-2]
- formula1.com 各車隊頁（Full Team Name / Chassis / Power Unit，例如 /en/teams/mercedes）；Wikipedia 2026 賽季報名表；動力單元全名見 Wikipedia 車款條目（例：Mercedes W17 的「Mercedes-AMG F1 M17 E Performance」）：[formula1.com / Wikipedia][identity] [2][identity-2] [3][identity-3]
- OpenF1 drivers（F1 官方即時計時的 team_colour）：[OpenF1 drivers][timingColour]
- 季中大改版：Red Bull 首批升級在邁阿密、奧地利站大改（Crash.net 2026-06-26；formula1.com 2026-06-26「significant upgrade package」）；Alpine 荷蘭站首個大型升級（formula1.com）：[Crash.net / formula1.com 升級][upgrades] [2][upgrades-2] [3][upgrades-3]
- Cadillac 自奧地利站起改用左右對稱、以白為主的塗裝（Motorsport.com「Why Cadillac abandoned its split F1 livery」；Wikipedia Cadillac MAC-26）：[Cadillac 塗裝][cadillacLivery] [2][cadillacLivery-2]
- 台灣的隊名寫法：ETtoday、TVBS、NOWnews、民視、聯合新聞網、台灣車迷站 F-1.TW 積分榜；Alpine 寫英文的例子：Red Bull 台灣官網、美麗佳人：[台灣媒體][zhNames] [2][zhNames-2] [3][zhNames-3] [4][zhNames-4] [5][zhNames-5] [6][zhNames-6] [7][zhNames-7] [8][zhNames-8] [9][zhNames-9]
- 各車塗裝取樣用的圖：[Mercedes][paint-mercedes]、[Ferrari][paint-ferrari]、[McLaren][paint-mclaren]、[Red Bull][paint-red-bull]、[Racing Bulls][paint-racing-bulls]、[Alpine][paint-alpine]、[Haas][paint-haas]、[Audi][paint-audi]、[Williams][paint-williams]、[Aston Martin][paint-aston-martin]、[Cadillac][paint-cadillac]

OpenF1 與 Jolpica 是計時資料的 API：分站的網址只差 `session_key` 或站次。排位賽的 session_key：澳洲 11230、中國 11241、日本 11249、邁阿密 11276、加拿大 11287、摩納哥 11295、巴塞隆納 11303、奧地利 11311、英國 11322、比利時 11330、匈牙利 11338、荷蘭 11349、義大利 11357、馬德里 11365、亞塞拜然 11373；
正賽：11234、11245、11253、11280、11291、11299、11307、11315、11326、11334、11342、11353、11361、11369、11377。

## 9. 獨立查核（2026-10-01）

第二位查核者沒有看研究者的筆記，逐項開啟上面的網址並用計時 API 重算。

**相符（已驗證）**

- 11 支車隊、全名、底盤代號、動力單元供應商：formula1.com 各隊頁與 Wikipedia 報名表一致；動力單元全名（M17 E Performance、067/6、DM01、AFR 26 Hybrid、RA626H）見 Wikipedia 車款條目。
  2026 年沒有 Sauber（由 Audi 廠隊取代），Cadillac 是第 11 隊；截至 9/30 沒有車隊改名。F1DB 的車隊代號與 `tools/seasons-raw.json` 一致。
- 積分榜（538 / 378 / 306 / 263 / 83 / 68 / 27 / 17 / 12 / 3 / 0 分）與勝場（Mercedes 11、Ferrari 2、McLaren 2）：formula1.com 與 Jolpica 一致；前 10 站桿位全是 Mercedes，Monza 桿位是 Gasly。
- 已賽 15 站與日期（亞塞拜然站 9/26 週六）：Jolpica 賽程；OpenF1 的 30 個 session_key 一致。
- 排位差距 11 隊的平均與中位數：由 Jolpica 15 站排位成績重算，到小數第 3 位完全相同。
- 測速點 11 隊：由 OpenF1 15 場排位的 st_speed 重算，到小數第 1 位完全相同。
- 正賽節奏：用不同的綠旗圈篩選重算，11 隊順序相同、數值相差 0.1 個百分點以內（Red Bull 0.61 對 0.70）。
- Autosport 8/19 的 22 個圈速：與原文表格完全相同（原文以 Aston Martin 開季 = 90.000 秒為基準）。
- FIA ADUO 級距與「只看內燃機」（Sky Sports、Pitpass）；2026 規則 400 kW / 350 kW（formula1.com）。
- 計時畫面車隊色 11 個：與 OpenF1 drivers 完全相同。塗裝取樣色：另行取樣官方側視圖的受光面，色相與明暗都相符。
- 引句（已對照原文）：The Race 4/26 的「outstanding when it comes to the integration of harvesting…」「best car in terms of corner performance」「somewhere in the region of 20bhp」（傳聞）、
  「overweight … 30kg … nine tenths」「lacking the load」「4.6% off」「lost places five times」「eighth-fastest」；Motorsport.com 的「snowballs into higher battery deployment」「abysmal starts」
  「switched the car on」「lacking downforce」「losing several tenths of lap time on the straights」；Autosport 的「less efficient energy management」「gap in hybrid usage」。

**更正**

- 直線速度順序：第一版的 power 取自 FIA ADUO（只看內燃機），使 Red Bull 的遊戲極速（330.7）高於 Mercedes（330.4），與實測（Mercedes +2.1 km/h、Red Bull 0.0）相反；
  現改由各動力單元的實測極速決定（步驟 2），遊戲極速順序與實測完全相同，並由 `derive.js` 檢查。Red Bull 的說明也改為「全季極速只在中位數」。
- 「和積分榜相比只有 Audi 排在 Haas 前面」不對：Cadillac 也排在 Aston Martin 前面（上文已改為自動列出）。
- Red Bull 的季中大改是邁阿密與奧地利，不是摩納哥（formula1.com：摩納哥只有 4 項以散熱為主的小改）。
- Mercedes 的電能引句原寫成「outstanding ERS integration, efficient harvesting」，已改成原文；「客戶隊的電能運用落後廠隊」只有 McLaren 領隊的說法（Autosport），不是 The Race，
  套用到 Williams、Alpine 是推論，已註明。McLaren 的「風阻偏大」改為「同一具動力中直線最慢」：原因是風阻還是電能部署（車隊自己說是 energy），公開資料分不出來。
- Haas：「均衡好開」沒有出處，刪除；「全季升級最少」改為「全季進步幅度最小」（Autosport 量的是圈速進步，不是升級數量）；「零件品質不一」出自 Motorsport.com，不是 Autosport。
- Alpine：The Race 說的是高速推頭，不是「彎中推頭」；「低風阻」是推論，改為只寫實測的「全場極速最高」。
- Racing Bulls：直線末段是第 3 佳（Williams 第 2），不是第 2；說明改為依測速點的「直線速度名列前茅」。
- Aston Martin：匈牙利 B 規格不是「略有起色」，Motorsport.com 說它從落後的差距中砍掉約 2 秒；Williams 的 Baku 升級是「較輕的底盤」，沒有「B 規格」的說法。
- The Race 的 Monza 文章標題與日期、各篇評分的日期已補上；Cadillac 塗裝改變補上出處；中文隊名補上「梅賽德斯」「阿爾派」等其他寫法。

**無法驗證、仍是估計**

- 遙測分區（全油門、牽引、直線末段、慢 / 中 / 高速彎、入彎）與最快圈極速：研究者的分區定義與對齊方法沒有公開版本。查核者用自己的粗略方法（以速度積分對齊、依中位數油門分區）重算，
  慢 / 中 / 高速彎與入彎的前後順序大致相同（Mercedes、Ferrari 最快，Cadillac 最慢），最快圈極速的順序也大致相同；全油門、牽引與直線末段的數值則隨方法變動很大，只能當作方向參考。
- 電池兩項（ersPower、ersHarvest）沒有公開量測；ersHarvest 的排序分數是依報導的判斷。
- 「正賽節奏高估後段車隊零點幾個百分點」是研究者的判斷，沒有量化來源。
- 各車的真實馬力、風阻、下壓力、車重都沒有公開數字。

[gradeRacingBulls]: https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-racing-bulls-stuns-midfield-pack-/10845309/
[upgrades]: https://www.crash.net/f1/news/1099336/1/red-bull-reveals-seven-part-upgrade-crucial-home-austria-f1-race
[upgrades-2]: https://www.formula1.com/en/latest/article/all-the-details-on-red-bulls-significant-upgrade-package-and-every-other-teams-updates-in-austria.HWTF5D6l7LfVlTD9PX59K
[upgrades-3]: https://www.formula1.com/en/latest/article/how-alpines-dutch-gp-upgrades-have-propelled-gasly-to-the-front-of-the-midfield-battle.66MuOGDn4ewCtYgzQUUShR
[gradeMcLaren]: https://motorsport.com/f1/news/f1-2026-mid-season-grades-mclaren-starts-on-the-back-foot-but-makes-rapid-progress/10846244/
[gradeAston]: https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-aston-martin-seeks-redemption-after-shocking-start/10844630/
[gradeWilliams]: https://sports.yahoo.com/articles/f1-2026-mid-season-grades-williams-takes-shocking-step-backwards-090346348.html
[gradeWilliams-2]: https://www.crash.net/f1/news/1105267/1/early-verdict-williams-big-azerbaijan-grand-prix-f1-upgrade-package
[standings]: https://www.formula1.com/en/results/2026/team
[standings-2]: https://api.jolpi.ca/ergast/f1/2026/constructorstandings.json
[aduo]: https://www.skysports.com/f1/news/13551591/aduo-in-f1-red-bull-engine-top-rated-by-fia-as-mercedes-ferrari-granted-upgrades-for-2026-formula-1-season
[aduo-2]: https://www.pitpass.com/83381/FIA-reveals-ADUO-rankings
[rules]: https://www.formula1.com/en/latest/article/fia-unveils-formula-1-regulations-for-2026-and-beyond-featuring-more-agile.75qJiYOHXgeJqsVQtDr2UB
[weakness]: https://www.the-race.com/formula-1/every-2026-f1-team-big-weakness/
[mercedesEdge]: https://www.autosport.com/f1/news/how-mercedes-advantage-in-f1-2026-goes-beyond-the-engine/10803973/
[gradeRedBull]: https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-red-bull-stumbles-but-summer-rally-shows-glimmer-of-progress/10845430/
[redBullPace]: https://www.motorsport.com/f1/news/analysis-red-bulls-2026-f1-pace-is-its-slowest-since-2015/10812084/
[redBullPace-2]: https://www.planetf1.com/chinese-grand-prix/why-red-bull-are-slow-2026-max-verstappen-rb22-problems
[teamByTeam]: https://www.autosport.com/f1/news/how-every-f1-2026-teams-performed-so-far-team-by-team/10812457/
[gradeAudi]: https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-audi-gets-off-to-solid-start-on-works-debut/10845164/
[gradeAudi-2]: https://www.autosport.com/f1/news/audi-wont-upgrade-f1-power-unit-again-until-2027/10843491/
[identity]: https://www.formula1.com/en/teams
[identity-2]: https://en.wikipedia.org/wiki/2026_Formula_One_World_Championship
[identity-3]: https://en.wikipedia.org/wiki/Mercedes_W17
[paint-mercedes]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/mercedes/2026mercedescarright.png
[timingColour]: https://api.openf1.org/v1/drivers?session_key=11377
[gradeMercedes]: https://sports.yahoo.com/articles/f1-2026-mid-season-grades-mercedes-early-dominance-evaporates-as-reliability-woes-strike-113002800.html
[gradeMercedes-2]: https://www.the-race.com/formula-1/the-true-cost-of-mercedes-biggest-2026-weakness/
[telemetry]: https://api.openf1.org/v1/car_data?session_key=11357&driver_number=63
[quali]: https://api.jolpi.ca/ergast/f1/2026/1/qualifying.json
[quali-2]: https://api.jolpi.ca/ergast/f1/2026/15/qualifying.json
[race]: https://api.openf1.org/v1/laps?session_key=11377
[autosport]: https://www.autosport.com/f1/news/how-much-performance-has-each-f1-team-gained-over-2026/10846928/
[trap]: https://api.openf1.org/v1/laps?session_key=11357
[paint-ferrari]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/ferrari/2026ferraricarright.png
[gradeFerrari]: https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-innovative-ferrari-impresses-with-strong-start/10846497/
[monzaEnergy]: https://www.the-race.com/formula-1/f1-teams-monza-italian-gp-early-energy-depoyment-patterns/
[paint-mclaren]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/mclaren/2026mclarencarright.png
[paint-red-bull]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/redbullracing/2026redbullracingcarright.png
[paint-racing-bulls]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/racingbulls/2026racingbullscarright.png
[paint-alpine]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/alpine/2026alpinecarright.png
[gradeAlpine]: https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-alpine-makes-great-strides-but-struggles-to-maintain-momentum/10845239/
[gradeAlpine-2]: https://www.formula1.com/en/latest/article/gasly-charges-to-sensational-maiden-f1-pole-at-monza-over-russell-and-piastri.4CKkkbvgmqL04ijMNBfuXF
[paint-haas]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/haasf1team/2026haasf1teamcarright.png
[gradeHaas]: https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-haas-gets-left-behind-after-strong-start/10845177/
[paint-audi]: https://commons.wikimedia.org/wiki/File:FIA_F1_Austria_2026_Nr._5_Bortoleto_(3).jpg
[paint-williams]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/williams/2026williamscarright.png
[paint-aston-martin]: https://media.formula1.com/image/upload/c_lfill,w_1600/q_auto/d_common:f1:2026:fallback:car:2026fallbackcarright.webp/v1740000001/common/f1/2026/astonmartin/2026astonmartincarright.png
[paint-cadillac]: https://commons.wikimedia.org/wiki/File:FIA_F1_Austria_2026_Nr._11_Perez_(3).jpg
[gradeCadillac]: https://au.motorsport.com/f1/news/f1-2026-mid-season-grades-cadillac-gets-off-to-respectable-start-to-its-adventure/10844401/
[cadillacLivery]: https://www.motorsport.com/f1/news/why-cadillac-has-abandoned-its-split-f1-livery/10839741/
[cadillacLivery-2]: https://en.wikipedia.org/wiki/Cadillac_MAC-26
[zhNames]: https://speed.ettoday.net/news/3133372
[zhNames-2]: https://news.tvbs.com.tw/sports/3151931
[zhNames-3]: https://sports.ettoday.net/news/3156026
[zhNames-4]: https://www.nownews.com/news/6762442
[zhNames-5]: https://sport.ftvnews.com.tw/news/detail/2026608W0004
[zhNames-6]: https://udn.com/news/story/7005/9178721
[zhNames-7]: https://f-1.tw/standings/
[zhNames-8]: https://www.redbull.com/tw-zh/formula-one-teams-and-drivers-guide
[zhNames-9]: https://www.marieclaire.com.tw/lifestyle/issue/90444
