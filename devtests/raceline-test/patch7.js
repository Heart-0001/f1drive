const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
const a=s.indexOf("      // warning ramp: yellow creeps in"), b=s.indexOf("      // write colours for the visible window");
if(a<0||b<0) throw 1;
s=s.slice(0,a)+`      // warning ramp: the line turns yellow-green shortly before a real braking zone. It stays below
      // "lift" (0.5) and is not seeded by lift-only zones, otherwise a car that is under the limit would be
      // told to coast all the way down a long (uphill) braking curve.
      var lead = Math.round(LEAD_TIME * Math.abs(carState.speed || 0) / ds);
      if (lead < 3) lead = 3;
      var step = WARN_LEVEL / lead, ramp = 0;
      for (m = LV - 1; m >= 0; m--) {
        if (levels[m] >= 0.58) ramp = WARN_LEVEL + step;
        else if (ramp > 0) {
          ramp -= step;
          if (levels[m] < ramp) levels[m] = ramp;
        }
      }

`+s.slice(b);
s=s.replace("  var LEAD_TIME = 0.45;       // s of yellow warning before a braking zone","  var LEAD_TIME = 0.45;       // s of warning before a braking zone\n  var WARN_LEVEL = 0.42;      // level the warning ramps up to (0.5 = yellow / lift)");
if(!s.includes("WARN_LEVEL = 0.42")) throw 2;
fs.writeFileSync(f,s);
for (const t of ['test.js','test3.js','dbg.js']) { let x=fs.readFileSync(t,'utf8'); if(!x.includes("lv < 0.25")) throw t; x=x.replace("lv < 0.25","lv < 0.45"); fs.writeFileSync(t,x); }
