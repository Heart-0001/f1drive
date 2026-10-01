// node devtests/track-audit/apac/imagery.mjs <spec.json> -- aerial imagery with lines on top, for checking layouts by eye.
// spec: { out: "<png>", center: [lat, lon], zoom: 18, w: 1000, h: 800,
//         lines: [{ ll: [[lat, lon]...] | file: "<json>", key: "llLine", color, width, closed, label, dash }],
//         points: [{ ll: [lat, lon], color, label }] }
// Tiles: Esri World Imagery (Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community), fetched once,
// sequentially and 300 ms apart, into devtests/track-audit/cache/imagery/<z>/<x>/<y>.jpg; the page is rendered by capture.js.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, CACHE, sleep } from './common.mjs';
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const z = spec.zoom || 17, W = spec.w || 900, H = spec.h || 700, n = 2 ** z;
const px = (lat, lon) => { const x = (lon + 180) / 360 * n * 256, s = Math.sin(lat * Math.PI / 180); return [x, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256]; };
const [cx, cy] = px(spec.center[0], spec.center[1]), ox = cx - W / 2, oy = cy - H / 2;
const T = [];
for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H) / 256); ty++) for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W) / 256); tx++) {
  const f = resolve(CACHE, 'imagery', String(z), String(tx), ty + '.jpg');
  if (!existsSync(f)) {
    mkdirSync(dirname(f), { recursive: true });
    const r = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`, { headers: { 'User-Agent': 'F1Drive track audit (devtests; cached one-off reads)' } });
    if (!r.ok) { console.log('tile HTTP ' + r.status); continue; }
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    await sleep(300);
  }
  T.push({ f: pathToFileURL(f).href, x: tx * 256 - ox, y: ty * 256 - oy });
}
let svg = '';
for (const L of spec.lines || []) {
  const ll = L.ll || JSON.parse(readFileSync(resolve(ROOT, L.file), 'utf8'))[L.key || 'llLine'];
  const pts = ll.map(([a, b]) => { const [x, y] = px(a, b); return (x - ox).toFixed(1) + ',' + (y - oy).toFixed(1); }).join(' ');
  svg += `<poly${L.closed === false ? 'line' : 'gon'} points="${pts}" fill="none" stroke="${L.color || '#f00'}" stroke-width="${L.width || 2}" stroke-opacity="${L.opacity || 0.9}" ${L.dash ? 'stroke-dasharray="' + L.dash + '"' : ''}/>`;
}
for (const P of spec.points || []) {
  const [x, y] = px(P.ll[0], P.ll[1]);
  svg += `<circle cx="${x - ox}" cy="${y - oy}" r="${P.r || 5}" fill="none" stroke="${P.color || '#ff0'}" stroke-width="2"/><text x="${x - ox + 7}" y="${y - oy - 7}" fill="${P.color || '#ff0'}" font-size="14" font-family="sans-serif" stroke="#000" stroke-width="0.5">${P.label || ''}</text>`;
}
const mpp = 156543.03 * Math.cos(spec.center[0] * Math.PI / 180) / n, bar = Math.round(100 / mpp);
const legend = (spec.lines || []).map((L) => `<span style="color:${L.color}">&#9632; ${L.label || ''}</span>`).join(' &nbsp; ');
const html = `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;position:relative;background:#222">` +
  T.map((t) => `<img src="${t.f}" style="position:absolute;left:${t.x}px;top:${t.y}px;width:256px;height:256px">`).join('') +
  `<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0">${svg}<rect x="10" y="10" width="${bar}" height="5" fill="#fff"/><text x="10" y="30" fill="#fff" font-size="12" font-family="sans-serif">100 m</text></svg>` +
  `<div style="position:absolute;left:6px;bottom:4px;font:12px sans-serif;color:#fff;background:rgba(0,0,0,.6);padding:2px 6px">${legend} &nbsp;| imagery: Esri World Imagery</div></body></html>`;
const out = resolve(ROOT, spec.out), page = out.replace(/\.png$/, '.html');
writeFileSync(page, html);
const electron = resolve(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
console.log(execFileSync(electron, [resolve(ROOT, 'devtests/track-audit/apac/capture.js'), page, out, String(W), String(H)], { timeout: 90000 }).toString().trim());
