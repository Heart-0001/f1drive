# 每台車的電池資料（KERS／ERS，2011–2026）

資料檔：`tools/ers-data.json`，涵蓋 `tools/seasons-raw.json` 裡 2011–2026 的 168 個車款 id，每個 id 一筆。
之後由賽季產生器讀取。2010 年不在範圍內，車隊協議全年不裝 KERS，每台車都沒有電池。

**所有倍率都是遊戲用的估計值，不是量測值。** 做法是把公開資料裡**針對電能系統**的描述換算成分數，每筆都附來源網址與英文理由（`reason`）。

## 欄位

| 欄位 | 意思 |
| --- | --- |
| `hasErs` | `false`＝那一季整季沒裝 KERS，倍率一律 1（不使用） |
| `deploy` | 乘在該季標準車的 `ers.power`（按電池鍵多出的動力） |
| `harvest` | 乘在 `ers.harvest`（回充速度） |
| `store` | 乘在 `ers.store`；全部是 1，理由見下 |
| `note` | 選單用的一行中文，同一個供應商、同一季的車都一樣；找不到電能相關資料時留空 |
| `confidence` | high／medium／low |
| `sources` | 來源網址 |
| `group` | 供應商＋賽季的分組代號（產生時用） |

這些倍率**取代** `perf.ersPower`／`perf.ersHarvest`（原本 0.95–1.05、幾乎都是 1），不是再乘上去。

## 量尺

倍率 ＝ 1 ＋ 0.04 × 分數。範圍：deploy、harvest 在 0.75–1.15，store 在 0.9–1.1。

| 分數 | 什麼情況 |
| ---: | --- |
| 0 | 找不到電能相關資料（no data），或資料顯示中性 |
| ±1 | 有記載的小優勢／小落後，或沿用相鄰賽季的供應商特性（low） |
| ±2 | 明確記載的優勢／落後 |
| ±3 | 壓倒性優勢，或整季 ERS 停用、故障的嚴重問題 |
| −4～−6 | 只用在記載最極端的回收不足：2015 年 Honda 跑到半圈就少了 120 kW |

- **deploy 的意思**：規則把電動功率鎖死了（KERS 60 kW、MGU-K 120 kW、2026 年 350 kW），所以 deploy 代表「這台車一整季在直線上實際拿得到多少」。降功率使用、ERS 停用、提早斷電（clipping）、故障，都算在裡面，不是硬體規格不同。
- **store 全部是 1**：電池可用量由規則固定（KERS 每圈 400 kJ；2014–2026 年電池窗口 4 MJ），也找不到例外的記載。
- **客戶車隊**比照供應商的數字，因為規則要求供應商給所有車隊同一規格的動力單元。只有找得到車隊層級的事實才另外處理：用舊年份規格的引擎、2021 年 Ferrari 新電池只記載裝在廠隊車上、2026 年 Mercedes 廠隊與客戶隊的電能運用差距。
- **單場故障不改變整季數字**，例如 2013 年澳洲站 Webber 的 KERS、2018 年摩納哥站 Ricciardo 的 MGU-K。

## 沒有 KERS 的車（`hasErs: false`）

| 年 | 車 | 依據 |
| --- | --- | --- |
| 2011 | Team Lotus T128、Virgin MVR-02、HRT F111 | 2011 開季有三隊選擇不裝（Team Lotus、Virgin、HRT）；T128 整季都沒裝；MVR-02 設計師認為效益不值得開發費用 |
| 2012 | HRT F112、Marussia MR01 | F112 與 MR01 是當年唯二沒裝 KERS 的車 |
| 2013 | 無 | Marussia MR02 首度裝 KERS（Williams 設計），Caterham 用 Red Bull Technologies 的系統（2012 年起） |

## 各年差異（d＝deploy，h＝harvest；沒列出的車＝1.0）

