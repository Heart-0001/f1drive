// npx electron devtests/car-v6/smoke-wrap.js [harness, default devtests/gp-smoke/smoke.js]   (env as that harness, e.g. ONLY=free,solo)
//
// Runs an Electron harness of the real game unchanged, except that the page is a copy of index.html without the
// <script> tags whose files do not exist yet (v6: js/seasons-data.js and js/cars.js come from a later stage; the page's
// error handler turns a missing script into the error overlay, which stops every harness at the boot check).
// The copy goes to devtests/car-v6/out/index-game.html with a <base> pointing at the project. Prints which tags were
// dropped. Everything else (preload, main.js, the harness's checks and exit code) is the harness's own.
'use strict';
const { BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'index.html');
const OUT = path.join(__dirname, 'out');

function copy() {
  let html = fs.readFileSync(INDEX, 'utf8');
  const dropped = [];
  html = html.replace(/<script src="([^"]+)"><\/script>\s*/g, (tag, src) => {
    if (fs.existsSync(path.join(ROOT, src))) return tag;
    dropped.push(src);
    return '';
  });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'index-game.html');
  fs.writeFileSync(file, html.replace('<head>', '<head><base href="' + url.pathToFileURL(ROOT + path.sep).href + '">'));
  if (!copy.told) { copy.told = true; console.log('[smoke-wrap] index.html without the missing scripts: ' + (dropped.join(', ') || 'none missing')); }
  return file;
}

// the generated page is not kept (the screenshots are git-ignored, an .html would not be)
process.on('exit', () => { try { fs.unlinkSync(path.join(OUT, 'index-game.html')); } catch (e) { /* not written */ } });
const load = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  if (path.resolve(file) === INDEX) file = copy();
  return load.call(this, file, opts);
};
require(path.resolve(ROOT, process.argv.slice(2).find(a => /\.js$/.test(a) && !/smoke-wrap\.js$/.test(a)) || 'devtests/gp-smoke/smoke.js'));
