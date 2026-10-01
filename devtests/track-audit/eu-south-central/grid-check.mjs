// node grid-check.mjs : the Hungaroring grid / start line once more from the 2025 Hungarian GP (cross-check of 2026)
import { lt } from './lt.mjs';
const o = await lt('hu-1986', { q: '2025/2025-08-03_Hungarian_Grand_Prix/2025-08-02_Qualifying/', r: '2025/2025-08-03_Hungarian_Grand_Prix/2025-08-03_Race/' }, '-2025');
console.log(JSON.stringify({ fit: o.fit, grid: { ...o.grid, slots: o.grid && o.grid.slots && o.grid.slots.slice(0, 4) }, zRange: Math.max(...o.z) - Math.min(...o.z) }));
