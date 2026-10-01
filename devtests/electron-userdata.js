// Shared by the Electron harnesses in devtests/: gives the app its own throw-away userData dir, so several
// harnesses (or several agents) can run at the same time without fighting over one Chromium profile.
// Call before app 'ready':  require('../electron-userdata')(app, 'some-tag');
const fs = require('fs'), os = require('os'), path = require('path');
const PREFIX = 'f1drive-ud-';
module.exports = function (app, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX + tag + '-'));
  app.setPath('userData', dir);
  // Harness windows are offscreen but their Web Audio still reaches the real speakers: mute every harness by
  // default (the audio graph keeps running, so analysers / debug values still work). SOUND=1 lets one be heard.
  if (!process.env.SOUND) {
    app.commandLine.appendSwitch('mute-audio');
    app.on('browser-window-created', (e, win) => { try { win.webContents.setAudioMuted(true); } catch (err) {} });
  }
  // Chromium's helper processes still hold files in there when the main process exits, so the removal is left
  // to a detached helper that outlives us (Electron's own binary running as plain node).
  process.on('exit', () => {
    try {
      require('child_process').spawn(process.execPath, ['-e',
        'setTimeout(function(){try{require("fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:10,retryDelay:500})}catch(e){}},1500)', dir],
        { detached: true, stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) }).unref();
    } catch (e) {}
  });
  return dir;
};
