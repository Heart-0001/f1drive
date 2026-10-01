# F1 2010–2026 年代規格研究

這份文件是 `tools/eras.json` 的可讀版，給物理與聲音模型校正用。資料查到 2026-10-01 為止。

每個數字在 JSON 裡都是一筆 `{ v, unit, src }`：有來源的附來源代號；估計值標 `est: true` 並寫出依據；查不到的標 `unknown: true`；由檔內其他數字算出來的標 `derived: true`。目前共 526 筆有來源、138 筆估計、25 筆查不到、105 筆推算。下面表格裡「（估）」就是估計值。

2026-10-01 另做了一輪獨立查核，改掉的地方逐條列在第 10 節，JSON 裡也有一份（`factCheck.corrections`）。改動最大的是混合動力年代的馬力：原本用的維基百科數字大多被維基百科自己標成「來源不可靠」，也比 FIA、Formula1.com、Mercedes 的官方說法高 10～15%，現在改成以官方數字為準（見第 2、8 節）。

## 1. 年代分段

17 個賽季分成 7 段，每一年只落在一段裡。同一段內逐年不同的數字（最低重量、馬力）放在 `seasons[年份]`。

| 期間 | 引擎 | 轉速上限（規則）／實際換檔／怠速 | 前進檔 | 能量回收 | 空力輔助 | 輪胎 前／後／輪圈 | 車寬 | 遊戲座艙 |
|---|---|---|---|---|---|---|---|---|
| 2010 | 2.4L V8 | 18000／約 17800（估）／4500（估） | 7 | 無（規則允許 KERS，車隊協議不裝） | F-duct（無 DRS） | 245／325（估） mm／13 吋 | 1800 mm | modern |
| 2011–2013 | 2.4L V8 + KERS | 18000／約 17800（估）／4500（估） | 7 | KERS 60 kW、每圈 400 kJ（約 6.7 秒） | DRS | 245／325 mm／13 吋 | 1800 mm | modern |
| 2014–2016 | 1.6L V6 渦輪混合動力 | 15000／約 11800（估）／4000（規則上限） | 8 | ERS：MGU-K 120 kW、每圈回收 2 MJ／釋放 4 MJ、電池窗口 4 MJ、MGU-H 不限 | DRS | 245／325 mm／13 吋 | 1800 mm | modern |
| 2017–2018 | 1.6L V6 渦輪混合動力 | 15000／約 11800（估）／4000（規則上限） | 8 | 同 2014–2016 | DRS | 305／405 mm／13 吋 | 2000 mm | 2017 modern、2018 halo |
| 2019–2021 | 1.6L V6 渦輪混合動力 | 15000／約 11800（估）／4000（規則上限） | 8 | 同 2014–2016 | DRS（開口加大） | 305／405 mm／13 吋 | 2000 mm | halo |
| 2022–2025 | 1.6L V6 渦輪混合動力 | 15000／約 11800（估）／4000（規則上限） | 8 | 同 2014–2016 | DRS | 305／405 mm／18 吋 | 2000 mm | halo18 |
| 2026 | 1.6L V6 渦輪混合動力（電力約五成） | 無明文上限／約 11500（估）／4000（規則上限） | 8 | ERS-K 350 kW、每圈回充上限 8.5 MJ、電池窗口 4 MJ、取消 MGU-H | 主動空力（彎道模式／直線模式）＋超車模式 | 280／375 mm／18 吋 | 1900 mm | halo18 |

分段的理由：

- **2010**：禁止賽中加油（滿油起跑）、最低重量 620 kg、前輪變窄（270 → 245 mm）。規則仍允許 KERS，但車隊協議整年不裝。雙層擴散器與 F-duct 合法，2011 起都被禁。這是普利司通的最後一年。
- **2011–2013**：KERS 回歸（最低重量加 20 kg）、DRS 登場、倍耐力接手、擴散器高度 175 → 125 mm。2011 有排氣吹擴散器，2012 把排氣出口移開並限制引擎圖譜。2013 起 DRS 在所有場次都只能在區段內開（之前練習與排位可隨意開）。
- **2014–2016**：1.6 L V6 渦輪混合動力，規則轉速上限 15,000 rpm、燃油流量 100 kg/h、正賽 100 kg 油；固定齒比的 8 速；最低重量 642 → 691 kg（2015 起 702 kg）；前翼縮到 1650 mm、鼻錐降低。
- **2017–2018**：車寬 1800 → 2000 mm、輪胎加寬（245／325 → 305／405 mm）、擴散器加大，目標比 2016 快 4～5 秒；最低重量 728 kg。2018 加 Halo（733 kg），鯊魚鰭與 T 翼被禁。
- **2019–2021**：前翼加寬到 2000 mm 並簡化、尾翼加寬加高、DRS 開口加大 20 mm；743 kg（車手配重至少 80 kg）、正賽油量 110 kg。2020 義大利站起排位與正賽要用同一個引擎模式。2021 削地板、縮煞車導管翼片與擴散器導流片，規則上下壓力少約 10%，車隊冬季開發補回 4～5%，實際約少 5%；752 kg。
- **2022–2025**：地面效應底板、18 吋輪圈加輪蓋、798 kg、E10 燃料、動力單元凍結開發。2023 抬高地板邊緣與擴散器喉部。2025 為 800 kg。
- **2026**：取消 MGU-H，ERS-K 120 → 350 kW，內燃機約 400 kW；DRS 改成前後翼主動空力加超車模式；車寬 1900 mm、軸距上限 3400 mm、輪胎變窄、768 kg；設計目標是下壓力少 30%、阻力少 55%。

## 2. 各年度重量與馬力

最低重量是「車加車手、乾胎、不含油」。排位質量＝最低重量＋5 kg 油（假設）。

三個馬力欄位的意思：

- **峰值**：領先動力單元在排位設定下的總輸出（內燃機加電力）。
- **正賽估計**：一圈裡全油門那段時間「撐得住」的輸出。V8 年代的 KERS 每圈只能用 6.7 秒，所以 2011–2013 年只加每圈平均約 8 kW；2014–2025 年 MGU-K 的 120 kW 幾乎整段全油門都能用；2026 年每圈回充上限 8.5 MJ，350 kW 撐不了一整圈，所以正賽估計遠低於峰值。
- **流傳數字**：維基百科上各動力單元的馬力，大多被維基百科自己標成「來源不可靠」，也比官方說法高 10～15%。只留著對照，不拿來用。

混合動力年代以兩個官方數字定錨：2014 年是 FIA 手冊寫的「超過 760 hp」（567 kW），2022–2025 年是 Formula1.com 引述的內燃機「550–560 kW」加上 MGU-K 120 kW（675 kW）。中間年份照流傳數字逐年的起伏，線性對應到兩個錨點之間（567 + 0.6 ×（流傳數字 − 630）kW）。峰值取正賽估計的 1.037 倍，也就是 Mercedes 2025 年「700 kW 以上」和 675 kW 的比例。依據見第 8 節。

