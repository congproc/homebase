import {useCallback, useEffect, useMemo, useState} from 'react';
import {Ban, Bell, BellOff, Bot, Check, Eye, Globe, KeyRound, Laptop, LogOut, Monitor, Radio, ShieldAlert, ShieldCheck, Smartphone, Tablet, Undo2, Users, Wifi, X} from 'lucide-react';
import {Table, TableHeader, TableBody, TableRow, TableHead, TableCell} from '@/components/ui/table';
import {toast} from 'sonner';
import {useConfirm} from './components/confirm';
import {Empty, Panel, Pill, Skeleton} from './components/panels';
import {ago, bytes} from './lib/format';

type Device = {key: string; sessions: string[]; currentSession: string | null; signIns: number; device: string; browser: string; kind: string; bot: boolean; ua: string; name: string | null; ips: string[]; source: string; firstAt: number; lastAt: number; pageViews: number; requests: number; bytes: number; lastPath: string; status: 'signed-in' | 'signed-out' | 'visitor'; online: boolean; blocked: boolean; rotatingIp: boolean};
type Control = {revoked: {sid: string; at: string; label?: string; group?: string}[]; blocked: {ip: string; at: string; label?: string}[]; revokedBefore: string | null; error?: string};
type Traffic = {
  configured: true;
  site: {id: string; name: string}; range: string; sites: {id: string; name: string}[]; since: number; loggingSince: number | null;
  totals: {devices: number; signedIn: number; onlineNow: number; bots: number; pageViews: number; requests: number; bytes: number; signIns: number; failedSignIns: number};
  series: {at: number; requests: number; pageViews: number; visitors: number}[]; bucketMs: number; heat: number[][];
  devices: Device[]; recent: {at: number; ip: string; name: string | null; method: string; path: string; status: number; source: string; agent: string}[];
  access: {routes: {url: string; proxy: string; public: boolean}[]; devices: {name: string; os: string; online: boolean; lastSeen: string | null; self: boolean; ip: string}[]; error: string | null};
  ownIps: string[]; control: Control;
};
type Alert = {id: string; kind: 'failed-login' | 'new-device'; siteName: string; ip: string; source: string; device: string; sid?: string; count: number; rateLimited?: boolean; severity: 'medium' | 'high'; at: number; lastAt: number; read: boolean};
type Alerts = {alerts: Alert[]; unread: number; learning: boolean};

const RANGES = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']] as const;
const METRICS = {visitors: 'Devices', pageViews: 'Page views', requests: 'Requests'} as const;
type Metric = keyof typeof METRICS;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const stamp = (t: number) => new Date(t).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const num = (v: number) => v.toLocaleString();
const kindIcon = (k: string) => k === 'phone' ? Smartphone : k === 'tablet' ? Tablet : k === 'desktop' ? Laptop : k === 'bot' ? Bot : Monitor;
const deviceLabel = (x: Device) => x.name || `${x.device} · ${x.browser}`;
const Source = ({source}: {source: string}) =>
  <span className={`status ${source === 'funnel' ? 'warn' : source === 'tailnet' ? 'green' : 'muted'}`}><i />{source === 'funnel' ? 'Public' : source === 'tailnet' ? 'Tailnet' : 'Local'}</span>;
const STATUS = {'signed-in': ['green', 'Signed in'], 'signed-out': ['failed', 'Signed out'], visitor: ['muted', 'Not signed in']} as const;

async function post<T>(url: string, token: string | undefined, body: object): Promise<T> {
  if (!token) throw Error('Still connecting, try again in a moment');
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify(body)});
  const res = await r.json() as T & {error?: string};
  if (!r.ok) throw Error(res.error || 'Request failed');
  return res;
}

