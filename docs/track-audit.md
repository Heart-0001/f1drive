# 40 條賽道資料檢查（2026-10-01）

使用者要求「把所有賽道的資料重新檢查一次」，起因是：Spa 的陡坡看不出來、Madring 與 Zandvoort 的傾斜彎不明顯、Monaco 最慢的髮夾彎連 20 km/h 都過不去、Monaco 隧道要做出來。

做法：9 位稽核員逐條檢查 40 條賽道，每條賽道的結果放在 `devtests/track-audit/<id>.json`。彙整階段把每一項「重大」發現都獨立重測過一次，用的是自己選的取樣點、自己重新查詢的 OSM 資料、重讀的原始出處和衛星影像，程式在 `devtests/track-audit/verify/`。稽核共提出 33 項資料類的重大發現，另有 8 項體感類（Spa、Zandvoort、Madring）。資料類有 32 項完全確認，Monza 的低窪只確認了一部分；沒有任何一項被推翻。體感類關於程式行為的描述全部屬實，但建議的數值要實際駕駛後再調整。有兩處需要修正說法，見第 5 節。

可以直接套用的修正寫在 `tools/track-audit.json`，目前**尚未套用**。

## 1. 總表

判定說明：「重大（資料）」表示賽道資料本身錯了。「重大（場景）」表示賽道資料沒問題，錯在場景或程式。「輕微」表示只有小問題或屬於選擇性修正。