| 年 | 最低重量 kg | 峰值 kW（hp） | 正賽估計 kW | 其中內燃機 kW | 電力 kW | 流傳數字 kW（不採用） | 排位質量 kg | W/kg 峰值／正賽估計／只算內燃機 | 電力占峰值 | 座艙 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2010 | 620 | 559（750） | 559 | 559 | 0 | — | 625 | 894／894／894 | 0% | modern |
| 2011 | 640 | 619（830） | 567（估） | 559 | 60 | — | 645 | 960／879／867 | 10% | modern |
| 2012 | 640 | 619（830） | 567（估） | 559 | 60 | — | 645 | 960／879／867 | 10% | modern |
| 2013 | 642 | 619（830） | 567（估） | 559 | 60 | — | 647 | 957／876／864 | 10% | modern |
| 2014 | 691 | 588（估）（789） | 567（估） | 447（估） | 120 | 630 | 696 | 845／815／642 | 20% | modern |
| 2015 | 702 | 599（估）（803） | 578（估） | 458（估） | 120 | 649 | 707 | 847／818／648 | 20% | modern |
| 2016 | 702 | 613（估）（822） | 591（估） | 471（估） | 120 | 670 | 707 | 867／836／666 | 20% | modern |
| 2017 | 728 | 637（估）（854） | 614（估） | 494（估） | 120 | 708 | 733 | 869／838／674 | 19% | modern |
| 2018 | 733 | 663（估）（889） | 639（估） | 519（估） | 120 | 750 | 738 | 898／866／703 | 18% | halo |
| 2019 | 743 | 666（估）（893） | 642（估） | 522（估） | 120 | 755（內插） | 748 | 890／858／698 | 18% | halo |
| 2020 | 746 | 671（估）（900） | 647（估） | 527（估） | 120 | 764 | 751 | 893／862／702 | 18% | halo |
| 2021 | 752 | 681（估）（913） | 657（估） | 537（估） | 120 | 780 | 757 | 900／868／709 | 18% | halo |
| 2022 | 798 | 700（估）（939） | 675 | 555 | 120 | 800 | 803 | 872／841／691 | 17% | halo18 |
| 2023 | 798 | 700（估）（939） | 675 | 555 | 120 | 810 | 803 | 872／841／691 | 17% | halo18 |
| 2024 | 798 | 700（估）（939） | 675 | 555 | 120 | 810 | 803 | 872／841／691 | 17% | halo18 |
| 2025 | 800 | 700（939） | 675 | 555 | 120 | 810 | 805 | 870／839／689 | 17% | halo18 |
| 2026 | 768 | 750（1006） | 560（估） | 400 | 350 | — | 773 | 970／724／517 | 47% | halo18 |

相鄰年份的走向和真實賽季一致：2014 年的正賽功率重量比（815 W/kg）比 2013 年（876）低；2017 年只比 2016 年高一點（838 對 836），快的 3% 幾乎都來自空力和輪胎；2022 年（841）比 2021 年（868）低；2026 年（724）比 2025 年（839）低。

- 最低重量來源：2010、2014、2018、2019、2025、2026 直接查 FIA 技術規則條文；其餘年份用 Motorsport.com 的歷年表與維基百科賽季條目。2018 年 FIA 條文寫 733 kg，維基百科與 Motorsport.com 寫 734 kg，這裡採 FIA。
- 2026 年 FIA 條文寫的是「724 kg＋標稱輪胎質量」（排位 726 kg＋輪胎），768 kg 是 Formula1.com 公布的數字。
- 正賽起跑油量：V8 年代沒有上限，約 150～160 kg（估）；2014–2016 為 100 kg、2017–2018 為 105 kg、2019–2025 為 110 kg；2026 查不到質量數字。

## 3. 極速

蒙札測速點的最高值（km/h）。2018 年以後是 FIA 計時文件（JSON 裡每筆都附文件網址）；更早的年份來自 RaceFans、Motor Sport Magazine、F1-Fansite 與 FIA 賽前資料。排位的數字 2011 年起都開著 DRS；正賽最高值通常是 DRS 加尾流。FIA 估計 DRS 大約多 10～12 km/h。

| 期間 | 蒙札排位最高 | 蒙札正賽最高 | 慢速賽道（排位） | 代表極速（估） |
|---|---|---|---|---|
| 2010 | 345（最小下壓力）、330（加 F-duct） | 查不到 | 查不到 | 340 |
| 2011–2013 | 349.2（2011）、340（2013） | 341.1（2013） | 查不到 | 340 |
| 2014–2016 | 357.6（2016） | 362.1（2014）、358.3（2016） | 摩納哥 292.0（2014） | 358 |
| 2017–2018 | 346.4（2018；2017 下雨） | 362.5（2018） | 摩納哥 289.6（2018） | 345 |
| 2019–2021 | 349.7（2019）、354.5（2020）、344.6（2021） | 359.7（2019）、360.8（2020） | 摩納哥 291.6（2019）、287.6（2021）；匈牙利 315.6（2019） | 350 |
| 2022–2025 | 347.8（2022）、351.9（2023）、353.5（2024）、355.9（2025） | 356.4（2022）、364.1（2025） | 摩納哥 286.1（2022）、285.7（2024）、282.8（2025）；匈牙利 311.1（2022）、314.3（2025） | 352 |
| 2026 | 338.1 | 338.1（測速點）；中段計時點 343.9 | 摩納哥 285.7；匈牙利 336.6 | 340 |

- 2014 年起的渦輪混合動力車在蒙札比 V8 快約 20 km/h（FIA：2013 年最高 341.1，2014 年 362.1）。
- 紀錄：2016 年巴庫練習 378.0 km/h（非正式）、2016 年墨西哥正賽 372.54 km/h；單圈平均時速最快是 2025 年蒙札排位的 264.681 km/h。
- **2026 年的極速形狀不一樣**：車速在長直線中段就到頂，之後持平甚至往下掉（全油門下發電機在回充）。蒙札排位測速點只有 338 km/h，比 2025 年少約 18 km/h，其他計時點也慢 10～16 km/h。直線短的賽道則變快，匈牙利排位測速多了 22 km/h。電力輸出在 290 km/h 以上遞減，345 km/h 歸零（超車模式延到 355 km/h）。摩納哥沒有開放直線模式。

## 4. 抓地力與 g 值

| 期間 | 側向 g 峰值 | 煞車 g 峰值 | 下壓力 |
|---|---|---|---|
| 2010 | 5（估） | 5（估） | 查不到數字 |
| 2011–2013 | 5 | 5（估） | 查不到數字 |
| 2014–2016 | 5.2（估） | 5（估） | 查不到數字 |
| 2017–2018 | 6.5 | 5.5（估） | 查不到數字 |
| 2019–2021 | 6.5（估） | 5.5（估） | 2021 比 2020 規則上少約 10%，冬季開發後淨少約 5% |
| 2022–2025 | 6 | 5 | 約 150 km/h 時下壓力等於車重，直線尾端為車重的 3～4 倍 |
| 2026 | 5 | 3.8 | 設計目標比 2022–2025 少 30%（阻力少 55%）；維基百科寫實際約少 15% |

- 有出處的側向 g：2013 年銀石峰值 5 g、蒙札 Parabolica 3.7 g（倍耐力）；2017 年墨爾本 11 號彎 6.5 g、1 號彎超過 6 g（Formula1.com），比前幾年高 1.3 g；2022–2025 最高約 6 g（維基百科）；2026 年銀石「超過 5 g」（倍耐力）。
- 有出處的煞車：2013 年蒙札一號彎 340 → 80 km/h、150 公尺（倍耐力）；2025 年 337 → 89 km/h、約 5 g（Brembo）；2026 年 318 → 87 km/h、153 公尺、3.22 秒、峰值 3.8 g（Brembo）。2026 年的車煞車明顯變弱變長。
- 下壓力只有 Mercedes 對 2022 年車的說法可以換算：150 km/h 時等於車重，折合係數約 0.00565 m/s² per (m/s)²（推算值）。其他年代沒有可靠的公開數字，只能靠單圈時間反推。

## 5. 能量回收

