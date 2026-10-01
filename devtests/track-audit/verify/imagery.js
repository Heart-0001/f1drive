// node devtests/track-audit/verify/imagery.js <name> <id> <lat> <lon> <z> <tilesW> <tilesH> [s:label ...] [ll:lat,lon:label ...]
// Esri World Imagery mosaic around lat/lon with the game's built centreline (yellow), its walls (thin cyan), and
// markers at game arc lengths s (red, labelled) or at lat/lon points (magenta). Tiles cached in cache/imagery/z/x/y.jpg
// (shared with the apac audit; fetched 300 ms apart when missing). Writes cache/verify/img/<name>.html; render with
//   npx electron devtests/track-audit/verify/capture.js cache/verify/img/<name>.html cache/verify/img/<name>.png W H
'use strict';
const L = require('./lib.js');
const fs = L.fs, path = L.path;
const [name, id, lat0, lon0, zs, tw, th, ...marks] = process.argv.slice(2);
const z = +zs, TW = +tw, TH = +th;
const n2 = 2 ** z;
const tx = (lon) => (lon + 180) / 360 * n2;
const ty = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n2; };
const cx = tx(+lon0), cy = ty(+lat0), x0 = Math.floor(cx - TW / 2), y0 = Math.floor(cy - TH / 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const imgs = [];
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    const X = x0 + i, Y = y0 + j, f = path.join(L.CACHE, 'imagery', String(z), String(X), Y + '.jpg');
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const r = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${Y}/${X}`, { headers: { 'User-Agent': 'F1Drive-track-audit/1' } });
      if (!r.ok) { console.warn('tile', z, X, Y, r.status); continue; }
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      await sleep(300);
    }
    imgs.push(`<img src="file:///${f.replace(/\\/g, '/')}" style="position:absolute;left:${i * 256}px;top:${j * 256}px;width:256px;height:256px">`);
  }
  const g = L.game(id);
  const px = (la, lo) => [(tx(lo) - x0) * 256, (ty(la) - y0) * 256];
  const line = (arr) => arr.map((q) => px(...q).map((v) => v.toFixed(1)).join(',')).join(' ');
  const W = TW * 256, H = TH * 256;
  const centre = [], wl = [], wr = [];
  for (const s of g.S) {
    centre.push(g.ll(s.x, s.z));
    wl.push(g.ll(s.x + s.nx * s.halfW, s.z + s.nz * s.halfW)); wr.push(g.ll(s.x - s.nx * s.halfW, s.z - s.nz * s.halfW));
  }
  const inView = (q) => { const [a, b] = px(...q); return a > -200 && a < W + 200 && b > -200 && b < H + 200; };
  const seg = (arr) => { const out = [], cur = []; for (const q of arr) { if (inView(q)) cur.push(q); else if (cur.length) { out.push(cur.splice(0)); } } if (cur.length) out.push(cur); return out; };
  let svg = '';
  for (const part of seg(wl).concat(seg(wr))) svg += `<polyline points="${line(part)}" fill="none" stroke="#0ff" stroke-width="1" opacity="0.6"/>`;
  for (const part of seg(centre)) svg += `<polyline points="${line(part)}" fill="none" stroke="#ff0" stroke-width="1.5" opacity="0.8"/>`;
  for (const m of marks) {
    let la, lo, label, col = '#f22';
    if (m.startsWith('ll:')) { const [, c, lab] = m.split(':'); [la, lo] = c.split(',').map(Number); label = lab || ''; col = '#f0f'; }
    else {
      const [sv, lab] = m.split(':'); const s = ((+sv % g.L) + g.L) % g.L, q = g.at(s);
      // a tick across the road at s
      const a = g.ll(q.x + q.nx * 9, q.z + q.nz * 9), b = g.ll(q.x - q.nx * 9, q.z - q.nz * 9);
      const [ax, ay] = px(...a), [bx, by] = px(...b);
      svg += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${col}" stroke-width="2"/>`;
      [la, lo] = g.ll(q.x + q.nx * 14, q.z + q.nz * 14); label = (lab || '') + ' s' + sv;
    }
    const [mx, my] = px(la, lo);
    svg += `<circle cx="${mx}" cy="${my}" r="3" fill="${col}"/><text x="${mx + 5}" y="${my - 5}" fill="${col}" font-size="13" font-family="sans-serif" stroke="#000" stroke-width="0.4">${label}</text>`;
  }
  const mpp = 156543.03392 * Math.cos(+lat0 * Math.PI / 180) / n2;
  svg += `<line x1="10" y1="${H - 15}" x2="${10 + 50 / mpp}" y2="${H - 15}" stroke="#fff" stroke-width="3"/><text x="12" y="${H - 20}" fill="#fff" font-size="12">50 m</text>`;
  const html = `<!doctype html><html><body style="margin:0;background:#000"><div style="position:relative;width:${W}px;height:${H}px">${imgs.join('')}<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0">${svg}</svg></div></body></html>`;
  const dir = path.join(L.CACHE, 'verify', 'img'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.html'), html);
  console.log('wrote', path.join(dir, name + '.html'), W, H, 'm/px', mpp.toFixed(3));
})();
