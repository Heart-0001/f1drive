// F1Drive overnight watchdog: is the multi-agent work still moving, and if not, where did it stop?
//   node tools/watchdog.mjs [--stall 25] [--session <dir>] [--quiet]
// Looks at the Claude Code session's workflow transcripts (which agents are running, when each last wrote
// anything), the helper processes (Electron / node left behind by test harnesses), the machine (disk, memory,
// keep-awake helper) and the build output. Writes tools/watchdog-out/status.md (the page to read in the
// morning), appends one line to tools/watchdog-out/log.txt and prints a short summary.
// Exit code: 0 = work is moving, 2 = an agent looks stalled, 3 = nothing is running (someone must start the
// next stage), 4 = the watchdog itself could not find the session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', 'watchdog-out');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const STALL_MIN = Number(opt('stall', 25));        // an agent's transcript untouched this long = stalled
const QUIET = args.includes('--quiet');
const now = Date.now();
const mins = ms => Math.round(ms / 6000) / 10;
const hhmm = t => new Date(t).toTimeString().slice(0, 8);

function findSession() {
  const given = opt('session', null);
  if (given) return given;
  // ~/.claude/projects/<cwd with separators as dashes>/<session id>/subagents/workflows
  const base = path.join(os.homedir(), '.claude', 'projects');
  let best = null;
  for (const proj of safeDir(base)) {
    if (!/f1Drive/i.test(proj)) continue;
    for (const ses of safeDir(path.join(base, proj))) {
      const wf = path.join(base, proj, ses, 'subagents', 'workflows');
      if (!fs.existsSync(wf)) continue;
      const m = newest(wf);
      if (!best || m > best.m) best = { dir: path.join(base, proj, ses), m };
    }
  }
  return best && best.dir;
}
function safeDir(d) { try { return fs.readdirSync(d); } catch (e) { return []; } }
function newest(dir) {
  let m = 0;
  for (const f of safeDir(dir)) {
    try {
      const st = fs.statSync(path.join(dir, f));
      m = Math.max(m, st.isDirectory() ? newest(path.join(dir, f)) : st.mtimeMs);
    } catch (e) { /* vanished */ }
  }
  return m;
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
// last thing an agent did, from the tail of its transcript (cheap: only the last 200 KB are read)
function lastAction(file) {
  try {
    const st = fs.statSync(file), fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 200000), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let j; try { j = JSON.parse(lines[i]); } catch (e) { continue; }
      const c = j.message && j.message.content;
      if (!Array.isArray(c)) continue;
      for (let k = c.length - 1; k >= 0; k--) {
        const b = c[k];
        if (b.type === 'tool_use') return 'tool ' + b.name + ': ' + String(b.input.description || b.input.file_path || b.input.command || '').slice(0, 110);
        if (b.type === 'text' && b.text.trim()) return 'text: ' + b.text.trim().replace(/\s+/g, ' ').slice(0, 110);
      }
    }
  } catch (e) { /* unreadable */ }
  return '?';
}

function workflows(session) {
  const base = path.join(session, 'subagents', 'workflows'), list = [];
  for (const id of safeDir(base)) {
    const dir = path.join(base, id), journal = readJsonl(path.join(dir, 'journal.jsonl'));
    const started = journal.filter(l => l.type === 'started'), done = new Set(journal.filter(l => l.type === 'result').map(l => l.key));
    const agents = started.map(s => {
      const file = path.join(dir, 'agent-' + s.agentId + '.jsonl');
      let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch (e) { /* not written yet */ }
      return { label: s.label, phase: s.phase, id: s.agentId, running: !done.has(s.key), mtime, idleMin: mtime ? mins(now - mtime) : null, file };
    });
    // an agent re-run after a resume appears twice: only the newest "started" of a label can be running
    const seen = new Set();
    for (let i = agents.length - 1; i >= 0; i--) {
      if (seen.has(agents[i].label)) agents[i].running = false;
      seen.add(agents[i].label);
    }
    let name = id;
    try {
      const scripts = path.join(session, 'workflows', 'scripts');
      const f = safeDir(scripts).find(n => n.includes(id));
      if (f) name = f.replace('-' + id + '.js', '');
    } catch (e) { /* no scripts dir */ }
    list.push({ id, name, agents, lastWrite: newest(dir) });
  }
  return list.sort((a, b) => a.lastWrite - b.lastWrite);
}

function processes() {
  // name, pid, start time, working set — via PowerShell (tasklist has no start time)
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-Process electron,node,F1Drive -ErrorAction SilentlyContinue | ForEach-Object { $age = -1; if ($_.StartTime) { $age = [int]((Get-Date) - $_.StartTime).TotalMinutes }; '{0}|{1}|{2}|{3}' -f $_.ProcessName,$_.Id,$age,[int]($_.WorkingSet64/1MB) }"],
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseProcs(out);
  } catch (e) { return e && e.stdout ? parseProcs(String(e.stdout)) : null; }   // a protected process makes PowerShell exit non-zero
}
function parseProcs(out) {
  return out.split(/\r?\n/).filter(l => /^[^|]+\|\d+\|-?\d+\|\d+$/.test(l.trim())).map(l => {
    const [name, pid, age, mb] = l.trim().split('|');
    return { name, pid: +pid, ageMin: +age, mb: +mb };
  });
}
function diskFreeGb() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "[int]((Get-PSDrive " + ROOT[0] + ").Free/1GB)"], { encoding: 'utf8', timeout: 20000 });
    return Number(out.trim());
  } catch (e) { return null; }
}
function keepAwake() {
  try {
    const pid = Number(fs.readFileSync(path.join(OUT, 'keepawake.pid'), 'utf8').trim());
    process.kill(pid, 0);
    return pid;
  } catch (e) { return 0; }
}