function Bars({series, metric, bucketMs}: {series: Traffic['series']; metric: Metric; bucketMs: number}) {
  const [hover, setHover] = useState<number | null>(null);
  const vals = series.map(s => s[metric]), max = Math.max(1, ...vals);
  const label = (t: number) => bucketMs >= 86400e3 ? new Date(t).toLocaleDateString([], {month: 'short', day: 'numeric'}) : stamp(t);
  // Default to the latest bucket with data, so a just-started (empty) hour doesn't read as "0".
  const lastFilled = vals.findLastIndex(v => v > 0);
  const h = hover ?? (lastFilled >= 0 ? lastFilled : series.length - 1);
  return (
    <div className="tr-bars-wrap">
      <div className="tr-bars-readout"><small>{series[h] ? label(series[h].at) : '—'}</small><strong>{series[h] ? num(vals[h]) : '—'}</strong><small>{METRICS[metric].toLowerCase()}</small></div>
      <div className="tr-bars" onPointerLeave={() => setHover(null)} role="img" aria-label={`${METRICS[metric]} over time`}>
        {vals.map((v, i) => <span key={i} className={`tr-bar ${hover === i ? 'on' : ''}`} onPointerEnter={() => setHover(i)} title={`${label(series[i].at)}: ${num(v)}`}><i style={{height: `${v ? Math.max(3, (v / max) * 100) : 0}%`}} /></span>)}
      </div>
      <div className="tr-bars-axis"><span>{series[0] ? label(series[0].at) : ''}</span><span>Now</span></div>
    </div>
  );
}

function Heatmap({heat}: {heat: number[][]}) {
  const max = Math.max(1, ...heat.flat());
  return (
    <div className="tr-heat" role="img" aria-label="Page views by weekday and hour">
      <span />{Array.from({length: 24}, (_, h) => <em key={h}>{h % 6 === 0 ? String(h).padStart(2, '0') : ''}</em>)}
      {heat.map((row, d) => [<b key={'d' + d}>{DAYS[d]}</b>, ...row.map((v, h) =>
        <i key={`${d}-${h}`} title={`${DAYS[d]} ${String(h).padStart(2, '0')}:00 · ${v} page views`} style={v ? {opacity: 0.18 + 0.82 * (v / max), background: 'var(--lime)'} : undefined} />)])}
    </div>
  );
}

