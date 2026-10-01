// Contact sheet of perception shots: rows = shot names, columns = variant tags (out/<track>-<row>-<col>.png).
//   npx electron devtests/track-audit/perception/compose.js
//   env TRACK=be-1925 ROWS=0-top,2-bottom COLS=base,all OUT=out/compare-be-1925.png CW=640 (column width, px)
// The sheet is drawn in an offscreen window (muted through devtests/electron-userdata.js) and captured.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const HERE = __dirname, ROOT = path.resolve(HERE, '..', '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'perception-sheet');
const TRACK = process.env.TRACK, ROWS = (process.env.ROWS || '').split(','), COLS = (process.env.COLS || 'base').split(',');
const CW = +(process.env.CW || 640), CH = Math.round(CW * 722 / 1281), LW = 150, HH = 34;
const OUT = path.resolve(HERE, process.env.OUT || ('out/compare-' + TRACK + '.png'));
const LABEL = { base: 'now (FOV 70-82, car-locked view)', fov: 'FOV 58-62', stab: 'stabilise pitch 50 % / roll 40 %',
  all: 'FOV 58-62 + stabilise + seat-load head', fence: 'all + fences on the bank', rec: 'recommended set' };
app.whenReady().then(async () => {
  const W = LW + CW * COLS.length, H = HH + CH * ROWS.length;
  let html = '<html><body style="margin:0;background:#111;color:#eee;font:14px sans-serif">' +
    '<div style="display:flex;height:' + HH + 'px"><div style="width:' + LW + 'px;padding:8px">' + TRACK + '</div>' +
    COLS.map(c => '<div style="width:' + CW + 'px;padding:8px;box-sizing:border-box">' + (LABEL[c] || c) + '</div>').join('') + '</div>';
  for (const r of ROWS) {
    html += '<div style="display:flex;height:' + CH + 'px"><div style="width:' + LW + 'px;padding:8px;box-sizing:border-box">' + r + '</div>';
    for (const c of COLS) {
      const f = path.join(HERE, 'out', TRACK + '-' + r + '-' + c + '.png');
      html += fs.existsSync(f) ? '<img src="' + url.pathToFileURL(f).href + '" style="width:' + CW + 'px;height:' + CH + 'px">'
        : '<div style="width:' + CW + 'px">missing</div>';
    }
    html += '</div>';
  }
  html += '</body></html>';
  const page = path.join(HERE, 'out', 'sheet-' + process.pid + '.html');
  fs.writeFileSync(page, html);
  const w = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  await w.loadFile(page);
  await new Promise(r => setTimeout(r, 800));
  fs.writeFileSync(OUT, (await w.webContents.capturePage()).toPNG());
  try { fs.unlinkSync(page); } catch (e) {}
  console.log('wrote ' + OUT + ' ' + W + 'x' + H);
  app.exit(0);
});
