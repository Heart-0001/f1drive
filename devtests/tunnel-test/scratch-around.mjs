// scratch: buildings / man_made / bridges around given points (Overpass), printed with their tags
const pts = JSON.parse(process.argv[2]);
const q = `[out:json][timeout:60];(${pts.map(([la, lo]) => `way(around:3,${la},${lo})["building"];way(around:3,${la},${lo})["building:part"];way(around:3,${la},${lo})["man_made"];relation(around:3,${la},${lo})["building"];`).join('')});out tags center;`;
const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'F1Drive-tunnel-test/1 (one-off check)', 'Accept': 'application/json' } });
const txt = await res.text(); let j; try { j = JSON.parse(txt); } catch (e) { console.log(txt.slice(0, 600)); process.exit(1); }
for (const e of j.elements) console.log(e.type, e.id, JSON.stringify(e.tags));
