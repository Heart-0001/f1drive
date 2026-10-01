// Proof that an Electron harness stays SILENT (the user sits at this computer and must not hear the harness windows'
// engines). devtests/electron-userdata.js mutes every harness window (Chromium --mute-audio + webContents.setAudioMuted;
// the page's Web Audio graph still runs) unless SOUND=1; this checks it while the harness runs, from both sides:
//   inside   every BrowserWindow of the app, sampled every 250 ms: webContents.isAudioMuted() must be true and
//            webContents.isCurrentlyAudible() false
//   outside  devtests/gp-e2e/mixer-watch.ps1 = what the Windows volume mixer shows: every audio session on every active
//            playback device, peak meter sampled every 100 ms; no session of this process tree may show a peak above 0
//            (with --mute-audio Chromium does not even open one)
// Usage (Electron main process, after app ready):
//   const silence = require('./silence')(app, 'tag');  ...  const r = await silence.finish();  check(r.text, r.ok, r.detail)
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

module.exports = function watchSilence(app, tag) {
  const out = path.join(os.tmpdir(), 'f1drive-mixer-' + tag + '-' + process.pid + '.json'), stopFile = out + '.stop';
  const t0 = Date.now(), wins = [];
  const inside = { samples: 0, windows: 0, unmuted: 0, audible: 0, firstBad: null };
  let proc = null, startErr = '';
  try { fs.unlinkSync(out); } catch (e) {}
  try { fs.unlinkSync(stopFile); } catch (e) {}
  if (process.platform === 'win32') {
    try {
      proc = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'mixer-watch.ps1'),
        '-Root', String(process.pid), '-Out', out, '-Stop', stopFile, '-IntervalMs', '100'], { stdio: 'ignore', windowsHide: true });
      proc.on('error', e => { startErr = String(e); });
    } catch (e) { startErr = String(e); }
  } else startErr = 'not Windows: no volume mixer to read';

  // (windows created before this was called are found through BrowserWindow.getAllWindows)
  const { BrowserWindow } = require('electron');
  const seen = new Set();
  const sample = () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!seen.has(w.id)) { seen.add(w.id); inside.windows++; }
      if (w.isDestroyed()) continue;
      const wc = w.webContents;
      inside.samples++;
      const muted = wc.isAudioMuted(), audible = wc.isCurrentlyAudible();
      if (!muted) inside.unmuted++;
      if (audible) inside.audible++;
      if ((!muted || audible) && !inside.firstBad) inside.firstBad = { t: Date.now() - t0, muted, audible, url: wc.getURL().split('/').pop() };
    }
  };
  app.on('browser-window-created', (e, w) => { setImmediate(sample); });
  const timer = setInterval(sample, 250);

  return {
    sample,
    async finish() {
      clearInterval(timer);
      sample();
      const sw = app.commandLine.hasSwitch('mute-audio');
      let mixer = null;
      if (proc && !startErr) {
        try { fs.writeFileSync(stopFile, 'stop'); } catch (e) {}
        for (let k = 0; k < 80 && !fs.existsSync(out); k++) await new Promise(r => setTimeout(r, 100));
        try { mixer = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^﻿/, '')); } catch (e) { mixer = { error: 'no mixer output: ' + e.message }; }
        try { proc.kill(); } catch (e) {}
      }
      try { fs.unlinkSync(out); } catch (e) {}
      try { fs.unlinkSync(stopFile); } catch (e) {}
      const ours = mixer && Array.isArray(mixer.sessions) ? mixer.sessions.filter(s => s.ours) : [];
      const loud = ours.filter(s => s.maxPeak > 0);
      const mixerOk = !!mixer && !mixer.error && mixer.samples > 0 && loud.length === 0;
      const insideOk = sw && !process.env.SOUND && inside.samples > 0 && inside.unmuted === 0 && inside.audible === 0;
      const ok = insideOk && (mixerOk || !!startErr && process.platform !== 'win32');
      const text = 'SILENT for the whole run (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s): --mute-audio ' + (sw ? 'on' : 'OFF') + ', SOUND ' + (process.env.SOUND ? 'SET' : 'unset') +
        '; ' + inside.windows + ' window(s), ' + inside.samples + ' samples: muted in every one, never audible; Windows volume mixer: ' +
        (mixer && !mixer.error ? mixer.samples + ' samples over ' + mixer.seconds + ' s, ' + ours.length + ' audio session(s) of this process tree' + (ours.length ? ', peak max ' + Math.max.apply(null, ours.map(s => s.maxPeak)) : ' (none opened)') :
          'NOT READ (' + (startErr || (mixer && mixer.error) || '?') + ')');
      return { ok, text, detail: { switch: sw, sound: process.env.SOUND || null, inside, mixer: mixer ? { samples: mixer.samples, seconds: mixer.seconds, error: mixer.error, ours, others: (mixer.sessions || []).filter(s => !s.ours && s.maxPeak > 0).map(s => s.name) } : null, startErr } };
    }
  };
};
