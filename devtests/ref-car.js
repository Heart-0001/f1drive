// Shared by the Electron harnesses in devtests/ (main process). Since v6.1 (2026-10-01) a fresh install opens on the 2026
// season and drives its standard car (START_YEAR in js/main.js). The harnesses whose checks, autopilots and timings were
// written for the reference car (F1.REF_SPEC = '2025-standard', the v5 car: the golden rule, the line autopilots, the
// lap-time ground truths ...) pick it EXPLICITLY before the game boots, exactly as a player who chose it in the 車輛 tab
// earlier: the menu's stored choice (localStorage 'f1drive.car' of js/ui.js) is written into the window's storage first.
// Every file:// page shares one localStorage (per partition), so a blank page next to this file carries the write.
//
//   const refCar = require('../ref-car');
//   await refCar.seed(win);                                   // BEFORE win.loadFile(index.html): 2025, '2025-standard'
//   await refCar.seed(win, { year: 2014, car: null });        // another pick (car null: that season's standard car)
'use strict';
const path = require('path');
const BLANK = path.join(__dirname, 'ref-car.html');
const KEY = 'f1drive.car';
const REF = { year: 2025, car: '2025-standard' };

async function seed(win, pick) {
  pick = pick || REF;
  await win.loadFile(BLANK);
  const value = JSON.stringify({ year: pick.year, car: pick.car === undefined ? null : pick.car });
  const got = await win.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(value)}); localStorage.getItem(${JSON.stringify(KEY)})`);
  if (got !== value) throw new Error('ref-car: could not seed ' + KEY + ' (got ' + got + ')');
  return value;
}

module.exports = { seed, REF, KEY, BLANK };