const session = findSession();
fs.mkdirSync(OUT, { recursive: true });
if (!session) {
  console.log('WATCHDOG: no Claude session with workflows found');
  process.exit(4);
}
const wfs = workflows(session);
// workflow ids listed in tools/watchdog-out/ignore.txt (one per line) are treated as finished
const ignored = new Set((() => { try { return fs.readFileSync(path.join(OUT, 'ignore.txt'), 'utf8').split(/s+/).filter(Boolean); } catch (e) { return []; } })());
const running = [], stalled = [];
for (const w of wfs) for (const a of w.agents) if (a.running) {
  a.last = lastAction(a.file);
  // a workflow stopped on purpose (TaskStop) leaves its agents 'started' for ever: their last line says so
  if (/Request interrupted/.test(a.last) || ignored.has(w.id)) { a.running = false; a.stopped = true; continue; }
  running.push({ w, a });
  if (a.idleMin === null ? now - w.lastWrite > STALL_MIN * 60000 : a.idleMin > STALL_MIN) stalled.push({ w, a });
}
const procs = processes();
const oldElectron = procs ? procs.filter(p => /electron/i.test(p.name) && p.ageMin > 45) : [];
const free = diskFreeGb(), awake = keepAwake();
let exe = null;
try { const st = fs.statSync(path.join(ROOT, 'dist', 'F1Drive.exe')); exe = { mb: Math.round(st.size / 1048576), at: st.mtime }; } catch (e) { /* not built */ }
// every packaged exe in dist/ (e.g. the interim v5 build next to the final one)
const exes = safeDir(path.join(ROOT, 'dist')).filter(f => /\.exe$/i.test(f)).map(f => {
  const st = fs.statSync(path.join(ROOT, 'dist', f));
  return f + ' (' + Math.round(st.size / 1048576) + ' MB, ' + st.mtime.toLocaleString() + ')';
});

let verdict, code;
if (stalled.length) { verdict = 'STALL: ' + stalled.map(s => s.a.label + ' (' + s.a.idleMin + ' min silent)').join(', '); code = 2; }
else if (!running.length) { verdict = 'IDLE: no agent is running'; code = 3; }
else { verdict = 'OK: ' + running.length + ' agent(s) working'; code = 0; }
const warn = [];
if (free !== null && free < 5) warn.push('disk almost full: ' + free + ' GB free');
if (os.freemem() < 1.5e9) warn.push('low memory: ' + Math.round(os.freemem() / 1048576) + ' MB free');
if (oldElectron.length) warn.push(oldElectron.length + ' Electron process(es) older than 45 min (orphaned harness?): pids ' + oldElectron.map(p => p.pid).join(' '));
if (!awake) warn.push('keep-awake helper is not running (the PC may go to sleep)');

const L = [];
L.push('# F1Drive watchdog — ' + new Date(now).toLocaleString());
L.push('', '**' + verdict + '**', '');
if (warn.length) { L.push('Warnings:'); warn.forEach(w => L.push('- ' + w)); L.push(''); }
L.push('## Workflows (oldest activity first)', '');
for (const w of wfs) {
  const run = w.agents.filter(a => a.running).length, fin = w.agents.length - run;
  L.push('### ' + w.name + ' — ' + fin + ' done, ' + run + ' running — last write ' + hhmm(w.lastWrite) + ' (' + mins(now - w.lastWrite) + ' min ago)');
  for (const a of w.agents) {
    L.push('- ' + (a.running ? '**running**' : (a.stopped ? 'stopped' : 'done')) + ' · ' + a.label + (a.running ? ' · silent ' + (a.idleMin === null ? '?' : a.idleMin) + ' min · ' + (a.last || '') : ''));
  }
  L.push('');
}
L.push('## Machine', '');
L.push('- disk free: ' + (free === null ? '?' : free + ' GB') + ', memory free: ' + Math.round(os.freemem() / 1048576) + ' MB, uptime: ' + Math.round(os.uptime() / 3600 * 10) / 10 + ' h');
L.push('- keep-awake helper: ' + (awake ? 'running (pid ' + awake + ')' : 'NOT running'));
if (procs) L.push('- processes: ' + (procs.length ? procs.map(p => p.name + '#' + p.pid + ' ' + p.ageMin + 'min ' + p.mb + 'MB').join(', ') : 'none'));
L.push('- dist/F1Drive.exe: ' + (exe ? exe.mb + ' MB, built ' + exe.at.toLocaleString() : 'not built yet') + (exes.length ? ' · all builds in dist/: ' + exes.join(', ') : ''));
fs.writeFileSync(path.join(OUT, 'status.md'), L.join('\n') + '\n');
fs.appendFileSync(path.join(OUT, 'log.txt'), new Date(now).toISOString() + ' ' + verdict + (warn.length ? ' | ' + warn.join('; ') : '') + '\n');

if (!QUIET) {
  console.log(verdict);
  warn.forEach(w => console.log('WARN ' + w));
  for (const { w, a } of running) console.log('  ' + w.name + ' / ' + a.label + ' — silent ' + a.idleMin + ' min — ' + a.last);
  console.log('exe: ' + (exe ? exe.mb + ' MB, ' + exe.at.toLocaleString() : 'final not built yet') + (exes.length ? ' | dist: ' + exes.join(', ') : '') + ' | status: tools/watchdog-out/status.md');
}
process.exit(code);