| 年 | 不同的車 |
| --- | --- |
| 2011 | Red Bull d0.92／h0.92（首站根本沒裝 KERS，第二站才上陣又出故障）；三台沒有 KERS |
| 2012 | 兩台沒有 KERS，其餘 1.0（各家 KERS 的效率差異沒有公開資料） |
| 2013 | 全部 1.0 |
| 2014 | Mercedes 動力（Mercedes、Williams、McLaren、Force India）d1.08／h1.12；Renault 動力（Red Bull、Toro Rosso、Lotus、Caterham）d0.88／h0.92；Ferrari 動力 1.0 |
| 2015 | Mercedes 動力 d1.08／h1.12；Renault 動力 d0.88／h0.92；**McLaren-Honda d0.84／h0.76**；Marussia（用 2014 年的 059/3）d0.96／h0.96 |
| 2016 | Mercedes 動力（含 Manor）d1.08／h1.12；Renault／TAG Heuer d0.96／h0.96；McLaren-Honda d0.92／h0.88；Toro Rosso（2015 年規格 Ferrari）d0.96／h0.96 |
| 2017 | Mercedes 動力 d1.04／h1.08；Renault 動力 d0.96／h0.96；McLaren-Honda d0.88／h0.84；Sauber（2016 年規格 Ferrari）d0.96／h0.96 |
| 2018 | Mercedes 動力 d1.04／h1.08；Renault 動力（含 McLaren）d0.96／h0.96；Toro Rosso-Honda d0.96／h0.96 |
| 2019 | Mercedes 動力（含 Racing Point）d1.04／h1.08；Honda（Red Bull、Toro Rosso）d1.04／h1.04；Renault 動力 d0.96／h0.96；Ferrari 動力 1.0 |
| 2020 | Mercedes 動力 d1.04／h1.08；Honda d1.04／h1.08；Renault 動力 d0.96／h0.96；Ferrari 動力（Ferrari、Alfa Romeo、Haas）d0.92／h0.96 |
| 2021 | **Honda（Red Bull、AlphaTauri）d1.12／h1.12**；Mercedes 動力 d1.04／h1.08；Ferrari 廠隊 d0.96／h1.0；Alfa Romeo、Haas d0.92／h0.96；Alpine d0.96／h0.96 |
| 2022–2025 | 凍結期，差異小：Honda／RBPT d1.04／h1.04；Mercedes 動力 d1.0／h1.04；Ferrari 動力 1.0；Alpine（Renault）d0.96／h0.96 |
| 2026 | Mercedes d1.04／h1.08；McLaren d0.98／h1.04；Alpine d1.01／h1.04；Williams d1.02／h1.04；Ferrari d0.98／h0.96；Haas d1.0／h0.96；Cadillac d0.98／h0.96；Red Bull、Racing Bulls d1.02／h1.0；Audi d1.0／h0.92；**Aston Martin d0.88／h0.88** |

## 依據摘要

