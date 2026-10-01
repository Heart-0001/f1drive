// Runs another Electron harness with every project script that does not exist yet served as an empty script (so the
// page boots without the 無法載入程式檔 overlay while other owners are still writing js/seasons-data.js, js/cars.js, ...).
// Every session gets the handler (harnesses with several windows give each its own partition). Harness-side only:
// nothing in the project changes.
//   npx electron devtests/ui-v6/with-stubs.js devtests/ui-gp/shots.js      (env of the target harness passes through)
const { app, session } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const target = process.argv.slice(2).filter(a => /\.js$/.test(a) && !/with-stubs\.js$/.test(a)).pop();
if (!target) { console.error('usage: npx electron devtests/ui-v6/with-stubs.js <harness.js>'); process.exit(2); }

const stubbed = new Set();
function stub(ses) {
  ses.protocol.handle('file', req => {
    const file = url.fileURLToPath(req.url);
    if (/\.js$/.test(file) && file.startsWith(ROOT + path.sep) && !fs.existsSync(file)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (!stubbed.has(rel)) { stubbed.add(rel); console.log('[with-stubs] empty script for ' + rel); }
      return new Response('/* stub: ' + rel + ' does not exist yet */', { headers: { 'content-type': 'text/javascript' } });
    }
    return ses.fetch(req, { bypassCustomProtocolHandlers: true });
  });
}
app.on('session-created', ses => { try { stub(ses); } catch (e) { console.log('[with-stubs] ' + e.message); } });
app.whenReady().then(() => { try { stub(session.defaultSession); } catch (e) { /* already handled through session-created */ } });
require(path.resolve(target));