| ID | 賽道 | 判定 | 主要問題 |
|---|---|---|---|
| au-1953 | Albert Park（墨爾本） | 重大（資料） | 有兩段中心線偏離道路約 22 m，壓在草地上（T8 後、T11），T11 的轉彎半徑只有 10 m；起跑線差 45 m |
| pt-1972 | Estoril | 重大（資料） | 幾何其實是 2000 年後的佈局，卻標成 1972–93 年版並拉長 4.4 %；F1 從沒跑過這個佈局 |
| it-1953 | Imola | 重大（資料） | 高程整段錯位：Acque Minerali 的谷底太淺，Rivazza 的下坡太陡（-10.7 %，實際 -6.9 %） |
| mx-1962 | Mexico City | 輕微 | 6 座跨越賽道的天橋沒畫；起跑線差 73 m |
| pt-2008 | Portimão | 重大（資料） | 起伏只剩一半左右：最陡下坡 -7.9 %，公開資料是 12 %；T9–T11 的谷只有實際的一半深 |
| br-1977 | Jacarepaguá | 輕微 | 唯一的起伏是 2007 年蓋的場館（不是地形），應改成平坦賽道 |
| it-1914 | Mugello | 重大（資料） | San Donato（T1）在遊戲裡是下坡，實際是上坡（+12.9 m） |
| br-1940 | Interlagos | 重大（資料） | S do Senna 太緩；Descida do Lago 變平；Bico de Pato 多出一座不存在的小丘；起跑直道實際上坡，遊戲卻是下坡 |
| it-1922 | Monza | 重大（資料） | 多出不存在的起伏（遊戲高低差 22.4 m，實際約 12 m）；舊傾斜彎下方的低窪處不見了 |
| ar-1952 | Buenos Aires | 輕微 | 長度被拉長 1.5 %；起跑線差 68 m |
| bh-2002 | Bahrain | 輕微 | 主直道上多出 5 m 的隆起（看台被算進地表模型）；實際起跑線在前方約 90 m |
| az-2016 | Baku | 重大（資料） | 城堡段實際只有 7.6 m 寬，遊戲是 14 m；高低差多了 28 % |
| es-1991 | Barcelona | 重大（資料） | T3 多出不存在的坡頂，T4 多出不存在的谷 |
| mc-1929 | Monaco | 重大（資料） | 沒有隧道（Fairmont 飯店下方 360 m）；所有慢彎都多了 5–6° 的傾斜 |
| fr-1960 | Magny-Cours | 輕微 | 推算出的傾斜偏大；維修區比實際短 |
| be-1925 | Spa | 重大（資料＋場景） | Raidillon 只有 3–5 %（實際 15 %）；Paul Frère 到 Bus Stop 這段被樹冠墊高 25–30 m；Eau Rouge 前有一座不存在的橋 |
| ca-1978 | Montréal | 重大（場景） | T8 前的橋下段落沒有橋；高程與實際地面不相關（輕微） |
| us-2012 | COTA | 輕微 | 3 座人行天橋沒畫；推算出的傾斜偏大（只有 T1 真的有 4.3°） |
| fr-1969 | Paul Ricard | 輕微 | Mistral 減速彎的入口形狀不對；橋下有 2 m 的假凹陷 |
| nl-1948 | Zandvoort | 重大（場景） | 主直道上有一座不存在的橋；Tarzan、Hunserug、Scheivlak 實際有 4.5–6.5° 的傾斜，遊戲只做出 1–3°；2024 年以前的進站限速是 60 km/h |
| es-2026 | Madring | 重大（資料） | 高程形狀錯誤（主直道上坡、T3 前假下坡）；兩條隧道沒做；長度多了 60 m |
| de-1932 | Hockenheim | 重大（場景） | 有 3 座不存在的橋；Parabolika 上多出 5 m 的隆起（輕微） |
| hu-1986 | Hungaroring | 重大（資料） | 起跑線往 T1 方向偏了約 240 m |
| us-1909 | Indianapolis | 輕微 | 長度被拉長 2.6 %；室內場地段的彎道傾斜偏大 |
| tr-2005 | Istanbul Park | 輕微 | 山頂被削低 6–7 m；起跑線差 22 m |
| sa-2021 | Jeddah | 輕微 | 依計時資料，實際發車格整排都在遊戲起跑線前方（約 180 m），桿位在右側；影像無法確認 |
| za-1961 | Kyalami | 輕微 | Leeukop 高了約 7 m（只有地表模型可比對） |
| us-2023 | Las Vegas | 輕微 | 單軌高架橋（經過兩次）和 6 座天橋沒畫；起跑線差 92 m |
| qa-2004 | Lusail | 輕微 | 長度用的是 2004–22 年的數字（5.380），實際應為 5.419 km |
| sg-2008 | Marina Bay | 重大（場景） | ECP／Benjamin Sheares 高架橋沒畫；2025 年起進站限速是 80 km/h |
| us-2022 | Miami | 重大（資料） | 被當成平坦賽道處理，T13–T16 的坡道與坡頂（+3.2 m，+4.7 %）不見了 |
| de-1927 | Nürburgring | 重大（場景） | 1.5 km 處有一座不存在的橋；NGK 減速彎前的爬坡位置偏了 150 m（輕微） |
| at-1969 | Red Bull Ring | 輕微 | Schönberg 直道多出 4–6 m 的隆起 |
| my-1999 | Sepang | 重大（資料） | 起跑線往 T1 方向偏了 300 m；最高點放在後直道，實際在 T10／T11 |
| cn-2004 | Shanghai | 重大（資料） | 起跑線往 T1 方向偏了約 210 m（±15 m） |
| gb-1948 | Silverstone | 重大（資料） | 起跑線和維修區還在 2010 年以前的舊位置；2011 年起改在 Club 與 Abbey 之間的 Wing |
| ru-2014 | Sochi | 輕微 | 進站限速應為 60 km/h（遊戲是 80） |
| jp-1962 | Suzuka | 重大（程式） | 立體交叉被做成平面路口，兩條路被拉到同一高度；實際上下相差 6.2 m |
| us-1956 | Watkins Glen | 輕微 | 彎道實際有 4–6° 的超高，遊戲傾斜不足 |
| ae-2009 | Yas Marina | 重大（場景） | 維修區出口是從賽道下方的隧道穿過，最後在 T3 左側匯入，遊戲沒做；W 飯店下方那段沒畫連通橋 |

全部 40 條賽道的佈局方向都正確；進站區在哪一側也都正確（凡是能查證的都核對過）。

## 2. 會修正的項目（`tools/track-audit.json` 的 `apply`）