- **2014–2016 Mercedes**：分離式渦輪讓 Mercedes 在「封裝、空力效率與電池使用」上占優；Horner：「Mercedes 引擎的車按下超車鈕會變快，我們的 Renault 按下去車會停。」2015 年仍是最強的動力單元。
- **2014–2015 Renault**：渦輪與 ERS 軟體問題，測試時聽從 Renault 建議停用 ERS（最多少 150 匹）；2015 年「退步了」，動力、可靠度、驅動性都有大問題。2016–2025 年依「對其他動力單元持續落後」給 −1（low）。
- **2015 Honda**：渦輪太小，「回充能力差」；MGU-H 用電比回收快，跑到半圈就少了 120 kW；在 Spa 的 Kemmel 直線頂端還在回充，別人已經在放電。
- **2016–2018 Honda**：2016 年 MGU-K 新磁鐵改善回充，但仍「還要追很多」；2017 年渦輪／MGU-H 軸一再斷裂，降低出力保可靠度；2018 年 MGU-H 重新設計，第三版換新 MGU-K 與電池，年底超越 Renault。
- **2019–2021 Honda**：2019 年輸出「與 Mercedes 相當」；2020 年新增「Extra Harvest」模式，可在短時間大量回充；2021 年「電能回收與部署常優於 Mercedes」，第 12 站起換上碳奈米管電池（輸出密度 1.3 倍）。
- **Ferrari 2020–2021**：一直用 400 V 電池，2021 年俄羅斯站（Sainz 從土耳其站）才換成 800 V，「與對手看齊」，之後「直線從頭到尾都有電」，Ferrari 自己說「跟去年比是一大步」。2019 年的直線優勢與燃油流量爭議有關，算內燃機，不算電能。
- **舊年份規格的引擎**：Marussia 2015（059/3）、Toro Rosso 2016（2015 年規格 060，沒有原廠支援）、Sauber 2017（2016 年的 061）各給 −1（low）。
- **2022–2025**：動力單元凍結，只能做可靠度改良；Honda 的 2021 年電池延續下來（+1，low）；Ferrari 已改 800 V（1.0）。
- **2026**：沿用 `js/cars-data.js` 已查證的分數（依據見 `docs/cars-data-sources.md` 步驟 4），偏離 1 的量乘 4，與本檔每級 4 % 一致。The Race 9 月的 Monza 電能部署分析與排序一致：Mercedes 在三條長直線領先；McLaren 自承「電能方面還有功課」；Honda「直線速度不夠」。
- **2017–2021 Mercedes、2022–2025 Mercedes**：沒有新的電能專屬資料，沿用 2014–2016 的供應商特性，但對手已追上，所以縮小（low）。

## 信心與限制

- high：多個一致的電能專屬來源（沒有 KERS 的車、2014 Mercedes、2015 Honda、2026 Honda）。
- medium：一個明確的電能專屬來源，或記載完整的供應商特性。
- low：找不到電能專屬資料（1.0），或沿用、推論而來。
- 本次網路搜尋額度用完，2011–2013 年各家 KERS 的效率差異，以及 2014–2019 年 Ferrari 的電能表現，都沒有找到電能專屬資料，所以維持 1.0。之後若找到來源，改 `group` 對應的分數即可。

## 來源

