// Where does draw() spend its time when it runs once per requestAnimationFrame (as in the game)?
// Measures, over N rAF frames each: the full draw(), only clearing + copying the static layer, and a bare
// clearRect, on the page.html canvas. Diagnostic only (prints a table, no verdict).
//   npx electron devtests/telemetry-test/probe-cost.js        env DPR=1|2 (default 1), W=1920, H=1080, N=600
const { app, BrowserWindow } = require('electron');
const path = require('path'), url = require('url');
const DPR = Number(process.env.DPR) || 1, W = Number(process.env.W) || 1920, H = Number(process.env.H) || 1080;
const N = Number(process.env.N) || 600;
app.commandLine.appendSwitch('force-device-scale-factor', String(DPR));
require('../electron-userdata')(app, 'telemetry-probe');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  try {
    await w.loadURL(url.pathToFileURL(path.join(__dirname, 'page.html')).href);
    await new Promise(r => setTimeout(r, 300));
    const res = await w.webContents.executeJavaScript(`(async function () {
      __init(); __show({});
      var cv = document.getElementById('hud-telemetry'), c = cv.getContext('2d'), tel = F1.telemetry;
      tel.clock = function () { return performance.now(); };
      var st = { speedKmh: 200, gear: 5, rpm: 9000, throttle: 1, brake: 0, battery: 0.6, deploy: 1, harvest: 0,
        tyres: { compound: 'M', wear: [0.1, 0.2, 0.3, 0.4], flat: [0, 0.5, 0, 0], puncture: -1 }, team: 'McLaren', car: 'MCL40', colour: '#ff8000' };
      var other = document.createElement('canvas'); other.width = cv.width; other.height = cv.height;
      var modes = {
        full: function (i) { st.rpm = 8000 + (i % 40) * 100; st.speedKmh = 150 + (i % 97); st.throttle = i % 20 < 10 ? 1 : 0; tel.draw(st); },
        clearCopy: function () { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); c.drawImage(other, 0, 0); },
        clearOnly: function () { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); },
        fillOnePx: function () { c.fillRect(0, 0, 1, 1); },
        // text: seven font changes a frame with the game's font stacks, one glyph each
        fonts7: function () { for (var j = 0; j < 7; j++) { c.font = FONTS[j]; c.fillText('8', 10 + j * 20, 40); } },
        font1x7: function () { c.font = FONTS[0]; for (var j = 0; j < 7; j++) c.fillText('8', 10 + j * 20, 40); },
        // twelve sprite blits from a pre-rendered atlas canvas (what a glyph atlas would cost instead of fillText)
        blit12: function () { for (var j = 0; j < 12; j++) c.drawImage(atlas, (j % 10) * 40, 0, 40, 60, 10 + j * 30, 20, 40, 60); },
        arcs20: function () { c.lineWidth = 6; for (var j = 0; j < 20; j++) { c.beginPath(); c.arc(100, 100, 50, 0, 1 + j * 0.1); c.stroke(); } },
        nothing: function () {}
      };
      var NUM = 'Bahnschrift, "DIN Alternate", "Segoe UI", "Microsoft JhengHei", system-ui, sans-serif';
      var UIF = '"Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", system-ui, sans-serif';
      var FONTS = ['italic 700 46px ' + NUM, 'italic 700 45px ' + NUM, '600 10px ' + NUM, 'italic 700 17px ' + NUM,
        'italic 700 11px ' + NUM, '700 11px ' + UIF, '800 14px ' + NUM];
      var atlas = document.createElement('canvas'); atlas.width = 400; atlas.height = 60;
      var ac = atlas.getContext('2d'); ac.font = FONTS[0]; ac.fillStyle = '#fff';
      for (var d = 0; d < 10; d++) ac.fillText(String(d), d * 40 + 4, 50);
      var out = {};
      for (var name in modes) {
        var f = modes[name], t = [];
        await new Promise(function (res) {
          var i = 0;
          function loop() { var a = performance.now(); f(i); t.push(performance.now() - a); if (++i < ${N}) requestAnimationFrame(loop); else res(); }
          requestAnimationFrame(loop);
        });
        t.sort(function (a, b) { return a - b; });
        var s = 0; t.forEach(function (x) { s += x; });
        out[name] = { avg: +(s / t.length).toFixed(4), p50: t[t.length >> 1], p99: t[Math.floor(t.length * 0.99)], max: t[t.length - 1] };
      }
      out.canvas = [cv.width, cv.height];
      return out;
    })()`);
    console.log(`rAF-driven cost per frame @${W}x${H} dpr ${DPR} (${N} frames each, ms; performance.now() is 0.1 ms coarse):`);
    for (const k of Object.keys(res)) console.log('  ' + k.padEnd(10) + JSON.stringify(res[k]));
  } catch (e) { console.log('probe failed: ' + (e && e.stack || e)); }
  app.exit(0);
});