**高程改用更好的資料來源**（括號內為與實測的差距）：
- Spa：改用瓦隆區 0.5 m 光達。Raidillon 會從 3 % 變成約 14–15 %，Kemmel 直道變回 4–5 %（RMS 9.8 m）。
- Barcelona、Madring：改用西班牙 IGN MDT05。Madring 的兩條隧道要用 COVERED 處理。
- Imola：改用艾米利亞—羅馬涅大區 0.5 m 光達。
- Mugello：改用托斯卡尼 1 m 地表模型，取 25 m 中位數。
- Monza：改用 TINITALY 10 m，再手動加入舊傾斜彎下方約 5 m 的低窪。
- Miami：移出平坦賽道清單，改用 USGS 光達。
- Interlagos、Sepang、Portimão：改用 Copernicus GLO-30。這些地方沒有開放光達，GLO-30 已和 SRTM 交叉比對。Sepang 要取貼近路面的低值包絡；Portimão 套用後要確認上坡不超過約 7 %。

**起跑線（START_AT）**：
- Silverstone：移到 Wing 的計時線，pitSide 設為 -1。
- Hungaroring：往後移 240 m。
- Sepang：往後移 302 m（OSM 有標示節點，影像上也看得到發車格）。
- Shanghai：往後移約 210 m（依影像判斷）。

**佈局與寬度**：
- Albert Park：兩段改用 OSM 的頂點。
- Estoril：改標為 2000 年後的佈局，不再拉長。
- Madring：長度設為 5414 m。
- Baku：城堡段的半寬設為 3.8 m（需要 js/track.js 支援）。

**場景**：
- 拆掉 6 座不存在的橋：Spa、Zandvoort、Hockenheim 3 座、Nürburgring。另外加一條規則：路線自己的橋面不可以蓋在路面上方。
- 補上真的跨越賽道的結構：Montréal 的橋下段落、Marina Bay 的高架橋、Yas 的 W 飯店連通橋。
- build-scenery 要開始收錄線狀的橋樑資料。

**隧道**：
- Monaco：Fairmont 隧道和 Portier 地下道（js/tunnels.js 已經有預備資料）。
- Madring：兩條隧道。
- Suzuka：立體交叉要保留上下兩層各自的高度並畫出橋面（需要修改 js/track.js）。

**傾斜**：
- 推算出的傾斜上限從 6° 降到 2.5°，街道賽道降到 1.5°。
- 加入光達實測的真實外傾：Zandvoort 的 Tarzan 6.5°、Hunserug 4.5°、Scheivlak 5°；Imola、Mugello 的 Arrabbiata 5.1°；Spa 的 Kemmel、Blanchimont 約 4°。
- 保留所有公開資料的傾斜角：Zandvoort 19°／18°、Madring 13.5°、Jeddah 12°、Indianapolis 9.2°。

**進站限速**：
- Zandvoort：2024 年以前 60 km/h。
- Singapore：2024 年以前 60 km/h，2025 年起 80 km/h。
- Sochi：60 km/h。
- 以上都要支援依賽季設定，否則就統一用 80 km/h。

## 3. 不修或暫緩的項目與原因

- **依賽季切換佈局**（Barcelona 2010–22 年有減速彎、Yas 2010–20 年、Singapore 2010–22 年、Albert Park 2010–19 年、Bahrain 2010 年與 2020 年）：目前一條賽道只能有一個佈局，這是全遊戲的設計選擇。
- **Estoril 1984–96 年的舊 Parabolica**：OSM 沒有留下舊路線，1995 年的航照需要 DGT 帳號才能取得。
- **真實的維修區幾何**（實際長 570–1370 m，遊戲一律在起跑線前後各 250 m）：需要新增 js/track.js 的輸入欄位。資料已經列在每條賽道的 `pitLaneReal`，等之後實作。
- **F1 計時資料的車輛高度**：可以拿來驗證高程（在 Imola 與光達的差距只有 0.55 m），但這是 FOM 的資料，授權有疑慮，所以只用來驗證，不當成正式資料來源。
- **Monza、Hungaroring 的光達**：倫巴底和匈牙利都沒有能用的開放光達服務。
- **小於 30 m 的起跑線偏差**（Spa、COTA、Istanbul、Kyalami、Yas）：只影響外觀，列為選用。
- **Paul Ricard 的起跑線（差 152 m）**：只有 OSM 一個出處，要先對照 FIA 地圖才能採用。
- **Jeddah 的起跑線**：計時資料顯示要往前 188 m、桿位在右側，但影像無法確認，也需要程式支援桿位在哪一側，列為選用。
- **COTA 公開的 41 m 高低差**：光達量到路面只有 31 m，所以維持光達的數字。
- **Monaco 髮夾彎過不去**：賽道資料沒錯（中心線半徑 9.6 m，OSM 是 8.9 m），問題在 js/car.js 的最大轉向角，最小轉彎半徑是 10 m，要在 v6.2 修。Mexico 的 T5（約 11 m）也要一起重新測試。