- KERS 與規則：[Kinetic energy recovery system](https://en.wikipedia.org/wiki/Kinetic_energy_recovery_system)、[2011 Formula One World Championship](https://en.wikipedia.org/wiki/2011_Formula_One_World_Championship)
- 沒有 KERS 的車：[Lotus T128](https://en.wikipedia.org/wiki/Lotus_T128_(Formula_One_car))、[Virgin MVR-02](https://en.wikipedia.org/wiki/Virgin_MVR-02)、[HRT F112](https://en.wikipedia.org/wiki/HRT_F112)、[Marussia MR01](https://en.wikipedia.org/wiki/Marussia_MR01)、[Marussia MR02](https://en.wikipedia.org/wiki/Marussia_MR02)、[Caterham CT01](https://en.wikipedia.org/wiki/Caterham_CT01)、[Caterham CT03](https://en.wikipedia.org/wiki/Caterham_CT03)
- Red Bull KERS：[2011 Australian GP](https://en.wikipedia.org/wiki/2011_Australian_Grand_Prix)、[2011 Malaysian GP](https://en.wikipedia.org/wiki/2011_Malaysian_Grand_Prix)、[Red Bull RB9](https://en.wikipedia.org/wiki/Red_Bull_RB9)
- Mercedes：[Mercedes F1 W05 Hybrid](https://en.wikipedia.org/wiki/Mercedes_F1_W05_Hybrid)、[Mercedes V6 hybrid power unit](https://en.wikipedia.org/wiki/Mercedes_V6_hybrid_Formula_One_power_unit)、[Formula One engines](https://en.wikipedia.org/wiki/Formula_One_engines)
- Renault：[Red Bull RB10](https://en.wikipedia.org/wiki/Red_Bull_RB10)、[Red Bull RB11](https://en.wikipedia.org/wiki/Red_Bull_RB11)、[Red Bull Racing](https://en.wikipedia.org/wiki/Red_Bull_Racing)、[Renault V6 hybrid power unit](https://en.wikipedia.org/wiki/Renault_V6_hybrid_Formula_One_power_unit)、[Renault R.S.19](https://en.wikipedia.org/wiki/Renault_R.S.19)、[Red Bull RB13](https://en.wikipedia.org/wiki/Red_Bull_RB13)、[2018 Monaco GP](https://en.wikipedia.org/wiki/2018_Monaco_Grand_Prix)
- Honda：[Honda V6 hybrid power unit](https://en.wikipedia.org/wiki/Honda_V6_hybrid_Formula_One_power_unit)、[Honda in Formula One](https://en.wikipedia.org/wiki/Honda_in_Formula_One)、[McLaren MP4-30](https://en.wikipedia.org/wiki/McLaren_MP4-30)、[McLaren MCL32](https://en.wikipedia.org/wiki/McLaren_MCL32)、[Toro Rosso STR13](https://en.wikipedia.org/wiki/Toro_Rosso_STR13)、[Red Bull RB16B](https://en.wikipedia.org/wiki/Red_Bull_RB16B)、[Autosport：Honda 2016 年的進步](https://www.autosport.com/f1/news/127796/honda-made-great-progress-in-2016--renault)
- Ferrari：[Ferrari SF21](https://en.wikipedia.org/wiki/Ferrari_SF21)、[The Race：Ferrari 2021 混合動力升級](https://the-race.com/formula-1/how-ferrari-hybrid-upgrade-helped-edge-battle-with-mclaren/)、[Ferrari SF1000](https://en.wikipedia.org/wiki/Ferrari_SF1000)、[Ferrari SF90](https://en.wikipedia.org/wiki/Ferrari_SF90)、[Ferrari V6 hybrid power unit](https://en.wikipedia.org/wiki/Ferrari_V6_hybrid_Formula_One_power_unit)、[Toro Rosso STR11](https://en.wikipedia.org/wiki/Toro_Rosso_STR11)、[Sauber C36](https://en.wikipedia.org/wiki/Sauber_C36)
- 2026：[The Race：各隊最大弱點](https://www.the-race.com/formula-1/every-2026-f1-team-big-weakness/)、[Autosport：Mercedes 的優勢](https://www.autosport.com/f1/news/how-mercedes-advantage-in-f1-2026-goes-beyond-the-engine/10803973/)、[The Race：Monza 電能部署](https://www.the-race.com/formula-1/f1-teams-monza-italian-gp-early-energy-depoyment-patterns/)、[Autosport：逐隊表現](https://www.autosport.com/f1/news/how-every-f1-2026-teams-performed-so-far-team-by-team/10812457/)、[Motorsport.com 期中評分：Red Bull](https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-red-bull-stumbles-but-summer-rally-shows-glimmer-of-progress/10845430/)、[Audi](https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-audi-gets-off-to-solid-start-on-works-debut/10845164/)、[Aston Martin](https://www.motorsport.com/f1/news/f1-2026-mid-season-grades-aston-martin-seeks-redemption-after-shocking-start/10844630/)、[PlanetF1：Red Bull](https://www.planetf1.com/chinese-grand-prix/why-red-bull-are-slow-2026-max-verstappen-rb22-problems)、[OpenF1 遙測](https://api.openf1.org/v1/car_data?session_key=11357&driver_number=63)

產生方式：資料由暫存區的產生器腳本依上面的分組與分數寫出；驗證項目包括 id 與 `tools/seasons-raw.json` 一一對應、數字都在範圍內、沒有 KERS 的車正好是上表那五台。
