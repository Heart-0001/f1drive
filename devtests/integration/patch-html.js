const fs = require('fs');
const p = 'C:/Users/user/Desktop/f1drive/index.html';
let s = fs.readFileSync(p, 'utf8');
const nl = s.includes('\r\n') ? '\r\n' : '\n';
s = s.replace(/\r\n/g, '\n');
function rep(a, b) {
  const c = s.split(a).length - 1;
  if (c !== 1) throw new Error('expected 1 match, got ' + c + ' for: ' + a.slice(0, 60));
  s = s.replace(a, () => b);
}

rep(`  .menu-body { flex: 1 1 auto; overflow-y: auto; padding: 4px 32px 32px; }
  .menu-body::-webkit-scrollbar { width: 10px; }
  .menu-body::-webkit-scrollbar-thumb { background: #2f3641; border-radius: 5px; }
`, `  .menu-main { flex: 1 1 auto; min-height: 0; display: flex; }
  .menu-body { flex: 1 1 auto; min-width: 0; overflow-y: auto; padding: 4px 32px 32px; }
  .menu-body::-webkit-scrollbar, #mp-panel::-webkit-scrollbar { width: 10px; }
  .menu-body::-webkit-scrollbar-thumb, #mp-panel::-webkit-scrollbar-thumb { background: #2f3641; border-radius: 5px; }
  #track-lock {
    margin: 0 0 14px; padding: 12px 16px; font-size: 14px; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--line); border-left: 3px solid var(--accent-2); border-radius: 6px;
  }
  #track-grid.locked { pointer-events: none; opacity: .38; filter: grayscale(.6); }

  /* ---------- Multiplayer panel ---------- */
  #mp-panel {
    flex: none; width: 340px; overflow-y: auto; padding: 4px 24px 28px 22px;
    border-left: 1px solid var(--line); font-size: 13.5px; line-height: 1.55;
  }
  #mp-panel h2 { margin: 0 0 12px; font-size: 17px; font-weight: 600; letter-spacing: .04em; }
  #mp-panel h3 { margin: 16px 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: .1em; }
  .mp-field { display: flex; gap: 8px; align-items: center; }
  .mp-field + .mp-field { margin-top: 8px; }
  #mp-panel input[type=text], #mp-panel input[type=number] {
    flex: 1 1 auto; min-width: 0; height: 34px; padding: 0 10px;
    font: 14px var(--ui-font); color: var(--text);
    background: var(--panel); border: 1px solid var(--line); border-radius: 6px; outline: none;
    -webkit-user-select: text; user-select: text;
  }
  #mp-panel input:focus { border-color: var(--accent-2); }
  #mp-panel input::placeholder { color: #626c7a; }
  #mp-panel input:disabled { opacity: .5; }
  #mp-panel #mp-port { flex: 0 0 96px; font-variant-numeric: tabular-nums; }
  .mp-btn {
    flex: none; height: 34px; padding: 0 14px; cursor: pointer; white-space: nowrap;
    font: 600 13.5px var(--ui-font); color: #fff;
    background: var(--panel-2); border: 1px solid #3a4250; border-radius: 6px;
  }
  .mp-btn:hover { border-color: #5b6575; background: #232832; }
  .mp-btn.primary { background: var(--accent); border-color: var(--accent); }
  .mp-btn.primary:hover { background: var(--accent-2); border-color: var(--accent-2); }
  .mp-btn:disabled { opacity: .45; cursor: default; pointer-events: none; }
  #mp-colours { display: flex; flex-wrap: wrap; gap: 8px; }
  .mp-swatch {
    width: 28px; height: 28px; padding: 0; cursor: pointer; border-radius: 50%;
    border: 2px solid rgba(0,0,0,.5); outline: 2px solid transparent; outline-offset: 1px;
  }
  .mp-swatch:hover { outline-color: #5b6575; }
  .mp-swatch.on { outline-color: #fff; }
  .mp-note { margin: 8px 0 0; font-size: 12.5px; color: var(--muted); }
  #mp-status { margin: 14px 0 0; padding: 8px 12px; border-radius: 6px; background: var(--panel); border: 1px solid var(--line); }
  #mp-status.err { color: #ffb4ae; border-color: #6b2a26; }
  #mp-status.ok { color: #9fe8c0; border-color: #245c40; }
  #mp-players { margin: 0; padding: 0; list-style: none; }
  #mp-players li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .mp-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; border: 1px solid rgba(0,0,0,.6); }
  .mp-pname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-tag { flex: none; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
  .mp-addr {
    display: block; margin: 4px 0; padding: 5px 10px; border-radius: 5px; background: var(--panel); border: 1px solid var(--line);
    font: 600 14px var(--num-font); letter-spacing: .02em; -webkit-user-select: text; user-select: text; word-break: break-all;
  }
  #mp-host ol { margin: 8px 0 0; padding-left: 18px; color: var(--muted); font-size: 12.5px; }
  #mp-host ol b { color: var(--text); font-weight: 600; }
  #mp-leave { margin-top: 16px; width: 100%; }
`);