## 4. 體感建議（坡度與傾斜「看不出來」）

1. **資料先修**：Spa 的「陡坡看不出來」，主要原因是資料。GLO-90 把 Raidillon 抹成 3–5 %，換成光達後，從谷底看 100 m 前方的路面，會比現在高出約 6°。
2. **視野角**：cockpit.js 目前是垂直 70–82°（16:9 下水平約 112°）。在一般螢幕上，所有角度大約只剩實際的 0.3 倍，15 % 的坡看起來就像 4–5 %。建議改成垂直 58–62°，並在設定裡加一個 50–75° 的「視野」滑桿。
3. **地平線穩定**：目前攝影機和車體完全鎖在一起（視角的俯仰、側傾就等於車身的俯仰、側傾），所以穩定上坡的畫面和平路一模一樣。建議讓頭部抵消 50 % 的俯仰和 40 % 的側傾，並加上「地平線穩定」0–100 % 的設定。這樣上 Raidillon 時會看到車頭抬起；在 Zandvoort T3 和 Madring La Monumental，會看到車身倒向傾斜彎內側，而不是整個畫面歪掉。
4. **座椅負荷**：car.js 輸出 `seatG`，頭部用彈簧模擬（2.2 Hz、阻尼 0.45），每 1 g 下沉 3 cm、點頭 1.5°。Eau Rouge 谷底約有 +0.7 g 的壓縮感，傾斜彎中約有 +1.2 g 的下壓感，目前畫面完全沒有表現出來。
5. **傾斜彎的參照物**：傾斜角超過 8° 的路段兩側要加垂直的圍網柱，外牆外面的地形要順著傾斜角再延伸 15–20 m。降低推算傾斜的上限（第 2 節）也會讓真正的傾斜彎和其他彎道的差別更明顯。
6. **Madring 出 La Monumental 的坡頂**：官方說這裡是「短暫的盲區」，但遊戲只有很緩的坡頂。目前的光達可能是動工前拍攝的，換資料後要重新確認這一段。

## 5. 修正後的說法

- **Suzuka 的公開高低差**：稽核員說 ja.wikipedia 已經沒有「最大高低差は52 m」這句。重讀後發現這句還在，但那是整個場地的數字。賽道本身用光達量是 40.4 m，和 formula1.com 一致。兩個數字都保留。
- **Monza 舊傾斜彎下方的低窪**：遊戲在這裡做出一段長下坡，這部分已經用 TINITALY 證實是錯的。但 10 m 解析度的 TINITALY 看不出這個約 5 m 的低窪，目前只有計時資料的車輛高度和 formula1.com 的描述可以佐證，所以列為「可信、以手動加入」。

## 6. 套用之後

1. 依序執行 `node tools/build-tracks.mjs`（會下載並快取新的高程取樣）；有改到點位或 geo 的賽道（au-1953、pt-1972、es-2026、az-2016）要執行 `node tools/build-scenery.mjs`；接著跑 `node devtests/seasons-calib/calibrate.mjs`（約 22 分鐘）和 `node tools/build-cars.mjs --check`。
2. 重跑所有 node 測試和 Electron 測試工具。
3. 套用前先確認授權：瓦隆區 MNT 沒有明確的開放授權，要先確認；如果不能用，改用 `devtests/track-audit/be-nl-de-gb/out/profile-be-1925.json` 的靜態剖面。

驗證用的程式：`devtests/track-audit/verify/`（decks.js、decks-osm.js、overhead.js、compare.js、window.js、imagery.js、make-audit-json.js）。快取放在 `devtests/track-audit/cache/verify/`，不納入 git。
