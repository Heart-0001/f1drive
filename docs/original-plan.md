# F1 第一視角模擬開車遊戲

## Context

`C:\Users\user\Desktop\f1drive` 目前是空資料夾。目標是做一個簡單的瀏覽器 3D 開車遊戲:

- 收錄 F1 所有賽道(真實賽道形狀)
- WASD 控制
- 賽道邊線與牆壁都要畫出來,牆壁要有碰撞
- F1 座艙第一視角

## 技術選擇

- **Three.js r149**(最後一個有 UMD 傳統 script 版本的系列),下載到 `lib/three.min.js`。全部程式用傳統 `<script>` 掛在 `window.F1` 命名空間下,不需打包工具也不需伺服器,雙擊 `index.html` 就能離線玩。
- **賽道資料**:開源資料集 `bacinger/f1-circuits`(MIT,GeoJSON,每條賽道一條經緯度中心線,約 40 條,涵蓋 2026 賽曆全部 24 站及近年賽道)。實作時下載一次並轉成本地檔案,遊戲執行時不需再連網抓賽道。
- 賽道一律平面(資料集沒有高低差)。

## 檔案結構

| 檔案 | 內容 |
|---|---|
| `index.html` | 頁面骨架、選單/HUD 的 DOM 與 CSS,依序載入下列 script |
| `lib/three.min.js` | Three.js r149 UMD |
| `js/track.js` | `F1.buildTrack(track)` → `{group, samples, halfWidth, wallDist, locate(pos, hintIndex)}`(幾何 + 最近點查詢) |
| `js/car.js` | `F1.createCar()` → `{state, reset(sample), update(dt, input, trackObj)}`(物理 + 牆壁碰撞) |
| `js/cockpit.js` | `F1.createCockpit(camera)` → `{group, update(carState, steer)}`(座艙模型與相機) |
| `js/ui.js` | `F1.ui`:選單、HUD、小地圖、圈速顯示 |
| `js/main.js` | renderer、輸入、主迴圈、圈數計時、賽道切換 |
| `tracks-data.js` | 傳統 script,`window.F1_TRACKS = [{id, name, location, lengthKm, points:[[x,z],...]}, ...]`,座標已換算成公尺 |
| `tools/build-tracks.mjs` | 一次性腳本:下載 GeoJSON → 以賽道中心點做等距投影換算公尺 → 輸出 `tracks-data.js` |

## 實作內容

### 1. 賽道資料(`tools/build-tracks.mjs`)
- 抓取 `f1-circuits.geojson`,每個 feature 取 `Name`、`Location`、`length` 與 LineString 座標。
- 經緯度 → 公尺:`x = Δlon · cos(lat0) · 111320`、`z = −Δlat · 110540`。
- 用資料集的官方長度校正比例,移除首尾重複點。

### 2. 賽道幾何(`buildTrack(track)`)
- 以封閉 Catmull-Rom 曲線平滑中心線,每約 2 m 取樣,得到 `samples[i] = {pos, tangent, normal, s}`。
- **路面**:寬 14 m 的深灰色帶狀 mesh。
- **邊線**:路面兩側各一條 0.3 m 白色實線(略高於路面避免 z-fighting)。
- **路緣石**:彎道處(曲率超過門檻)邊線外側加紅白相間路緣。
- **緩衝區**:邊線外 5 m 草地/柏油帶。
- **牆壁**:左右各一道,離中心線 12 m,高 1.2 m,貼上紅白/廣告色塊條紋方便感受速度。
- **交叉與相鄰路段處理**:牆壁取樣點若落在「其他非相鄰路段」的路面範圍內就不生成(鈴鹿立體交叉、髮夾彎、並行直道才不會被牆擋住)。
- 起跑線:第 0 個取樣點畫格子旗線與發車格。
- 地面大草地平面、天空色、霧、方向光。

