// Security alerts for hosted sites, computed in the background from the access logs (independent of whether a
// dashboard is open). Rules:
//  - failed-login: wrong password / rate-limited sign-in. Grouped per site+IP while attempts keep coming within 10 min.
//  - new-device:   a successful sign-in from the public internet by a browser (User-Agent) never seen signed in before.
// The first run only learns existing devices (no alerts for history). State: ~/.local/state/homebase/alerts.json.
import {readdir, readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import {readLog, SITES, LOG_DIR, describeAgent} from './traffic.mjs';

const DIR = os.homedir() + '/.local/state/homebase';
const FILE = DIR + '/alerts.json';
const GROUP_MS = 10 * 60e3, MAX_ALERTS = 300, MAX_KNOWN = 2000;
let state = null, done = new Map(), running = null;

async function load() {
 if (state) return state;
 let text = null;
 try { text = await readFile(FILE, 'utf8'); state = JSON.parse(text); } catch { state = null; }
 if (!state || !Array.isArray(state.alerts)) {
  // Keep an unreadable state file for inspection instead of silently starting over.
  if (text !== null) { await rename(FILE, `${FILE}.corrupt-${Date.now()}`).catch(() => {}); console.error('alerts: state file was unreadable; saved a copy and started fresh'); }
  state = {seeded: false, lastAt: 0, knownAgents: [], alerts: []};
 }
 return state;
}
// Saves are serialized and each writes its own temp file, so overlapping scan and dashboard saves cannot interleave.
let saving = Promise.resolve();
function save() {
 const job = saving.then(async () => {
  await mkdir(DIR, {recursive: true, mode: 0o700});
  const tmp = `${FILE}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(state) + '\n', {mode: 0o600});
  await rename(tmp, FILE);
 });
 saving = job.catch(() => {});
 return job;
}
const label = r => { const a = describeAgent(r.ua); return `${a.device} · ${a.browser}`; };

async function scan() {
 const s = await load();
 const seeding = !s.seeded;
 const known = new Set(s.knownAgents);
 const names = await readdir(LOG_DIR).catch(() => []);
 const sinceDay = s.lastAt ? new Date(s.lastAt - 86400e3).toISOString().slice(0, 10) : '';
 let changed = false, maxAt = s.lastAt, fresh = 0;
 for (const site of SITES) {
  const re = new RegExp(`^${site.prefix}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  for (const name of names.filter(n => (n.match(re)?.[1] || '') >= sinceDay && re.test(n)).sort()) {
   const path = `${LOG_DIR}/${name}`, records = await readLog(path);
   // After a restart, skip what an earlier run already handled (by timestamp); within a run, by position.
   let i = done.has(path) && done.get(path) <= records.length ? done.get(path) : records.findIndex(r => r.at > s.lastAt); // file rewritten/shrunk: fall back to timestamp
   if (i < 0) i = records.length;
   for (; i < records.length; i++) {
    const r = records[i];
    maxAt = Math.max(maxAt, r.at);
    if (r.m !== 'POST' && !r.sid) continue;
    if (r.m === 'POST' && r.p === '/login' && [401, 429].includes(r.s)) {
     if (seeding) continue;
     const open = s.alerts.find(a => a.kind === 'failed-login' && a.site === site.id && a.ip === r.ip && r.at - a.lastAt < GROUP_MS);
     if (open) {
      open.count++; open.lastAt = r.at; open.read = false; if (r.s === 429) open.rateLimited = true;
      open.severity = open.count >= 5 || open.rateLimited ? 'high' : 'medium';
     } else {
      s.alerts.push({id: randomBytes(6).toString('hex'), kind: 'failed-login', site: site.id, siteName: site.name, ip: r.ip, source: r.src, device: label(r),
       count: 1, rateLimited: r.s === 429, severity: r.s === 429 ? 'high' : 'medium', at: r.at, lastAt: r.at, read: false});
      fresh++;
     }
     changed = true;
    } else if (r.sid && r.src === 'funnel' && r.ua && !known.has(r.ua)) {
     known.add(r.ua); changed = true;
     // Alert only on the sign-in itself; sessions that predate this checker are learned silently.
     if (!seeding && r.m === 'POST' && r.p === '/login' && r.s === 303) {
      s.alerts.push({id: randomBytes(6).toString('hex'), kind: 'new-device', site: site.id, siteName: site.name, ip: r.ip, source: r.src, device: label(r), ua: r.ua.slice(0, 300),
       sid: r.sid, count: 1, severity: 'medium', at: r.at, lastAt: r.at, read: false});
      fresh++;
     }
    }
   }
   done.set(path, records.length);
  }
 }
 if (seeding) { s.seeded = true; changed = true; }
 if (maxAt !== s.lastAt) { s.lastAt = maxAt; changed = true; }
 if (changed) {
  s.knownAgents = [...known].slice(-MAX_KNOWN);
  s.alerts = s.alerts.slice(-MAX_ALERTS);
  await save();
 }
 return fresh;
}

export function checkAlerts() {
 running ||= scan().catch(e => { console.error('alerts:', e.message); return 0; }).finally(() => { running = null; });
 return running;
}
export async function getAlerts() {
 const s = await load();
 return {alerts: [...s.alerts].sort((a, b) => b.lastAt - a.lastAt), unread: s.alerts.filter(a => !a.read).length, learning: !s.seeded};
}
export async function unreadAlerts() { const s = await load(); return s.alerts.filter(a => !a.read).length; }
export async function updateAlerts({action, id}) {
 const s = await load();
 if (action === 'read-all') s.alerts.forEach(a => { a.read = true; });
 else if (action === 'read' || action === 'dismiss') {
  const a = s.alerts.find(x => x.id === id);
  if (!a) throw new Error('Alert not found');
  if (action === 'read') a.read = true; else s.alerts = s.alerts.filter(x => x !== a);
 } else if (action === 'clear-read') s.alerts = s.alerts.filter(a => !a.read);
 else throw new Error('Unsupported action');
 await save();
 return getAlerts();
}
