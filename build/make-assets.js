// Packaging artwork for electron-builder (package.json "build"), drawn with the menu's brand (the red skewed bar,
// "F1 DRIVE" in Bahnschrift) on a canvas in a hidden window, so the text uses the real Windows fonts:
//   build/icon.ico    the exe's icon (16..256 px) and the window / taskbar icon (electron-main.js)
//   build/splash.bmp  shown by the portable exe while it unpacks the game (a few seconds on every start)
// Run:  npx electron build/make-assets.js      (PREVIEW=<dir> also writes PNG previews there)
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');

const OUT = __dirname;
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SPLASH = { w: 480, h: 240 };

// Runs in the page. -> { icons: [{ s, rgba, png }], splash: { rgba, png } } (base64)
function draw(sizes, splash) {
  const BG = '#0b0d10', PANEL = '#1b1f26', RED = '#e10600', RED2 = '#ff4b3a', TEXT = '#eef1f5', MUTED = '#8b95a3';
  const NUM = '"Bahnschrift", "Segoe UI", sans-serif', UI = '"Microsoft JhengHei", "Segoe UI", sans-serif';
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const grab = c => ({ rgba: b64(new Uint8Array(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.buffer)), png: c.toDataURL('image/png').split(',')[1] });
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  // the brand mark: a bar skewed like the menu's (skewX(-14deg))
  const bar = (g, x, y, w, h) => {
    const k = Math.tan(14 * Math.PI / 180) * h;
    g.beginPath(); g.moveTo(x + k, y); g.lineTo(x + k + w, y); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.closePath(); g.fill();
  };
  const icons = sizes.map(s => {
    const c = canvas(s, s), g = c.getContext('2d'), r = s * 0.2;
    g.beginPath(); g.roundRect(0, 0, s, s, r);
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, PANEL); grad.addColorStop(1, BG);
    g.fillStyle = grad; g.fill();
    // "F1" with the bar in front of it; "DRIVE" under it where there is room to read it
    const big = s >= 64, fs = Math.round(s * (big ? 0.5 : 0.62));
    g.font = 'italic 700 ' + fs + 'px ' + NUM; g.textBaseline = 'alphabetic';
    const tw = g.measureText('F1').width, bw = Math.max(2, s * 0.075), gap = s * 0.06;
    const x0 = (s - (bw + gap + tw)) / 2, base = big ? s * 0.58 : s * 0.5 + fs * 0.36;
    g.fillStyle = RED; bar(g, x0, base - fs * 0.74, bw, fs * 0.76);
    g.fillStyle = TEXT; g.fillText('F1', x0 + bw + gap, base);
    if (big) {
      g.font = 'italic 700 ' + Math.round(s * 0.17) + 'px ' + NUM; g.fillStyle = RED2; g.textAlign = 'center';
      g.fillText('DRIVE', s / 2, s * 0.82);
    }
    return Object.assign({ s: s }, grab(c));
  });
  const c = canvas(splash.w, splash.h), g = c.getContext('2d'), W = splash.w, H = splash.h;
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, PANEL); grad.addColorStop(1, BG);
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#2a303a'; g.lineWidth = 2; g.strokeRect(1, 1, W - 2, H - 2);
  g.fillStyle = RED; bar(g, 64, 70, 12, 66);
  g.font = 'italic 700 60px ' + NUM; g.textBaseline = 'alphabetic';
  g.fillStyle = TEXT; g.fillText('F1 ', 96, 128);
  g.fillStyle = RED2; g.fillText('DRIVE', 96 + g.measureText('F1 ').width, 128);
  g.font = '18px ' + UI; g.fillStyle = TEXT; g.fillText('遊戲啟動中，請稍候…', 98, 168);
  g.font = '14px ' + UI; g.fillStyle = MUTED; g.fillText('正在解壓縮遊戲檔案，每次開啟需要幾秒鐘', 98, 194);
  g.fillStyle = RED; g.fillRect(0, H - 4, W, 4);
  return { icons: icons, splash: grab(c) };
}

// ICO: 32-bit BMP images, the 256 px one as PNG (the Vista layout every Windows tool reads)
function ico(icons) {
  const imgs = icons.map(ic => {
    const s = ic.s;
    if (s >= 256) return Buffer.from(ic.png, 'base64');
    const rgba = Buffer.from(ic.rgba, 'base64'), stride = Math.ceil(s / 32) * 4;
    const out = Buffer.alloc(40 + s * s * 4 + stride * s);
    out.writeUInt32LE(40, 0); out.writeInt32LE(s, 4); out.writeInt32LE(s * 2, 8);
    out.writeUInt16LE(1, 12); out.writeUInt16LE(32, 14); out.writeUInt32LE(s * s * 4 + stride * s, 20);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = (y * s + x) * 4, o = 40 + ((s - 1 - y) * s + x) * 4;          // bottom-up, BGRA
        out[o] = rgba[i + 2]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i]; out[o + 3] = rgba[i + 3];
        if (rgba[i + 3] === 0) out[40 + s * s * 4 + (s - 1 - y) * stride + (x >> 3)] |= 0x80 >> (x & 7);   // AND mask
      }
    }
    return out;
  });
  const head = Buffer.alloc(6 + 16 * imgs.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  let off = head.length;
  icons.forEach((ic, k) => {
    const e = 6 + 16 * k;
    head[e] = ic.s >= 256 ? 0 : ic.s; head[e + 1] = ic.s >= 256 ? 0 : ic.s;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(imgs[k].length, e + 8); head.writeUInt32LE(off, e + 12);
    off += imgs[k].length;
  });
  return Buffer.concat([head].concat(imgs));
}

// BMP, 24-bit, bottom-up (what the installer's BgImage plugin shows)
function bmp(rgba, w, h) {
  const stride = Math.ceil(w * 3 / 4) * 4, out = Buffer.alloc(54 + stride * h);
  out.write('BM', 0, 'ascii'); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(stride * h, 34);
  out.writeInt32LE(2835, 38); out.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, o = 54 + (h - 1 - y) * stride + x * 3;
      out[o] = rgba[i + 2]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i];
    }
  }
  return out;
}

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'f1drive-assets-')));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let code = 0;
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8"><body></body>');
    await win.webContents.executeJavaScript('document.fonts.load(\'italic 700 60px "Bahnschrift"\').then(() => document.fonts.load(\'18px "Microsoft JhengHei"\'))');
    const r = await win.webContents.executeJavaScript('(' + draw.toString() + ')(' + JSON.stringify(ICON_SIZES) + ', ' + JSON.stringify(SPLASH) + ')');
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(r.icons));
    fs.writeFileSync(path.join(OUT, 'splash.bmp'), bmp(Buffer.from(r.splash.rgba, 'base64'), SPLASH.w, SPLASH.h));
    if (process.env.PREVIEW) {
      fs.mkdirSync(process.env.PREVIEW, { recursive: true });
      r.icons.forEach(ic => fs.writeFileSync(path.join(process.env.PREVIEW, 'icon-' + ic.s + '.png'), Buffer.from(ic.png, 'base64')));
      fs.writeFileSync(path.join(process.env.PREVIEW, 'splash.png'), Buffer.from(r.splash.png, 'base64'));
    }
    console.log('wrote build/icon.ico (' + ICON_SIZES.join(', ') + ' px) and build/splash.bmp (' + SPLASH.w + ' x ' + SPLASH.h + ')');
  } catch (e) {
    console.error(e && e.stack || e);
    code = 1;
  }
  app.exit(code);
});