- **2010**：沒有。規則第 5.2.3 條仍允許一套 KERS（60 kW、每圈 400 kJ），但車隊協議不用。
- **2011–2013 KERS**：最大功率 60 kW（約 80 hp），每圈最多釋放 400 kJ，也就是全功率 6.67 秒。車手按鈕手動使用，額度在起終點線重置，煞車時回充，進站停車時不得充電。
- **2014–2025 ERS**：MGU-K 120 kW；MGU-K 每圈最多回收 2 MJ 進電池、電池每圈最多送 4 MJ 給 MGU-K（全功率約 33 秒）；電池可用窗口 4 MJ、重 20～25 kg；MGU-H 回收與直送 MGU-K 不限量。釋放由引擎圖譜自動安排，車手另有超車鈕。
- **2026**：ERS-K 絕對上限 350 kW，扭力上限 500 Nm，電池窗口 4 MJ。每圈回充上限 8.5 MJ；煞車點少的賽道可降到 7 MJ，排位可再降到不低於 4 MJ（第 18 版規則是 5 MJ）。邁阿密站起，排位的回充上限從 8 MJ 降到 7 MJ，另有 12 條賽道可能再降（Motorsport.com）。蒙札實際是排位 5.0、正賽 7.0、超車模式 7.5 MJ。
  - 功率隨車速遞減（規則 C5.2.8，第 20 版原文已核對）：340 km/h 以下 P = 1800 − 5v（kW，v 為 km/h），所以 290 km/h 以下是 350 kW、340 km/h 剩 100 kW；340～345 km/h 改用 P = 6900 − 20v，345 km/h 歸零。
  - 超車模式（取代 DRS）：在偵測點落後前車 1 秒內，下一圈可多回充 0.5 MJ，並改用 P = 7100 − 20v，也就是 337.5 km/h 以下維持 350 kW、355 km/h 歸零。
  - Boost 鈕：車手隨時可按，維持或提高電力輸出；邁阿密站起正賽中最多加 150 kW。
  - 回充方式：煞車、部分油門、收油，以及「super clipping」（直線尾端全油門下發電）。邁阿密站起 super clipping 功率從 250 提高到 350 kW，好把時間縮到每圈 2～4 秒；同時規定主要加速區 350 kW、其他路段上限 250 kW。
  - 起跑時車速到 50 km/h 才能用 MGU-K。

## 6. 轉速、換檔、聲音

- **V8（2010–2013）**：規則上限 18,000 rpm，最大馬力就在上限附近，換檔點估約 17,800 rpm。怠速規則沒寫，二手資料約 4,000～5,000 rpm（估 4,500）。
- **V6 混合動力（2014–2025）**：規則上限 15,000 rpm，但燃油流量在 10,500 rpm 就到頂（100 kg/h），再往上轉馬力不增反減。維基百科寫正賽與排位「很少超過 12,000 rpm」，其他二手資料寫 10,500～12,000 或紅線約 13,500。這裡取換檔約 11,800 rpm（估），和遊戲基準車一致。怠速目標依規則不得超過 4,000 rpm。
- **2026**：燃料能量流量上限 3000 MJ/h，同樣在 10,500 rpm 以下遞減，換檔轉速估約 11,500 rpm。規則裡找不到曲軸轉速上限的條文。
- **檔位**：2010–2013 最多 7 個前進檔；2014 起固定 8 個，齒比整季報備。
- **換檔時間**：無縫換檔變速箱，兩個檔位重疊約 2～4 毫秒，動力幾乎不中斷；從撥片到完成約 50 毫秒。遊戲的 `shiftTime` 建議 V8 用 0.04 秒、混合動力用 0.03 秒（遊戲取值，不是實測）。
- **方向盤顯示**：2014 年起是 McLaren PCU-8D，4.3 吋彩色 LCD 上方一排 15 顆換檔燈。2010–2013 是換檔燈加小型檔位顯示（估，沒找到文件）。

## 7. 真實單圈時間錨點

來源是 F1DB v2026.15.1 的排位成績。每格是排位最快車手最後一節的成績；如果整場最快的一圈出現在別節，寫在「→」後面。標記：（雨）整節濕地、（半乾）賽道未乾或受天氣影響、＊賽道配置不同不當錨點。濕地與半乾的成績不拿來校正，`anchorMs` 為空。

| 年 | 蒙札 | 斯帕 | 鈴鹿 | 銀石 | 匈牙利 | 巴林 | 英特拉哥斯 | 摩納哥 | 蒙特婁 | 上海 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2010 | 1:21.962 | 1:45.778 | 1:30.785 | 1:29.615＊ | 1:18.773 | — | 1:14.470（半乾） | 1:13.826＊ | 1:15.105 | 1:34.558 |
| 2011 | 1:22.275 | 1:48.298（半乾） | 1:30.466 | 1:30.399 | 1:19.815 | — | 1:11.918 | 1:13.556＊ | 1:13.014 | 1:33.706 |
| 2012 | 1:24.010 | 1:47.573 | 1:30.839 | 1:51.746（雨） | 1:20.953 | 1:32.422 | 1:12.458 | 1:14.301＊ | 1:13.784 | 1:35.121 |
| 2013 | 1:23.755 | 2:01.012（雨） | 1:30.915 | 1:29.607 | 1:19.388 | 1:32.330 | 1:26.479（雨） | 1:13.876＊ | 1:25.425（雨） | 1:34.484 |
| 2014 | 1:24.109 | 2:05.591（雨） | 1:32.506 | 1:35.766（半乾） | 1:22.715（半乾） | 1:33.185 | 1:10.023 | 1:15.989＊ | 1:14.874 | 1:53.860（雨） |
| 2015 | 1:23.397 → 1:23.383 | 1:47.197 | 1:32.584 | 1:32.248 | 1:22.020 | 1:32.571 | 1:11.282 | 1:15.098 | 1:14.393 | 1:35.782 |
| 2016 | 1:21.135 | 1:46.744 | 1:30.647 | 1:29.287 → 1:29.243 | 1:19.965（半乾） | 1:29.493 | 1:10.736 | 1:13.622 | 1:12.812 | 1:35.402 |
| 2017 | 1:35.554（雨） | 1:42.553 | 1:27.319 | 1:26.600 | 1:16.276 | 1:28.769 | 1:08.322 | 1:12.178 | 1:11.459 | 1:31.678 |
| 2018 | 1:19.119 | 1:58.179（雨） → 1:41.501 | 1:27.760 | 1:25.892 | 1:35.658（雨） | 1:27.958 | 1:07.281 | 1:10.810 | 1:10.764 | 1:31.095 |
| 2019 | 1:19.307 | 1:42.519 | 1:27.064 | 1:25.093 | 1:14.572 | 1:27.866 | 1:07.508 → 1:07.503 | 1:10.166 | 1:10.240 | 1:31.547 |
| 2020 | 1:18.887 | 1:41.252 | — | 1:24.303 | 1:13.447 | 1:27.264 | — | — | — | — |
| 2021 | 1:19.555 | 1:59.765（雨） | — | 1:26.134 → 1:26.023 | 1:15.419 | 1:28.997 | 1:08.372 | 1:10.346 | — | — |
| 2022 | 1:20.161 | 1:43.665 | 1:29.304 | 1:40.983（雨） | 1:17.377 | 1:30.558 | 1:11.674（半乾） | 1:11.376 | 1:21.299（雨） | — |
| 2023 | 1:20.294 | 1:46.168（半乾） | 1:28.877 | 1:26.720 | 1:16.609 | 1:29.708 | 1:10.727（半乾） → 1:10.021 | 1:11.365 | 1:25.858（雨） | — |
| 2024 | 1:19.327 | 1:53.159（雨） | 1:28.197 | 1:25.819 | 1:15.227 | 1:29.179 → 1:29.165 | 1:23.405（雨） | 1:10.270 | 1:12.000 → 1:11.742 | 1:33.660 |
| 2025 | 1:18.792 | 1:40.562 | 1:26.983 | 1:24.892 | 1:15.372 → 1:14.890 | 1:29.841 | 1:09.511 | 1:09.954 | 1:10.899 | 1:30.641 |
| 2026 | 1:21.786 | 1:44.361 | 1:28.778 | 1:28.111 | 1:17.207 | — | — | 1:12.051 | 1:12.578 | 1:32.064 |

