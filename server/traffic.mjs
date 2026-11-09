// Access analytics for hosted sites: reads per-day JSONL access logs written by the site servers,
// plus Tailscale device/route state. The only write is the access-control file (signed-out sessions, blocked IPs),
// which the site servers re-read within a second.
import {open, readdir, stat, readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {isIP} from 'node:net';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {config} from './config.mjs';

// Sites, their access-log directory and the shared access-control file come from the Homebase config.
// Each site server writes <logDir>/<prefix>-YYYY-MM-DD.jsonl and re-reads the control file.
export const LOG_DIR = config.traffic.logDir;
export const SITES = config.traffic.sites;
const CONTROL_FILE = config.traffic.controlFile;
const SESSION_DAYS = 30;

export async function readControl() {
 try { const c = JSON.parse(await readFile(CONTROL_FILE, 'utf8')); return {revoked: Array.isArray(c.revoked) ? c.revoked : [], blocked: Array.isArray(c.blocked) ? c.blocked : [], revokedBefore: typeof c.revokedBefore === 'string' ? c.revokedBefore : null}; }
 catch (e) { if (e.code === 'ENOENT') return {revoked: [], blocked: [], revokedBefore: null}; throw new Error('Access-control file is unreadable: ' + e.message); }
}
let writing = Promise.resolve();
// Serialized read-modify-write with an atomic rename so the site never sees a half-written file.
export function updateControl({action, sid, sids, ip, label}) {
 const job = writing.then(async () => {
  const c = await readControl(), at = new Date().toISOString();
  label = typeof label === 'string' ? label.slice(0, 120) : '';
  if (action === 'revoke' || action === 'restore') {
   const list = [...new Set(Array.isArray(sids) ? sids : [sid])];
   if (!list.length || list.length > 200 || !list.every(x => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x))) throw new Error('Invalid session');
   const group = list.length > 1 ? list[0] : undefined; // shown as one entry: the device, not each sign-in
   c.revoked = c.revoked.filter(x => !list.includes(x.sid));
   if (action === 'revoke') for (const x of list) c.revoked.push({sid: x, at, label, ...(group ? {group} : {})});
  } else if (action === 'block' || action === 'unblock') {
   if (!isIP(ip || '')) throw new Error('Invalid IP address');
   if (action === 'block') {
    const self = (await tailscaleState()).devices.find(d => d.self);
    const own = new Set(['127.0.0.1', '::1', ...(self?.ips || [])]);
    if (own.has(ip)) throw new Error('That address is this server; blocking it would lock out every local and tailnet request.');
   }
   c.blocked = c.blocked.filter(x => x.ip !== ip);
   if (action === 'block') c.blocked.push({ip, at, label});
  } else if (action === 'revoke-all') c.revokedBefore = at; // every session issued before now is refused
  else if (action === 'undo-revoke-all') c.revokedBefore = null;
  else throw new Error('Unsupported action');
  const cutoff = Date.now() - (SESSION_DAYS + 1) * 86400e3; // a revoked session expires on its own after 30 days
  c.revoked = c.revoked.filter(x => !Date.parse(x.at) || Date.parse(x.at) > cutoff);
  if (c.revokedBefore && Date.parse(c.revokedBefore) < cutoff) c.revokedBefore = null;
  if (!c.revokedBefore) delete c.revokedBefore;
  await mkdir(path.dirname(CONTROL_FILE), {recursive: true, mode: 0o700});
  const tmp = CONTROL_FILE + '.tmp-' + process.pid;
  await writeFile(tmp, JSON.stringify(c, null, 1) + '\n', {mode: 0o600});
  await rename(tmp, CONTROL_FILE);
  return c;
 });
 writing = job.catch(() => {});
 return job;
}

const RANGES = {'24h': {hours: 24, bucket: 3600e3}, '7d': {hours: 168, bucket: 6 * 3600e3}, '30d': {hours: 720, bucket: 86400e3}};
const POLL = new Set(['/status.json', '/data.json', '/service-worker.js']);
const PAGE = new Set(['/', '/index.html']);
const ONLINE_MS = 2 * 60e3;

const run = (bin, args) => new Promise(r => execFile(bin, args, {timeout: 8000, maxBuffer: 8 * 1024 * 1024}, (e, out) => r(e ? null : out)));

// Per-file incremental cache: re-reads only bytes appended since the last call.
const files = new Map();
export async function readLog(path) {
 let st; try { st = await stat(path); } catch { files.delete(path); return []; }
 let c = files.get(path);
 if (!c || st.size < c.size || st.ino !== c.ino) c = {size: 0, ino: st.ino, rest: '', records: []};
 if (st.size > c.size) {
  const fh = await open(path, 'r');
  try {
   const buf = Buffer.alloc(st.size - c.size);
   await fh.read(buf, 0, buf.length, c.size);
   const lines = (c.rest + buf.toString('utf8')).split('\n');
   c.rest = lines.pop() || '';
   for (const l of lines) { try { const r = JSON.parse(l); r.at = Date.parse(r.t); if (Number.isFinite(r.at)) c.records.push(r); } catch {} }
   c.size = st.size;
  } finally { await fh.close(); }
 }
 files.set(path, c);
 return c.records;
}

