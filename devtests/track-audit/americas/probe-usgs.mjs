// one-off probe of the USGS 3DEP ImageServer getSamples (3 points at COTA, cached through net.mjs)
import { usgs3dep } from './net.mjs';
const v = await usgs3dep([[30.13176, -97.639651], [30.1331467, -97.6417007], [30.1303719, -97.637603]]);
console.log(v);