賽道說明：

- **蒙札（Monza）**：2010–2026 同一配置（5.793 km）；2024 年重鋪並降低路緣。
- **斯帕（Spa-Francorchamps）**：同一配置（7.004 km）；2022 年改緩衝區並重鋪。
- **鈴鹿（Suzuka）**：同一配置（5.807 km）；2020、2021 停辦。
- **銀石（Silverstone）**：Arena 配置；2010 年用舊起跑線、長度記為 5.901 km，所以從 2011 年（5.891 km）起算。2020 年取英國站，一週後的 70 週年站是 1:25.154。
- **匈牙利（Hungaroring）**：同一配置（4.381 km）；2016 年重鋪。
- **巴林（Bahrain International Circuit）**：大獎賽配置 5.412 km。2010 年跑 6.299 km 耐力配置、2011 年取消、2026 年改到雪邦舉行，這三年都沒有。
- **英特拉哥斯（Interlagos）**：同一配置（4.309 km）；2014、2024 年重鋪；2020 停辦；2026 年的比賽在 11 月 8 日，還沒跑。
- **摩納哥（Monaco）**：2015 年起 3.337 km。2010–2014 是 3.340 km，列出來只供參考。2020 停辦。
- **蒙特婁（Montreal）**：額外加的欄位：2010–2026 同一配置（4.361 km）；2020、2021 停辦。
- **上海（Shanghai）**：額外加的欄位：同一配置（5.451 km）；2020–2023 停辦；2024 年路面處理過、2025 年重鋪。

要注意的場次：

- 2011 年斯帕：Q3 才第一次上光頭胎，賽道還在變乾。
- 2011 年銀石：竿位圈是 Q3 第一輪跑的乾地圈；結束前三分鐘下雨，第二輪沒跑成，所以可能比車子的實力慢幾個十分之一秒。仍當錨點用。
- 2014 年匈牙利：Q3 一開始下雨出紅旗，重新開始後賽道在變乾。
- 2016 年匈牙利：Q1 大雨中斷四次，Q2 從半雨胎換光頭胎；Q3 行車線是乾的，但線外還有積水和濕的地方，最後幾圈又有黃旗（RaceFans）。這圈比同年其他賽道慢約 2.5%（以 2025 年為基準比），原本當乾地錨點，現改成半乾、不當錨點。
- 2018 年斯帕、2023 年英特拉哥斯：Q3 受雨影響，改用 Q2 的乾地最快圈。
- 2021 年英特拉哥斯：漢米爾頓跑出 1:07.934，但因 DRS 開口超標被取消排位成績，這裡用列入成績的最快圈 1:08.372。
- 2021 年蒙札與銀石、2022–2023 年英特拉哥斯：衝刺賽週末，排位在星期五。
- 2023 年匈牙利：試行指定輪胎（Q1 硬胎、Q2 中性胎、Q3 軟胎）。
- 2026 年各站都當乾地。蒙札、斯帕、鈴鹿、銀石、匈牙利的維基百科報導明寫乾地（匈牙利賽道溫度接近 50°C）；上海、摩納哥、蒙特婁的報導沒寫排位天氣，是從 Q1→Q3 的進步幅度、與 2025 年的差距判斷的（蒙特婁是正賽開始前才下雨）。2026 年的銀石、蒙特婁、上海都是衝刺賽週末。
- 天氣標記有三種依據：讀過場次報導、成績比前後幾年慢很多（下雨）、成績與前後幾年相符（沒有再讀報導）。寫在每格的 `condBasis`。

由錨點算出的兩種年度指數（大於 1 表示比較慢）：

- **直接比**（`anchorIndexVs2025`）：同一條賽道的乾地錨點除以 2025 年的成績，取各賽道的中位數。
- **逐年串接**（`anchorIndexChained`，這次查核新加的）：每一年只和前一年比，用兩年都有乾地錨點的賽道取中位數，再一路乘回 2025 年。

| 年 | 直接比 | 賽道數 | 逐年串接 | 與前一年共同賽道數 |
|---|---|---|---|---|
| 2010 | 1.0478 | 6 | 1.0552 | — |
| 2011 | 1.0400 | 7 | 1.0515 | 5 |
| 2012 | 1.0469 | 8 | 1.0645 | 6 |
| 2013 | 1.0504 | 6 | 1.0613 | 5 |
| 2014 | 1.0561 | 5 | 1.0712 | 3 |
| 2015 | 1.0613 | 10 | 1.0644 | 5 |
| 2016 | 1.0421 | 9 | 1.0421 | 9 |
| 2017 | 1.0114 | 9 | 1.0089 | 8 |
| 2018 | 1.0050 | 9 | 0.9994 | 8 |
| 2019 | 1.0016 | 10 | 0.9984 | 9 |
| 2020 | 0.9931 | 5 | 0.9891 | 5 |
| 2021 | 1.0063 | 6 | 1.0090 | 4 |
| 2022 | 1.0235 | 6 | 1.0252 | 4 |
| 2023 | 1.0202 | 7 | 1.0203 | 5 |
| 2024 | 1.0089 | 8 | 1.0089 | 6 |
| 2025 | 1.0000 | 10 | 1.0000 | 8 |
| 2026 | 1.0305 | 8 | 1.0305 | 8 |

直接比的指數會吃到十幾年間重鋪路面的影響，而且每年能用的賽道組合不同（2014、2020 只有 5 條），所以會排錯順序：它說 2015 年比 2014 年慢、2013 年比 2012 年慢，但只看兩年共同的賽道，中位數都是後一年較快（2013 年五條裡有四條比 2012 年快，2015 年五條裡有三條比 2014 年快）。逐年串接的版本順序正確：2014 比 2013 慢 0.9%，2015 比 2014 快 0.6%，2017 比 2016 快 3.2%，2021 比 2020 慢 2.0%，2022 比 2021 慢 1.6%，2026 比 2025 慢 3.1%。它的缺點是每一步只用 3～9 條賽道，誤差會累積，所以 2010–2014 兩者差 0.7～1.7%。`tools/seasons-raw.json` 的 `eraIndex` 也是逐年串接，但用的是另一套賽道與場次篩選。校正時建議以串接指數為主，直接比的表當對照。

## 8. 不確定與估計的部分

