// node devtests/track-audit/west/ovp.mjs <cache-name> "<overpass QL>"
// One Overpass query, cached in devtests/track-audit/cache/overpass/<cache-name>.json (reused when present).
// overpass-api.de was not answering on 2026-10-01 15:30 (connections timing out while ~8 audit agents queried it), so
// the VK mirror (maps.mail.ru) is tried first, then the main instance. One query at a time; back off on 429 / 504.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE, sleep } from './net.mjs';

export async function ovp(name, query) {
  const dir = resolve(CACHE, 'overpass');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, name + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const hosts = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter'];
  for (let a = 0; a < 8; a++) {
    const host = hosts[a % hosts.length];
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 120000);
      const res = await fetch(host, { method: 'POST', signal: ctl.signal,
        headers: { 'User-Agent': 'F1Drive-track-audit/1 (cached one-off queries)', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query) });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json();
        j._query = query; j._host = host; j._fetched = new Date().toISOString();
        writeFileSync(file, JSON.stringify(j));
        return j;
      }
      console.warn(`overpass ${name}: HTTP ${res.status} on ${host}`);
      await sleep(res.status === 429 || res.status === 504 ? 20000 * (a + 1) : 5000);
    } catch (e) {
      console.warn(`overpass ${name}: ${e.message} on ${host}`);
      await sleep(5000);
    }
  }
  throw new Error('overpass failed: ' + name);
}

if (process.argv[1] && process.argv[1].endsWith('ovp.mjs')) {
  const [name, q] = process.argv.slice(2);
  const j = await ovp(name, q);
  console.log(name, j.elements.length, 'elements from', j._host);
}