export default function TrafficPanel({token}: {token?: string}) {
  const ask = useConfirm();
  const [site, setSite] = useState('');
  const [range, setRange] = useState('24h');
  const [metric, setMetric] = useState<Metric>('visitors');
  const [data, setData] = useState<Traffic | null>(null);
  const [unconfigured, setUnconfigured] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showBots, setShowBots] = useState(false);
  const [allAlerts, setAllAlerts] = useState(false);
  // Reference time for "x ago" labels; updated with each fetch so render stays pure.
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const [t, a] = await Promise.all([fetch(`/api/traffic?site=${encodeURIComponent(site)}&range=${range}`), fetch('/api/alerts')]);
      if (!t.ok) throw Error('Unable to load traffic');
      const next = await t.json() as Traffic | {configured: false; configPath: string};
      if (!next.configured) { setUnconfigured(next.configPath); setData(null); } else { setUnconfigured(null); setData(next); }
      if (a.ok) setAlerts(await a.json()); setError(''); setNow(Date.now());
    } catch (e) { setError((e as Error).message); }
  }, [site, range]);
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [refresh]);

  const d = data && (!site || data.site.id === site) && data.range === range ? data : null;
  const t = d?.totals;
  const own = new Set(data?.ownIps || []);
  const blockedSet = new Set((data?.control.blocked || []).map(b => b.ip));
  const revokedSet = new Set((data?.control.revoked || []).map(r => r.sid));
  const devices = useMemo(() => (d?.devices || []).filter(x => showBots || !x.bot), [d, showBots]);

  const control = async (body: {action: string; sids?: string[]; ip?: string; label?: string}, done: string) => {
    setBusy(true);
    try { await post('/api/traffic/control', token, body); toast.success(done); await refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const alertAction = async (body: {action: string; id?: string}) => {
    try { setAlerts(await post<Alerts>('/api/alerts', token, body)); } catch (e) { toast.error((e as Error).message); }
  };
  const signOut = async (sids: string[], label: string) => {
    if (await ask({title: `Sign out ${label}?`, destructive: true, confirm: 'Sign out device',
      body: 'That browser’s session ends within a second and it goes back to the sign-in page. It can sign in again with the password; to keep someone out for good, use “Sign out all” and change the password.'}))
      control({action: 'revoke', sids, label}, `${label} signed out`);
  };
  const signOutAll = async () => {
    if (await ask({title: 'Sign out every device?', destructive: true, confirm: 'Sign out all',
      body: 'Every session on the sites that read this access-control file ends within a second, including yours. Everyone must enter the password again. If the password may have leaked, change it as well, or the same people can sign straight back in.'}))
      control({action: 'revoke-all'}, 'All devices signed out');
  };
  const block = async (ip: string, label: string, rotating = false) => {
    if (await ask({title: `Block ${ip}?`, destructive: true, confirm: 'Block IP',
      body: <>Every request from <span className="mono">{ip}</span> is refused within a second, including the sign-in page. Anyone sharing that address (same office or mobile network) is blocked too.{rotating && <><br /><br /><strong>This device changes address</strong> (e.g. iCloud Private Relay), so blocking one address may not keep it out. Use Sign out instead.</>}</>}))
      control({action: 'block', ip, label}, `${ip} blocked`);
  };
  const restore = async (sids: string[], label: string) => {
    if (await ask({title: `Let ${label} back in?`, confirm: 'Undo sign-out',
      body: 'This undoes the sign-out: that browser can use the dashboard again without entering the password.'}))
      control({action: 'restore', sids}, 'Sign-out undone');
  };
  const unblock = (ip: string) => control({action: 'unblock', ip}, `${ip} unblocked`);

  const ctl = data?.control;
  const hasControls = !!ctl && (ctl.blocked.length > 0 || ctl.revoked.length > 0 || !!ctl.revokedBefore || !!ctl.error);
  const shownAlerts = alerts ? (allAlerts ? alerts.alerts : alerts.alerts.slice(0, 5)) : [];

  if (unconfigured) return (
    <Panel title="No sites configured" sub="Traffic reads the access logs that your own web apps write">
      <Empty icon={Globe} title="Add a site to see who visits it">
        List each site under <span className="mono">traffic.sites</span> in <span className="mono">{unconfigured}</span>, then restart Homebase. Each site writes <span className="mono">&lt;prefix&gt;-YYYY-MM-DD.jsonl</span> access logs into <span className="mono">traffic.logDir</span>.
      </Empty>
    </Panel>
  );

  return <>
    <div className="tr-toolbar">
      {data && data.sites.length > 1 && <div className="segmented" role="tablist" aria-label="Site">
        {data.sites.map(s => <button key={s.id} role="tab" aria-selected={(site || data.site.id) === s.id} className={(site || data.site.id) === s.id ? 'selected' : ''} onClick={() => setSite(s.id)}>{s.name}</button>)}
      </div>}
      <div className="segmented" role="tablist" aria-label="Time range">
        {RANGES.map(([id, label]) => <button key={id} role="tab" aria-selected={range === id} title={label} className={range === id ? 'selected' : ''} onClick={() => setRange(id)}>{id}</button>)}
      </div>
      {t && <span className="tr-live"><span className={`tr-dot ${t.onlineNow ? 'on' : ''}`} />{t.onlineNow} active now</span>}
    </div>
    {error && <div className="tr-note warn">{error}</div>}
    {d?.loggingSince && d.loggingSince > d.since && <div className="tr-note">Detailed logging started {stamp(d.loggingSince)}; nothing earlier is available.</div>}

    <Panel title="Security alerts" className="tr-alerts"
      sub={alerts?.learning ? 'Learning your current devices…' : 'Failed sign-ins, and new devices signing in from the public internet. Checked every 20 s, even while Homebase is closed.'}
      action={!!alerts?.alerts.length && <div className="tr-actions">
        {alerts.unread > 0 && <button className="button small" onClick={() => alertAction({action: 'read-all'})}><Check size={13} />Mark all read</button>}
        {alerts.alerts.some(a => a.read) && <button className="button small" onClick={() => alertAction({action: 'clear-read'})}><BellOff size={13} />Clear read</button>}
      </div>}>
      {!alerts ? <div className="pad"><Skeleton h={40} /></div> : !alerts.alerts.length ? <div className="pad tr-quiet"><Bell size={14} />No alerts. All quiet.</div> :
        <div className="pad tr-alert-list">
          {shownAlerts.map(a => {
            const ipBlocked = blockedSet.has(a.ip), out = !!a.sid && revokedSet.has(a.sid);
            return <div key={a.id} className={`tr-alert ${a.read ? 'read' : ''} sev-${a.severity}`}>
              <span className="tr-alert-icon">{a.kind === 'failed-login' ? <ShieldAlert size={16} /> : <Smartphone size={16} />}</span>
              <div className="tr-alert-body">
                <strong>{a.kind === 'failed-login' ? `${a.count} failed sign-in${a.count === 1 ? '' : 's'}${a.rateLimited ? ' · rate limit hit' : ''}` : 'New device signed in'}</strong>
                <small><span className="mono">{a.ip}</span> · {a.device} · {a.source === 'funnel' ? 'public internet' : a.source}</small>
                <small className="dim">{a.count > 1 ? `${stamp(a.at)} – ${new Date(a.lastAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}` : stamp(a.at)}{ipBlocked ? ' · IP blocked' : ''}{out ? ' · signed out' : ''}</small>
              </div>
              <div className="tr-actions">
                {a.kind === 'new-device' && a.sid && !out && <button className="button small danger-outline" disabled={busy} onClick={() => signOut([a.sid!], `${a.device} (${a.ip})`)}><LogOut size={13} />Sign out</button>}
                {!ipBlocked && !own.has(a.ip) && <button className="button small danger-outline" disabled={busy} onClick={() => block(a.ip, a.device)}><Ban size={13} />Block IP</button>}
                {!a.read && <button className="button small" onClick={() => alertAction({action: 'read', id: a.id})} title="Mark as read" aria-label="Mark as read"><Check size={13} /></button>}
                <button className="button small" onClick={() => alertAction({action: 'dismiss', id: a.id})} title="Dismiss" aria-label="Dismiss"><X size={13} /></button>
              </div>
            </div>;
          })}
          {alerts.alerts.length > 5 && <button className="button small tr-more" onClick={() => setAllAlerts(v => !v)}>{allAlerts ? 'Show fewer' : `Show all ${alerts.alerts.length}`}</button>}
        </div>}
    </Panel>

    <div className="stats tr-stats">
      {[
        {icon: Users, label: 'Devices', value: t && num(t.devices), sub: t && `${t.signedIn} signed in · ${t.onlineNow} active now`},
        {icon: Eye, label: 'Page views', value: t && num(t.pageViews), sub: t && `${num(t.requests)} requests`},
        {icon: KeyRound, label: 'Sign-ins', value: t && num(t.signIns), sub: t && `${t.failedSignIns} failed`, warn: !!t?.failedSignIns},
        {icon: Wifi, label: 'Data sent', value: t && bytes(t.bytes), sub: d && RANGES.find(r => r[0] === range)?.[1]},
      ].map(s => (
        <div className="stat tr-stat" key={s.label}>
          <div className="stat-label"><span><s.icon size={15} />{s.label}</span>{s.warn && <ShieldAlert size={16} style={{color: 'var(--amber)'}} />}</div>
          <div className="stat-value">{s.value ?? <Skeleton h={30} w={90} />}</div>
          <div className="stat-sub">{s.sub}</div>
        </div>
      ))}
    </div>

    <div className="chart-layout">
      <Panel title="Traffic over time" sub={d ? (d.bucketMs >= 86400e3 ? 'Per day' : d.bucketMs > 3600e3 ? 'Per 6 hours' : 'Per hour') : 'Loading'}
        action={<div className="segmented" role="tablist">{(Object.keys(METRICS) as Metric[]).map(m => <button key={m} role="tab" aria-selected={metric === m} className={metric === m ? 'selected' : ''} onClick={() => setMetric(m)}>{METRICS[m]}</button>)}</div>}>
        <div className="pad">{d ? <Bars series={d.series} metric={metric} bucketMs={d.bucketMs} /> : <Skeleton h={200} />}</div>
      </Panel>
      <Panel title="When people visit" sub="Page views by weekday and hour">
        <div className="pad">{d ? <Heatmap heat={d.heat} /> : <Skeleton h={160} />}</div>
      </Panel>
    </div>

    <Panel title="Devices" sub="One row per browser. A phone whose address keeps changing is still one row. Active means seen in the last 2 minutes."
      action={<div className="tr-actions">
        <label className="tr-check"><input type="checkbox" checked={showBots} onChange={e => setShowBots(e.target.checked)} />Bots & scripts{t?.bots ? ` (${t.bots})` : ''}</label>
        <button className="button small danger-outline" disabled={busy || !token} onClick={signOutAll}><LogOut size={13} />Sign out all</button>
      </div>}>
      {!d ? <div className="pad"><Skeleton h={120} /></div> : !devices.length ? <Empty icon={Users} title="No visitors in this period">Devices appear here as soon as someone opens the site.</Empty> :
        <div className="tr-scroll"><Table className="tr-devices">
          <TableHeader><TableRow><TableHead>Device</TableHead><TableHead>Access</TableHead><TableHead>Status</TableHead><TableHead className="num">Views</TableHead><TableHead>Last seen</TableHead><TableHead className="num">Actions</TableHead></TableRow></TableHeader>
          <TableBody>{devices.map(x => {
            const Icon = kindIcon(x.kind), [cls, label] = STATUS[x.status], ip = x.ips[0], ipBlocked = blockedSet.has(ip);
            return <TableRow key={x.key}>
              <TableCell><div className="tr-device"><Icon size={16} /><div>
                <strong>{deviceLabel(x)}</strong>
                <small title={`${x.ua}\nFirst seen ${stamp(x.firstAt)} · ${num(x.requests)} requests · ${bytes(x.bytes)}\n${x.ips.join('\n')}`}>
                  <span className="mono">{ip}</span>{x.rotatingIp && ` · ${x.ips.length} addresses`}{x.signIns > 1 && ` · signed in ${x.signIns}×`}{x.name && ` · ${x.device} · ${x.browser}`}
                </small>
              </div></div></TableCell>
              <TableCell><Source source={x.source} /></TableCell>
              <TableCell><span className={`status ${cls}`}><i />{label}</span>{x.blocked && <span className="status failed tr-gap"><i />Blocked</span>}</TableCell>
              <TableCell className="num tr-views">{num(x.pageViews)}</TableCell>
              <TableCell>{x.online ? <span className="tr-live"><span className="tr-dot on" />Now</span> : <span title={stamp(x.lastAt)}>{ago(Math.max(0, now - x.lastAt))}</span>}</TableCell>
              <TableCell><div className="tr-actions">
                {x.status === 'signed-in' && <button className="button small danger-outline" disabled={busy} onClick={() => signOut(x.sessions, deviceLabel(x))}><LogOut size={13} />Sign out</button>}
                {!own.has(ip) && (ipBlocked
                  ? <button className="button small" disabled={busy} onClick={() => unblock(ip)}><ShieldCheck size={13} />Unblock</button>
                  : <button className="button small danger-outline" disabled={busy} onClick={() => block(ip, deviceLabel(x), x.rotatingIp)} title={`Block ${ip}`}><Ban size={13} />Block IP</button>)}
              </div></TableCell>
            </TableRow>;
          })}</TableBody>
        </Table></div>}
    </Panel>

    {hasControls && ctl && <Panel title="Blocked & signed out" sub={ctl.error || 'Applies to the live and staging tour dashboards. Sign-outs are forgotten after 30 days, when those sessions would have expired anyway.'}>
      <div className="pad tr-control">
        {ctl.revokedBefore && <div>
          <span className="status warn"><i />All signed out</span><strong>Every session from before {stamp(Date.parse(ctl.revokedBefore))}</strong>
          <button className="button small" disabled={busy} onClick={() => control({action: 'undo-revoke-all'}, 'Earlier sessions allowed again')}><Undo2 size={13} />Undo</button>
        </div>}
        {ctl.blocked.map(b => <div key={'b' + b.ip}>
          <span className="status failed"><i />Blocked IP</span><strong className="mono">{b.ip}</strong><small className="dim">{b.label ? `${b.label} · ` : ''}since {stamp(Date.parse(b.at))}</small>
          <button className="button small" disabled={busy} onClick={() => unblock(b.ip)}><ShieldCheck size={13} />Unblock</button>
        </div>)}
        {Object.values(ctl.revoked.reduce<Record<string, typeof ctl.revoked>>((g, r) => { (g[r.group || r.sid] ||= []).push(r); return g; }, {})).map(list => {
          const r = list[list.length - 1];
          return <div key={'r' + (r.group || r.sid)}>
            <span className="status warn"><i />Signed out</span><strong>{r.label || 'Session'}</strong><small className="dim">{stamp(Date.parse(r.at))}{list.length > 1 ? ` · ${list.length} sessions` : ''}</small>
            <button className="button small" disabled={busy} onClick={() => restore(list.map(x => x.sid), r.label || 'this device')}><Undo2 size={13} />Undo sign-out</button>
          </div>;
        })}
      </div>
    </Panel>}

    <div className="services-grid">
      <Panel title="Recent activity" sub="Latest page loads, sign-ins and actions (background updates hidden)">
        {!d ? <div className="pad"><Skeleton h={100} /></div> : !d.recent.length ? <Empty icon={Radio} title="Nothing yet" /> :
          <div className="tr-scroll short"><Table className="tr-recent">
            <TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Request</TableHead><TableHead>From</TableHead></TableRow></TableHeader>
            <TableBody>{d.recent.map((r, i) => <TableRow key={i}>
              <TableCell className="dim">{stamp(r.at)}</TableCell>
              <TableCell><span className="mono">{r.method} {r.path}</span> <span className={`status ${r.status < 400 ? 'green' : r.status >= 500 ? 'failed' : 'warn'}`}><i />{r.status}</span></TableCell>
              <TableCell><span className="mono">{r.name || r.ip}</span><small className="dim tr-block">{r.agent}</small></TableCell>
            </TableRow>)}</TableBody>
          </Table></div>}
      </Panel>
      <Panel title="Access points" sub={data?.access.error || 'Addresses published from this server, and the tailnet devices that can reach the private ones'}>
        {!data ? <div className="pad"><Skeleton h={100} /></div> : <div className="pad tr-routes">
          {data.access.routes.map(r => <div key={r.url}>
            <a href={r.url} target="_blank" rel="noreferrer" className="mono">{r.url.replace('https://', '')}</a>
            <div><span className={`status ${r.public ? 'warn' : 'green'}`}><i />{r.public ? 'Public internet' : 'Tailnet only'}</span><small className="dim mono">→ {r.proxy.replace('http://', '')}</small></div>
          </div>)}
          {!data.access.routes.length && <Empty icon={Globe} title="Nothing published" />}
          <div className="tr-tailnet">
            {data.access.devices.filter(x => !x.self).map(x => <div key={x.name + x.ip} title={x.ip}>
              {x.os === 'iOS' || x.os === 'android' ? <Smartphone size={14} /> : <Laptop size={14} />}<span>{x.name}</span>
              {x.online ? <Pill on>Online</Pill> : <small className="dim">{x.lastSeen ? ago(Math.max(0, now - Date.parse(x.lastSeen))) : 'offline'}</small>}
            </div>)}
          </div>
        </div>}
      </Panel>
    </div>
  </>;
}