- **馬力**：車廠不公布逐年數字。維基百科整理的 Mercedes 各年動力單元數字（2014 年 630 kW 到 2023 年 810 kW）與 Honda／Red Bull 的 810 kW，大多被維基百科自己標成「來源不可靠」，而且和官方說法對不上：Formula1.com 引述 FIA，2026 年以前內燃機是 550–560 kW，加上 MGU-K 120 kW 約 675 kW；Mercedes 說 2025 年峰值「700 kW 以上」。810 kW 要內燃機自己出 690 kW；每小時 100 kg 燃油約是 1,200 kW 的燃料能量（以汽油熱值約 43 MJ/kg 計），等於內燃機本身熱效率約 57%，明顯偏高（這是本文自己的換算，本次沒有找到車廠公布熱效率的原文），所以不採用。現在的做法：
  - 2022–2025 年正賽估計取 675 kW（有來源）；峰值取 Mercedes 的 700 kW（2025 年有來源，2022–2024 年因規格凍結沿用，標估計）。
  - 2014 年正賽估計取 FIA 手冊的「超過 760 hp」（567 kW）。這是賽季前的保守說法，Mercedes 實際可能再高 3～5%。
  - 2015–2021 年照維基百科數字的逐年起伏，縮放到兩個錨點之間：567 + 0.6 ×（流傳數字 − 630）kW。峰值取正賽估計的 1.037 倍。都是估計。
  - V8 年代用維基百科的「平均約 750 hp」；FIA 手冊寫 2013 年是 730 hp，差 3%。
  - 2026 年峰值 750 kW 是內燃機約 400 kW 加 ERS-K 上限 350 kW，只在 290 km/h 以下、電池窗口還有電時才有。正賽估計 560 kW 是用每圈回充上限 8.5 MJ 攤在 45～55 秒全油門上（約 150～190 kW，取 160 kW）算的，還沒扣直線尾端的 super clipping。遊戲物理最好直接用 `periods[2026].ers` 的功率曲線與能量上限。
  - 絕對值可能差 ±5%，年與年之間的相對變化比較可信。
- **V6 實際換檔轉速**：沒有車廠數字，二手資料從 10,500 到 13,500 都有，取 11,800。
- **V8 怠速與換檔轉速**：沒有正式出處。
- **15,000 rpm 上限**：2014、2018、2019 年規則有明文；2025 年規則已沒有這一條（只剩檢查齒比用的 15,000 rpm），哪一年拿掉沒查出來。Mercedes 2025 年規格表仍寫最高 15,000 rpm。2026 年沒有明文上限。
- **各年代下壓力**：除了 2022 年車的一句官方說法和 2021、2026 的百分比，沒有公開數字。
- **2010–2017 的慢速賽道測速**：只找到 2014 年摩納哥一筆。2010 年蒙札正賽測速、2012 與 2015 年蒙札也沒找到。
- **2010–2013 的煞車與側向 g**：只有倍耐力 2013 年兩筆，2010 年沿用。2014–2016 的 5.2 g 是從「2017 年比以前高 1.3 g」倒推的。
- **2010–2013 方向盤顯示**、**2026 方向盤顯示**：沒找到文件。
- **2026 正賽油量（質量）**：查不到。
- **2026 年規則還在改**：邁阿密站改過一輪，規則已出到第 20 版（8 月 5 日）。維基百科寫 2027 年電力與內燃機比例打算調成 4:6。
- **2026 年蒙札排位測速**：FIA 文件是 338.1 km/h，PlanetF1 寫 341 km/h，採 FIA。2025 年同樣有 355.9（FIA）與 354.7（PlanetF1）的出入。
- **2018 年最低重量**：FIA 733 kg，其他來源 734 kg。
- 幾個場次的天氣是從檢索摘要讀到的（2014 年匈牙利、2012 年巴西），沒有打開原文逐句核對。2016 年匈牙利已在查核時讀過 RaceFans 原文（見第 7 節）。
- 標「成績與前後幾年相符（沒有再讀報導）」的乾地場次，查核時抽查了 2011 年銀石與 2016 年匈牙利兩場，前者確實是乾地（補了註記），後者其實線外還濕，已改成半乾。其餘同類場次沒有逐場讀報導，可能還藏著類似情形；它們相對 2025 年的比值，沒有一個比同年中位數慢超過 3.3%（下雨通常會慢 10% 以上）；偏慢最多的是 2016 年重鋪以前的匈牙利（2011、2012、2015 年慢 2.5～3.3%），偏快最多的是英特拉哥斯（2014 年重鋪以後）與巴林（快 2.6～4.6%），看起來是賽道本身的差異，不是天氣。

## 9. 來源