export function describeAgent(ua = '') {
 if (!ua) return {device: 'Unknown', browser: 'Unknown', kind: 'other', bot: false};
 const bot = /bot|crawl|spider|slurp|curl|wget|python|go-http|headless|preview|facebookexternalhit|zalo.*preview/i.test(ua);
 const device = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
  : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : /curl/i.test(ua) ? 'Command line' : 'Unknown';
 const browser = /Zalo/i.test(ua) ? 'Zalo' : /FBAN|FBAV|Messenger/.test(ua) ? 'Facebook' : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera'
  : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : ua.split(/[ /]/)[0].slice(0, 24);
 const kind = bot ? 'bot' : /iPhone|Android.*Mobile/.test(ua) ? 'phone' : /iPad|Android/.test(ua) ? 'tablet' : device === 'Unknown' ? 'other' : 'desktop';
 return {device, browser, kind, bot};
}

let tsCache = {at: 0, value: null};
export async function tailscaleState() {
 if (Date.now() - tsCache.at < 15000 && tsCache.value) return tsCache.value;
 const [status, serve] = await Promise.all([run('tailscale', ['status', '--json']), run('tailscale', ['serve', 'status', '--json'])]);
 let devices = [], routes = [], self = null, error = null;
 try {
  const s = JSON.parse(status);
  const map = n => ({name: (n.DNSName || '').split('.')[0] || n.HostName, dns: (n.DNSName || '').replace(/\.$/, ''), os: n.OS, ips: n.TailscaleIPs || [], online: !!n.Online, active: !!n.Active,
   lastSeen: n.LastSeen && !n.LastSeen.startsWith('0001') ? n.LastSeen : null, rx: n.RxBytes || 0, tx: n.TxBytes || 0,
   connection: n.CurAddr ? 'direct' : n.Relay ? `relay (${n.Relay})` : null, self: false});
  self = {...map(s.Self), self: true, online: true};
  devices = [self, ...Object.values(s.Peer || {}).filter(n => n.HostName !== 'funnel-ingress-node').map(map)].sort((a, b) => Number(b.self) - Number(a.self) || Number(b.online) - Number(a.online) || Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0));
 } catch { error = 'Tailscale is not running or not installed'; }
 try {
  const v = JSON.parse(serve || '{}');
  for (const [host, cfg] of Object.entries(v.Web || {})) for (const [path, h] of Object.entries(cfg.Handlers || {})) {
   const port = Number((h.Proxy || '').match(/:(\d+)/)?.[1]) || null;
   routes.push({url: 'https://' + host.replace(/:443$/, '') + (path === '/' ? '/' : path), proxy: h.Proxy || h.Path || h.Text || '', port, public: !!v.AllowFunnel?.[host],
    site: SITES.find(s => s.port === port)?.id || (port === 8787 ? 'homebase' : null)});
  }
 } catch {}
 tsCache = {at: Date.now(), value: {devices, routes, error}};
 return tsCache.value;
}

// Network prefix used to group one device across rotating addresses (iCloud Private Relay / IPv6 privacy addresses
// change per request). Display grouping only; blocking always uses the exact address.
function prefix(ip = '') {
 if (!ip.includes(':')) return ip;
 const [l, r = ''] = ip.split('::'), a = l ? l.split(':') : [], b = r ? r.split(':') : [];
 return [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b].slice(0, 4).join(':') + '::/64';
}