### 3. 車輛物理(街機風格)
- 狀態:`pos`、`heading`、`speed`。
- `W` 油門、`S` 煞車(停止後倒車)、`A`/`D` 轉向,`R` 重置回賽道,`Esc` 回選單。
- 加速度隨速度遞減,極速約 330 km/h;轉向角隨速度降低,並以側向抓地力上限限制過彎速度(太快會推頭)。
- 離開路面(超出邊線)進入草地時阻力大增、抓地力下降。

### 4. 碰撞
- 每幀從上一幀的最近取樣索引往前後局部搜尋,得到最近中心線點與側向偏移 `d`(局部搜尋可避免交叉路段誤判)。
- `|d|` 超過牆壁距離(扣掉車寬一半)時:把位置夾回牆內、去掉朝牆的速度分量、速度打折,並讓畫面輕微震動。
- 被省略牆壁的路段(交叉處)不做牆壁碰撞。

### 5. 第一視角
- 相機在車手眼睛位置(離地約 0.75 m),FOV 隨速度略增。
- 簡單幾何拼出座艙:車鼻、Halo、方向盤(隨轉向旋轉)、兩個前輪(隨轉向偏轉並滾動)、後照鏡外型。

### 6. 介面
- **選單**:所有賽道的卡片清單(名稱、地點、長度、賽道輪廓縮圖 SVG),點選即載入。
- **HUD**:時速、檔位(由速度推算)、目前圈/最佳圈時間、圈數、小地圖(賽道輪廓 + 車子位置)、操作說明。
- 圈數計時:通過起跑線且沿途經過足夠比例的取樣點才算一圈。

## 打包成 exe

遊戲本體用網頁技術(Three.js)寫,再用 **Electron** 包成 Windows 執行檔,玩起來就是一個獨立視窗的遊戲,不需要開瀏覽器。

- `package.json`:`electron`、`electron-builder`(devDependencies),scripts:`start`(開發執行)、`dist`(打包)。
- `electron-main.js`:建立全螢幕可切換的 `BrowserWindow`(隱藏選單列,`F11` 切全螢幕),載入 `index.html`。
- `electron-builder` 的 `portable` target → 產出單一檔 `dist/F1Drive.exe`(約 80–100 MB,免安裝,雙擊即玩)。
- 本機已有 Node v24 / npm 11,可直接打包。

## 執行方式(subagent 分工)

先由主線把上表的介面約定寫成 `js/README-interfaces.md`(簡短),再**同時**派出 4 個 Opus subagent,各自只負責自己的檔案:

1. **賽道資料**:`tools/build-tracks.mjs`、產生 `tracks-data.js`、下載 `lib/three.min.js`。
2. **賽道幾何**:`js/track.js`(路面、邊線、路緣、牆壁、交叉處理、`locate`)。
3. **車輛與座艙**:`js/car.js`、`js/cockpit.js`。
4. **介面與主程式**:`index.html`、`js/ui.js`、`js/main.js`。

全部完成後由主線整合、在 Chrome 實際跑過並修掉接合問題,最後派一個 **Fable agent** 做獨立檢查(只給程式碼與需求,不給我的結論):正確性 bug、牆壁/碰撞漏洞、各賽道是否都能正常載入,回報的問題由主線修正後再驗證一次。

## 驗證

1. 執行 `node tools/build-tracks.mjs`,確認 `tracks-data.js` 產生、賽道數量與長度合理。
2. 用 Chrome 開啟 `index.html`(Claude in Chrome 工具),截圖確認:
   - 選單列出所有賽道。
   - 進入賽道後能看到路面、白色邊線、路緣、兩側牆壁與座艙。
   - 按 WASD 車子會加速、轉向、煞車;撞牆會被擋住不會穿出去。
   - console 無錯誤。
4. `npm run dist` 打包後,實際啟動 `dist/F1Drive.exe` 確認視窗開啟、能進入賽道。
3. 抽查幾條特殊賽道:摩納哥(窄彎多)、鈴鹿(交叉)、斯帕(長)、拉斯維加斯(長直道),確認牆壁沒有擋在路上、跑完一圈會計時。