- `fia2010`：[FIA 2010 Formula One Technical Regulations (23 June 2010): art. 3.3, 4.1, 5.1.3, 5.2, 9.6.1, 12.4](https://argent.fia.com/web/fia-public.nsf/4ADA53A7369DCE8EC12576C700535E67/$FILE/1-2010%20TECHNICAL%20REGULATIONS%2023-06-2010.pdf)
- `fia2014`：[FIA 2014 Formula One Technical Regulations (23 January 2014): art. 3.3, 4.1, 5.1.2-5.1.5, 5.2, 5.6.4, 9.6, 12.4](https://www.fia.com/sites/default/files/regulation/file/1-2014%20TECHNICAL%20REGULATIONS%202014-01-23_0.pdf)
- `fiaLeaflet2014`：[FIA leaflet "2014 Formula One Power Unit Regulations" (table: 2013 V8 + KERS 730 hp + 80 hp for 7 s/lap vs 2014 power unit >760 hp; race fuel ~150 vs 100 kg; weights 642 / 691 kg)](https://www.fia.com/sites/default/files/publication/file/FIA%20F1%20Power%20Unit%20leaflet.pdf)
- `fia2018`：[FIA 2018 Formula One Technical Regulations (19 December 2017): art. 3.2.2, 4.1, 5.1.3, 5.1.4, 5.6.4, 9.6.1, 12.4, 15.2](https://api.fia.com/sites/default/files/1-2018_technical_regulations_2017-12-19_0.pdf)
- `fia2019`：[FIA 2019 Formula One Technical Regulations (5 December 2018): art. 3.2.2, 4.1, 4.6, 5.1.3, 5.1.4, 9.6.1, 12.4](https://www.fia.com/sites/default/files/2019_technical_regulations_-_2018-12-05.pdf)
- `fia2025`：[FIA 2025 Formula 1 Technical Regulations, Issue 3 (7 April 2025): art. 3.4.2, 4.1, 5.2, 5.4, 5.7.4, 9.7.1, 10.8.1, 16](https://www.fia.com/sites/default/files/documents/fia_2025_formula_1_technical_regulations_-_issue_03_-_2025-04-07.pdf)
- `fia2026`：[FIA 2026 F1 Regulations, Section C (Technical), Issue 20 (5 August 2026): C2, C3.10/C3.11, C4.1, C5.1, C5.2, C5.4, C5.13.4, C9.6, C9.8, definitions](https://api.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_c_technical_-_iss_20_-_2026-08-05.pdf)
- `fia2026i18`：[FIA 2026 F1 Regulations, Section C (Technical), Issue 18 (7 May 2026): same figures, qualifying recharge floor 5 MJ](https://api.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_c_technical_-_iss_18_-_2026-05-07.pdf)
- `fiaPreview2015ita`：[FIA race preview, 2015 Italian Grand Prix ("Fast facts": 362.1 km/h in 2014, 341.1 km/h in the last V8 year)](https://www.fia.com/file/32847/download?token=UyqSUcd_)
- `fiaTrap2014itaR`：[FIA timing document, 2014 Italian GP race speed trap](https://www.fia.com/sites/default/files/championship/event_report/documents/speedtrap.pdf)
- `fiaSpeed`：[FIA timing documents "Qualifying Session Maximum Speeds" / "Race Maximum Speeds" (one PDF per event; each figure carries the full url of its document)](https://www.fia.com/sites/default/files/2026_13_ita_f1_q0_timing_qualifyingsessionmaximumspeeds_v01.pdf)
- `f1db`：[F1DB v2026.15.1 (CC BY 4.0), qualifying results and circuit layouts — local cache tools/seasons-cache](https://github.com/f1db/f1db/releases/tag/v2026.15.1)
- `wEngines`：[Wikipedia: Formula One engines](https://en.wikipedia.org/wiki/Formula_One_engines)
- `wMercPU`：[Wikipedia: Mercedes V6 hybrid Formula One power unit (power by version; most figures tagged "unreliable source" there)](https://en.wikipedia.org/wiki/Mercedes_V6_hybrid_Formula_One_power_unit)
- `wHondaPU`：[Wikipedia: Honda V6 hybrid Formula One power unit (power by version)](https://en.wikipedia.org/wiki/Honda_V6_hybrid_Formula_One_power_unit)
- `wCar`：[Wikipedia: Formula One car](https://en.wikipedia.org/wiki/Formula_One_car)
- `wTyres`：[Wikipedia: Formula One tyres](https://en.wikipedia.org/wiki/Formula_One_tyres)
- `wKers`：[Wikipedia: Kinetic energy recovery system](https://en.wikipedia.org/wiki/Kinetic_energy_recovery_system)
- `wDrs`：[Wikipedia: Drag reduction system](https://en.wikipedia.org/wiki/Drag_reduction_system)
- `wHistReg`：[Wikipedia: History of Formula One regulations](https://en.wikipedia.org/wiki/History_of_Formula_One_regulations)
- `w2010`：[Wikipedia: 2010 Formula One World Championship](https://en.wikipedia.org/wiki/2010_Formula_One_World_Championship)
- `w2011`：[Wikipedia: 2011 Formula One World Championship](https://en.wikipedia.org/wiki/2011_Formula_One_World_Championship)
- `w2012`：[Wikipedia: 2012 Formula One World Championship](https://en.wikipedia.org/wiki/2012_Formula_One_World_Championship)
- `w2013`：[Wikipedia: 2013 Formula One World Championship](https://en.wikipedia.org/wiki/2013_Formula_One_World_Championship)
- `w2014`：[Wikipedia: 2014 Formula One World Championship](https://en.wikipedia.org/wiki/2014_Formula_One_World_Championship)
- `w2017`：[Wikipedia: 2017 Formula One World Championship](https://en.wikipedia.org/wiki/2017_Formula_One_World_Championship)
- `w2018`：[Wikipedia: 2018 Formula One World Championship](https://en.wikipedia.org/wiki/2018_Formula_One_World_Championship)
- `w2019`：[Wikipedia: 2019 Formula One World Championship](https://en.wikipedia.org/wiki/2019_Formula_One_World_Championship)
- `w2021`：[Wikipedia: 2021 Formula One World Championship](https://en.wikipedia.org/wiki/2021_Formula_One_World_Championship)
- `w2022`：[Wikipedia: 2022 Formula One World Championship](https://en.wikipedia.org/wiki/2022_Formula_One_World_Championship)
- `w2023`：[Wikipedia: 2023 Formula One World Championship](https://en.wikipedia.org/wiki/2023_Formula_One_World_Championship)
- `w2025`：[Wikipedia: 2025 Formula One World Championship](https://en.wikipedia.org/wiki/2025_Formula_One_World_Championship)
- `w2026`：[Wikipedia: 2026 Formula One World Championship](https://en.wikipedia.org/wiki/2026_Formula_One_World_Championship)
- `msWeights`：[Motorsport.com: How much does an F1 car weigh (table "F1 weight through the years", 2008-2023)](https://www.motorsport.com/f1/news/how-much-does-an-f1-car-weigh-in-2023/10437685/)
- `msMiami2026`：[Motorsport.com: FIA confirms 2026 F1 rule changes ahead of Miami Grand Prix](https://www.motorsport.com/f1/news/fia-confirms-2026-f1-rule-changes-ahead-of-miami-grand-prix/10814169/)
- `msWheel`：[Motorsport.com: Technical analysis: McLaren's F1 steering wheel (PCU-8D LCD introduced for 2014)](https://www.motorsport.com/f1/news/technical-analysis-mclaren-s-f1-steering-wheel-686738/686738/)
- `somers2014`：[SomersF1: McLaren Electronic Systems new driver display - PCU-8D (2014; read through the search excerpt, the page itself could not be fetched)](http://www.somersf1.co.uk/2014/02/mclaren-electronic-systems-new-driver.html)
- `mclPcu8d`：[McLaren Applied: PCU-8D display unit data sheet (4.3 inch LCD, 480x272, LED lamps)](https://cdn.mclarenapplied.com/media/Catalogue/PCU-8D.pdf)
- `f1Pu2026`：[Formula1.com: 2026 regulations explained - power units](https://www.formula1.com/en/latest/article/2026-regulations-explained-all-you-need-to-know-about-f1s-new-power-units.14jfv7a36905uDJDdNyfQd)
- `f1Aero2026`：[Formula1.com: 2026 regulations explained - aerodynamics](https://www.formula1.com/en/latest/article/2026-regulations-explained-all-you-need-to-know-about-f1s-new-aerodynamics.7IAt0auc32UkCEFE5ypkTB)
- `f1Guide2026`：[Formula1.com: The beginner's guide to the 2026 Formula 1 regulations](https://www.formula1.com/en/latest/article/the-beginners-guide-to-the-2026-regulations.6j0tS0hrHG2T01tpmK6XYz)
- `f1Fia2026`：[Formula1.com: FIA unveils Formula 1 regulations for 2026 and beyond (June 2024): "power from the hybrid unit has dropped from 550-560kw to 400kw", 350 kW battery power, 768 kg, 8.5 MJ](https://www.formula1.com/en/latest/article/fia-unveils-formula-1-regulations-for-2026-and-beyond-featuring-more-agile.75qJiYOHXgeJqsVQtDr2UB)
- `f1G2017`：[Formula1.com: Analysing 2017's massive rises in G-force (Melbourne)](https://www.formula1.com/en/latest/article/video-analysing-2017s-massive-rises-in-g-force.vX8IhGjqmsaCoyy2uKKOi)
- `f1Tyres2026gbr`：[Formula1.com: What tyres will the teams and drivers have for the 2026 British Grand Prix](https://www.formula1.com/en/latest/article/what-tyres-will-the-teams-and-drivers-have-for-the-2026-british-grand-prix.3qD9d5o8X4x3se0F7Zg5i1)
- `f1Monza2026q`：[Formula1.com: 2026 Italian GP qualifying report](https://www.formula1.com/en/latest/article/gasly-charges-to-sensational-maiden-f1-pole-at-monza-over-russell-and-piastri.4CKkkbvgmqL04ijMNBfuXF)
- `drive2017`：[The Drive: 2017's Formula One cars are pulling 1.3 g more than before](https://www.thedrive.com/accelerator/8734/2017s-formula-one-cars-are-pulling-1-3gs-more-than-before)
- `espn2017`：[ESPN: 2017 cars take F1 drivers close to blackout point - Pirelli](https://africa.espn.com/f1/story/_/id/18811957/2017-cars-take-f1-drivers-close-blackout-point-pirelli)
- `hondaReg2026`：[Honda: 2026 Formula 1 regulations overview](https://global.honda/en/F1/features/2026_Commentary/regulations/)
- `raceteq2026`：[Raceteq: F1 2026 explained - active aero, boost, recharge and overtake mode](https://www.raceteq.com/articles/2026/01/f1-2026-explained-active-aero-boost-recharge-and-overtake-mode)
- `raceteqGearbox`：[Raceteq: The decades-long evolution of the F1 gearbox](https://www.raceteq.com/articles/2026/01/evolution-of-the-f1-gearbox-1950-to-2025)
- `chronRpm`：[F1 Chronicle: What RPM do F1 drivers shift at?](https://f1chronicle.com/what-rpm-do-f1-drivers-shift-at/)
- `mercW16`：[Mercedes-AMG F1: W16 (2025) technical specifications](https://www.mercedesamgf1.com/f1-w16-2025-technical-specifications)
- `mercPu2026`：[Mercedes-AMG F1: Facts and stats - power unit regulation changes (2025 vs 2026: "700+ kilowatts" peak both years, 80:20 vs 50:50 split, 100 vs 75 kg/h, 2 vs 9 MJ per lap)](https://www.mercedesamgf1.com/facts-and-stats-power-unit-regulation-changes)
- `mercDownforce`：[Mercedes-AMG F1: Downforce in Formula One, explained](https://www.mercedesamgf1.com/news/feature-downforce-in-formula-one-explained)
- `rfRenault2014`：[RaceFans: Renault reveals 2014 F1 engine (V8 vs V6 comparison table)](https://www.racefans.net/2013/06/21/renault-reveals-2014-f1-engine/)
- `rfMonza2010`：[RaceFans: Technical review - 2010 Italian Grand Prix (speed trap, F-duct)](https://www.racefans.net/2010/09/20/technical-review-italian-grand-prix/)
- `rfMonza2011`：[RaceFans: 2011 Italian Grand Prix pre-race analysis (qualifying speed trap)](https://www.racefans.net/2011/09/10/2011-italian-grand-prix-prerace-analysis/)
- `rfMonza2016`：[RaceFans: 2016 Italian Grand Prix lap times and fastest laps](https://www.racefans.net/2016/09/04/2016-italian-grand-prix-lap-times-and-fastest-laps/)
- `msmMonza2016`：[Motor Sport Magazine: 2016 Italian Grand Prix report](https://www.motorsportmagazine.com/articles/single-seaters/f1/2016-italian-grand-prix/)
- `msmFast`：[Motor Sport Magazine: How fast is the current generation of F1 cars? (16 Oct 2025)](https://www.motorsportmagazine.com/articles/single-seaters/f1/how-fast-is-the-current-generation-of-f1-cars/)
- `fansiteMonza2013q`：[F1-Fansite: qualifying results 2013 Italian GP ("Highest speed")](https://www.f1-fansite.com/f1-result/f1-qualifying-results-2013-italian-grand-prix/)
- `fansiteMonaco2014q`：[F1-Fansite: qualifying results 2014 Monaco GP ("Highest speed")](https://www.f1-fansite.com/f1-result/qualifying-results-2014-monaco-f1-grand-prix/)
- `pirMonza2013`：[Pirelli: Italian Grand Prix preview, Monza 2013](https://press.pirelli.com/italian-grand-prix-preview-monza-6-8-september-2013/)
- `pirSilv2013`：[Pirelli: British Grand Prix preview, Silverstone 2013](https://press.pirelli.com/british-grand-prix-preview-silverstone-28-30-june-2013/)
- `pirMonza2025`：[Pirelli: Italian Grand Prix preview, Monza 2025 (with Brembo braking data)](https://press.pirelli.com/art-history-and-speed-monza-gets-ever-more-special/)
- `sfMonza2026`：[Scuderia Fans: Italian GP 2026 - Monza braking changes and F1 energy limits explained (Brembo data)](https://scuderiafans.com/italian-gp-2026-monza-braking-changes-and-f1-energy-limits-explained/)
- `pf1Monza2026`：[PlanetF1: Monza's top speeds have fallen dramatically under F1's 2026 rules](https://www.planetf1.com/f1-data/2026-f1-rules-monza-temple-of-speed)
- `raceAus2026`：[The Race: Australia's a damning indictment of F1 2026's worst trait](https://www.the-race.com/formula-1/australias-a-damning-indictment-of-f1-2026s-worst-trait/)
- `gpfAus2026`：[GPFans: F1's new cars in 2026 are how much slower? (Melbourne pole 2025 vs 2026)](https://www.gpfans.com/en/f1-news/1078064/f1-cars-2026-how-much-slower-australian-grand-prix/)
- `w2017ita`：[Wikipedia: 2017 Italian Grand Prix](https://en.wikipedia.org/wiki/2017_Italian_Grand_Prix)
- `w2010bel`：[Wikipedia: 2010 Belgian Grand Prix](https://en.wikipedia.org/wiki/2010_Belgian_Grand_Prix)
- `w2011bel`：[Wikipedia: 2011 Belgian Grand Prix](https://en.wikipedia.org/wiki/2011_Belgian_Grand_Prix)
- `w2023bel`：[Wikipedia: 2023 Belgian Grand Prix](https://en.wikipedia.org/wiki/2023_Belgian_Grand_Prix)
- `w2010bra`：[Wikipedia: 2010 Brazilian Grand Prix](https://en.wikipedia.org/wiki/2010_Brazilian_Grand_Prix)
- `w2012bra`：[Wikipedia: 2012 Brazilian Grand Prix](https://en.wikipedia.org/wiki/2012_Brazilian_Grand_Prix)
- `w2014gbr`：[Wikipedia: 2014 British Grand Prix](https://en.wikipedia.org/wiki/2014_British_Grand_Prix)
- `w2014hun`：[F1 Wiki (Fandom): 2014 Hungarian Grand Prix (qualifying narrative)](https://f1.fandom.com/wiki/2014_Hungarian_Grand_Prix)
- `rf2016hun`：[RaceFans: Rosberg on pole after frantic Hungarian GP qualifying (2016)](https://www.racefans.net/2016/07/23/rosberg-pole-frantic-hungarian-gp-qualifying/)
- `w2018jpn`：[Wikipedia: 2018 Japanese Grand Prix](https://en.wikipedia.org/wiki/2018_Japanese_Grand_Prix)
- `w2021sap`：[Wikipedia: 2021 Sao Paulo Grand Prix](https://en.wikipedia.org/wiki/2021_S%C3%A3o_Paulo_Grand_Prix)
- `w2022sap`：[Wikipedia: 2022 Sao Paulo Grand Prix](https://en.wikipedia.org/wiki/2022_S%C3%A3o_Paulo_Grand_Prix)
- `w2023sap`：[Wikipedia: 2023 Sao Paulo Grand Prix](https://en.wikipedia.org/wiki/2023_S%C3%A3o_Paulo_Grand_Prix)
- `w2026jpn`：[Wikipedia: 2026 Japanese Grand Prix](https://en.wikipedia.org/wiki/2026_Japanese_Grand_Prix)
- `w2026gbr`：[Wikipedia: 2026 British Grand Prix](https://en.wikipedia.org/wiki/2026_British_Grand_Prix)
- `w2026bel`：[Wikipedia: 2026 Belgian Grand Prix](https://en.wikipedia.org/wiki/2026_Belgian_Grand_Prix)
- `w2026hun`：[Wikipedia: 2026 Hungarian Grand Prix](https://en.wikipedia.org/wiki/2026_Hungarian_Grand_Prix)
- `w2026mon`：[Wikipedia: 2026 Monaco Grand Prix](https://en.wikipedia.org/wiki/2026_Monaco_Grand_Prix)
- `w2026can`：[Wikipedia: 2026 Canadian Grand Prix](https://en.wikipedia.org/wiki/2026_Canadian_Grand_Prix)
- `w2026chn`：[Wikipedia: 2026 Chinese Grand Prix](https://en.wikipedia.org/wiki/2026_Chinese_Grand_Prix)
- `w2026aus`：[Wikipedia: 2026 Australian Grand Prix](https://en.wikipedia.org/wiki/2026_Australian_Grand_Prix)
- `w2011gbr`：[Wikipedia: 2011 British Grand Prix (qualifying: rain three minutes from the end of Q3)](https://en.wikipedia.org/wiki/2011_British_Grand_Prix)

## 10. 查核紀錄（2026-10-01）

獨立查核，逐段對照網路原文（FIA 規則 PDF 直接抽文字核對、FIA 計時文件、維基百科賽季與分站條目、Formula1.com、Mercedes、Motorsport.com、RaceFans、Motor Sport、倍耐力）。

### 改掉的地方

| 期間 | 欄位 | 原本 → 改成 | 依據 |
|---|---|---|---|
| 2014–2025 | `seasons[年].powerPeak` | 2014 630 → 588（估）、2015 649 → 599、2016 670 → 613、2017 708 → 637、2018 750 → 663、2019 755 → 666、2020 764 → 671、2021 780 → 681、2022–2024 800／810 → 700（估）、2025 810 → 700 kW | `fiaLeaflet2014`、`f1Fia2026`、`mercPu2026`；原數字大多被 `wMercPU` 標成來源不可靠，改放到 `powerReported` |
| 2014–2025 | `seasons[年].powerRaceTrim` | 2014 599 → 567、2015 617 → 578、2016 637 → 591、2017 673 → 614、2018 713 → 639、2019 717 → 642、2020 726 → 647、2021 741 → 657、2022 760 → 675、2023–2025 770 → 675 kW | 同上；2022–2025 改成有來源（內燃機 550–560 kW＋MGU-K 120 kW） |
| 2011–2013 | `seasons[年].powerRaceTrim` | 619 → 567 kW（估） | KERS 每圈只能用 6.7 秒（`fia2010` 第 5.2.3 條：60 kW、每圈 400 kJ），不算持續功率 |
| 2026 | `seasons[2026].powerRaceTrim` | 750（原標有來源）→ 560 kW（估） | 350 kW 只在 290 km/h 以下、每圈回充上限 8.5 MJ（`fia2026` C5.2.8、C5.2.10，原文已核對） |
| 全部 | `conventions.power`、新欄位 `powerCombustionRaceTrim`、`powerReported` | 定義改成「全油門時撐得住的功率」，電力占比改用峰值算 | 見第 2 節 |
| 全部 | `powerToWeight` 各項 | 依上面重算；例：2025 正賽 957 → 839 W/kg、2026 970 → 724 W/kg | 推算值 |
| 2022–2025 | `periods.engine.powerCombustion` | 無 → 555 kW | `f1Fia2026`：「550-560kw」 |
| 2017–2018 | `grip.carWidth` 條號 | art. 3.3 → art. 3.2.2 | `fia2018` 原文 |
| 2019–2021 | `grip.carWidth` 條號 | art. 3.3 → art. 3.2.2（不含輪胎） | `fia2019` 原文 |
| 2019–2021 | `grip.downforce` | 「2021 約少 10%」→「規則上少約 10%，冬季開發後淨少約 5%」 | `w2021` |
| 2026 | `ers.harvestPerLap` 註記 | 補上邁阿密站起排位回充 8 → 7 MJ | `msMiami2026` |
| 2016 | 匈牙利錨點 | 乾地、1:19.965 當錨點 → 半乾、不當錨點 | `rf2016hun`：Q3 線外還有積水 |
| 2016 | `anchorIndexVs2025` | 1.0467（10 條）→ 1.0421（9 條） | 推算值 |
| 2011 | 銀石錨點 | 補註記：Q3 第二輪因雨沒跑；天氣依據改成讀過報導 | `w2011gbr`（新增來源） |
| 2026 | 摩納哥、蒙特婁錨點的天氣依據 | 「讀過報導」→「由成績判斷，報導沒寫排位天氣」 | `w2026mon`、`w2026can` 重讀 |
| 全部 | `lapTimeAnchors.anchorIndexChained`、`seasons[年].anchorIndexChained` | 新增逐年串接指數 | 推算值；直接比的指數會把 2015 排在 2014 後面 |

### 核對過、沒有改的

- **年代分段**：2010、2011–2013、2014–2016、2017–2018、2019–2021、2022–2025、2026，17 年每年只落在一段。
- **最低重量**：620、640、640、642、691、702、702、728、733（FIA 2018 原文；其他來源 734）、743、746、752、798、798、798、800、768 kg（FIA 2026 原文是 724 kg＋標稱輪胎質量），2010–2022 年與 Motorsport.com 歷年表一致，2010、2014、2018、2019、2025、2026 年另與 FIA 規則原文逐條核對過；2023、2024 年的 798 kg 沿用維基百科賽季條目，這次沒有重讀。
- **轉速與檔位**：2010 年規則 18,000 rpm、最多 7 檔；2014、2018、2019 年規則 15,000 rpm、固定 8 檔；2025 年規則確實沒有曲軸轉速上限條文；2026 年規則同樣沒有（只剩換檔檢查用的 15,000 rpm），8 檔、怠速目標 4,000 rpm。
- **KERS／ERS**：2010 年規則 KERS 60 kW、每圈 400 kJ；2014–2025 年 MGU-K 120 kW、每圈回收 2 MJ／釋放 4 MJ、電池窗口 4 MJ（Mercedes W16 規格表）；2026 年 350 kW、功率對車速的三段公式、8.5／7／4 MJ、+0.5 MJ、500 Nm、50 km/h 起步條件（第 20 版原文）。
- **Halo／DRS／輪圈**：Halo 2018 起、DRS 2011–2025、13 吋到 2021、18 吋 2022 起、2011 年擴散器 175 → 125 mm、2017 年 125 → 175 mm、2019 年前翼與尾翼尺寸、2022 年跟車下壓力 86%（2019 年車 55%）。
- **極速**：2010、2011 年 RaceFans 數字；2013 年 341.1、2014 年 362.1 km/h（FIA 文件）；2016 年排位 357.6（Motor Sport）；2020 年排位 354.5、2019 年匈牙利 315.6、2025 年排位 355.9／正賽 364.1、2026 年蒙札 338.1 與其他計時點、2026 年匈牙利 336.6 km/h（FIA 計時文件原文）；紀錄 378.03 km/h（巴庫 2016 練習，非正式）、264.681 km/h（2025 蒙札排位）。
- **抓地與煞車**：倍耐力 2013 年銀石 5 g、The Drive 2017 年 6.5 g（高 1.3 g）、倍耐力 2025 年蒙札約 5 g、倍耐力 2026 年銀石「超過 5g」、Brembo 2026 年蒙札 318 → 87 km/h、153 m、3.22 秒、3.8 g。
- **竿位錨點**：全部 17 年 × 10 條賽道對 F1DB v2026.15.1 本地快取重算，時間、車手、整場最快圈全部相符。F1DB 的賽道配置代號確認蒙札、斯帕、鈴鹿、匈牙利、蒙特婁、上海 2010–2026 都同一個；銀石 2010 年與之後同一代號、只差 10 m 登錄長度（維基百科沒寫實體改動，照原本不當錨點）；摩納哥 2015 年 Tabac 彎重新規劃，短 3 m（維基百科）。2026 年八個錨點逐一對照維基百科分站條目，時間與竿位車手相符（蒙札是加斯利生涯第一個竿位）。巴林站 2026 年移到雪邦（維基百科），英特拉哥斯 11 月 8 日還沒跑。

### 還沒解決

- 混合動力年代的馬力沒有逐年官方數字，2015–2021 年仍是內插估計；2014 年用的是 FIA 賽季前的下限，可能偏低 3～5%。
- 2018 年最低重量 733 kg（FIA 2017 年 12 月版原文）和 734 kg（其他來源）的出入沒解決，可能是後來的修訂版改過。
- 本次查核的網路搜尋額度用完了，只能直接開已知網址；熱效率、V6 實際換檔轉速這類要靠搜尋才找得到的資料沒有再補。