rep(`  #hud-map { top: 18px; right: 18px; padding: 8px; }`, `  #hud-players { top: 196px; left: 18px; padding: 8px 14px 9px 12px; min-width: 210px; max-width: 280px; font-size: 13px; }
  #hud-players .prow { display: flex; align-items: center; gap: 8px; line-height: 1.6; }
  #hud-players .pt { flex: none; font: 600 13px var(--num-font); color: #c9d1db; }
  #hud-toast {
    position: absolute; top: 18px; left: 50%; transform: translateX(-50%); max-width: 60vw;
    padding: 8px 18px; font-size: 14px; text-align: center; border-left: 3px solid var(--accent-2);
  }
  #hud-map { top: 18px; right: 18px; padding: 8px; }`);

rep(`    .menu-body { padding: 4px 16px 24px; }
`, `    .menu-body { padding: 4px 16px 24px; }
    .menu-main { flex-direction: column; overflow-y: auto; }
    .menu-main .menu-body { overflow: visible; flex: none; }
    #mp-panel { width: auto; border-left: 0; border-bottom: 1px solid var(--line); padding: 16px; overflow: visible; order: -1; }
    #hud-players { display: none; }
`);

rep(`  <div id="hud-map" class="hud-box"><canvas id="minimap"></canvas></div>`, `  <div id="hud-players" class="hud-box hidden"></div>
  <div id="hud-toast" class="hud-box hidden"></div>
  <div id="hud-map" class="hud-box"><canvas id="minimap"></canvas></div>`);

rep(`  <div class="menu-body">
    <div id="track-grid"></div>
    <div id="track-empty" class="hidden">找不到符合的賽道</div>
  </div>
</div>`, `  <div class="menu-main">
    <div class="menu-body">
      <div id="track-lock" class="hidden"></div>
      <div id="track-grid"></div>
      <div id="track-empty" class="hidden">找不到符合的賽道</div>
    </div>
    <aside id="mp-panel">
      <h2>多人連線</h2>
      <div class="mp-field">
        <input id="mp-name" type="text" maxlength="16" placeholder="你的名稱" autocomplete="off" spellcheck="false" aria-label="玩家名稱">
      </div>
      <h3>車色</h3>
      <div id="mp-colours"></div>

      <div id="mp-offline">
        <h3>建立房間（你當房主）</h3>
        <div class="mp-field">
          <input id="mp-port" type="number" min="1024" max="65535" step="1" value="24500" aria-label="連接埠">
          <button id="mp-create" type="button" class="mp-btn primary">建立房間</button>
        </div>
        <p id="mp-create-note" class="mp-note hidden"></p>
        <h3>加入房間</h3>
        <div class="mp-field">
          <input id="mp-addr" type="text" maxlength="255" placeholder="房主 IP，例：203.0.113.5:24500" autocomplete="off" spellcheck="false" aria-label="房主位址">
          <button id="mp-join" type="button" class="mp-btn primary">加入房間</button>
        </div>
      </div>

      <div id="mp-status" class="hidden"></div>

      <div id="mp-online" class="hidden">
        <div id="mp-host" class="hidden">
          <h3>把位址給朋友</h3>
          <div>同一個區域網路（同一台路由器／Wi-Fi）：</div>
          <div id="mp-lan"></div>
          <div style="margin-top:8px">不同網路的朋友要用你的<b>公網 IP</b>：</div>
          <div class="mp-field" style="margin-top:4px">
            <button id="mp-pubip" type="button" class="mp-btn">顯示我的公網 IP</button>
          </div>
          <div id="mp-pubip-out"></div>
          <ol>
            <li>在路由器設定<b>連接埠轉發</b>：TCP <b id="mp-port-note">24500</b> → 這台電腦的區域網路 IP。</li>
            <li>Windows 防火牆第一次會跳出詢問，請按<b>允許存取</b>。</li>
            <li>你關閉遊戲或離開房間，房間就會結束。</li>
          </ol>
        </div>
        <h3 id="mp-players-title">玩家</h3>
        <ul id="mp-players"></ul>
        <button id="mp-leave" type="button" class="mp-btn">離開房間</button>
      </div>
    </aside>
  </div>
</div>`);

rep(`<script src="js/ui.js"></script>`, `<script src="js/collide.js"></script>
<script src="js/carmodel.js"></script>
<script src="js/net.js"></script>
<script src="js/ui.js"></script>`);

fs.writeFileSync(p, s.replace(/\n/g, nl));
console.log('ok');