export async function getTraffic(siteId, rangeId = '24h') {
 if (!SITES.length) return {configured: false, sites: [], configPath: config.configPath};
 const site = SITES.find(s => s.id === siteId) || SITES[0];
 const range = RANGES[rangeId] ? rangeId : '24h', {hours, bucket} = RANGES[range];
 const now = Date.now(), since = now - hours * 3600e3;
 const names = await readdir(LOG_DIR).catch(() => []);
 const dated = re => names.map(n => [n, n.match(re)?.[1]]).filter(([, d]) => d);
 const reFor = s => new RegExp(`^${s.prefix}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
 const sinceDay = new Date(since - 86400e3).toISOString().slice(0, 10);
 const logFiles = dated(reFor(site)).filter(([, d]) => d >= sinceDay).sort((a, b) => a[1].localeCompare(b[1]));
 const all = (await Promise.all(logFiles.map(([n]) => readLog(`${LOG_DIR}/${n}`)))).flat();
 const rows = all.filter(r => r.at >= since);
 const [ts, control] = await Promise.all([tailscaleState(), readControl().catch(e => ({revoked: [], blocked: [], revokedBefore: null, error: e.message}))]);
 const revoked = new Set(control.revoked.map(x => x.sid)), blockedIps = new Set(control.blocked.map(x => x.ip));
 const tsByIp = new Map(ts.devices.flatMap(d => d.ips.map(ip => [ip, d.name])));

 // One row per browser: requests are linked by session (survives network changes) and by browser + network
 // (survives signing in again, which creates a new session). Union-find over both keys.
 const parent = new Map();
 const find = k => { let r = k; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r); if (!parent.has(k)) parent.set(k, k); else parent.set(k, r); return r; };
 const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
 const browserKey = r => `b:${r.ua || ''}|${prefix(r.ip)}`;
 for (const r of rows) { find(browserKey(r)); if (r.sid) union(browserKey(r), 's:' + r.sid); }

 const start = (() => { const d = new Date(since); d.setMinutes(0, 0, 0); if (bucket >= 86400e3) d.setHours(0); else d.setHours(d.getHours() - d.getHours() % (bucket / 3600e3)); return d.getTime(); })();
 const n = Math.ceil((now - start) / bucket);
 const series = Array.from({length: n}, (_, i) => ({at: start + i * bucket, requests: 0, pageViews: 0, visitors: new Set()}));
 const heat = Array.from({length: 7}, () => Array(24).fill(0));
 const devices = new Map();
 let bytes = 0, pageViews = 0, signIns = 0, failed = 0;
 for (const r of rows) {
  const agent = describeAgent(r.ua), page = PAGE.has(r.p) && r.m === 'GET' && r.s === 200;
  const key = find(browserKey(r));
  bytes += r.b || 0;
  if (page) { pageViews++; const d = new Date(r.at); heat[(d.getDay() + 6) % 7][d.getHours()]++; }
  if (r.m === 'POST' && r.p === '/login') { if (r.s === 303) signIns++; else if ([401, 429].includes(r.s)) failed++; }
  const b = series[Math.min(n - 1, Math.max(0, Math.floor((r.at - start) / bucket)))];
  b.requests++; if (page) b.pageViews++; if (!agent.bot) b.visitors.add(key);
  let dv = devices.get(key);
  if (!dv) devices.set(key, dv = {key, sessions: new Set(), currentSession: null, ...agent, ua: r.ua || '', name: null, ips: new Set(), source: r.src, firstAt: r.at, lastAt: r.at, pageViews: 0, requests: 0, bytes: 0, signIns: 0, lastHasSession: false, lastPath: '/'});
  if (r.sid) { dv.sessions.add(r.sid); dv.currentSession = r.sid; }
  if (r.m === 'POST' && r.p === '/login' && r.s === 303) dv.signIns++;
  dv.requests++; dv.bytes += r.b || 0; if (page) dv.pageViews++;
  dv.ips.delete(r.ip); dv.ips.add(r.ip); // keep insertion order = most recent last
  dv.lastAt = r.at; dv.source = r.src; dv.lastHasSession = !!r.sid;
  if (!POLL.has(r.p)) dv.lastPath = r.p;
  dv.name = tsByIp.get(r.ip) || dv.name;
 }
 const list = [...devices.values()].map(d => {
  const ips = [...d.ips].reverse();
  const sessions = [...d.sessions];
  const status = d.currentSession && d.lastHasSession && !revoked.has(d.currentSession) ? 'signed-in' : sessions.length ? 'signed-out' : 'visitor';
  const {lastHasSession: _lastHasSession, ...rest} = d;
  return {...rest, sessions, ips, status, online: now - d.lastAt < ONLINE_MS, blocked: ips.some(ip => blockedIps.has(ip)), rotatingIp: ips.length > 1};
 }).sort((a, b) => b.lastAt - a.lastAt);
 const people = list.filter(d => !d.bot);
 const sitesWithLogs = SITES.filter(s => s.id === site.id || dated(reFor(s)).length);
 return {
  site, range, sites: sitesWithLogs.map(({id, name}) => ({id, name})), since, loggingSince: all[0]?.at || null,
  totals: {devices: people.length, signedIn: people.filter(d => d.status === 'signed-in').length, onlineNow: people.filter(d => d.online).length, bots: list.length - people.length,
   pageViews, requests: rows.length, bytes, signIns, failedSignIns: failed},
  series: series.map(b => ({at: b.at, requests: b.requests, pageViews: b.pageViews, visitors: b.visitors.size})), bucketMs: bucket, heat,
  devices: list.slice(0, 300),
  recent: rows.filter(r => !POLL.has(r.p)).slice(-40).reverse().map(r => ({at: r.at, ip: r.ip, name: tsByIp.get(r.ip) || null, method: r.m, path: r.p, status: r.s, source: r.src, agent: (a => `${a.device} · ${a.browser}`)(describeAgent(r.ua))})),
  access: {routes: ts.routes, devices: ts.devices.map(({name, os, online, lastSeen, self, ips}) => ({name, os, online, lastSeen, self, ip: ips.find(i => !i.includes(':')) || ips[0]})), error: ts.error},
  ownIps: ['127.0.0.1', '::1', ...(ts.devices.find(d => d.self)?.ips || [])],
  control, configured: true,
 };
}
