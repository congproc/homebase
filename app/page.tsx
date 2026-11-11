'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import {
  Activity, BarChart3, Box, ChevronRight, Clock, Copy, Download, Globe, HardDrive, LayoutDashboard, Menu, Moon, Plug, RefreshCw, Search, Server, Terminal, Trash2, Zap, Plus,
} from 'lucide-react';
import {SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarFooter, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarTrigger, useSidebar} from '@/components/ui/sidebar';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut} from '@/components/ui/command';
import {Toaster, toast} from 'sonner';
import {ConfirmProvider, useConfirm} from '../src/components/confirm';
import PowerPanel from '../src/PowerPanel';
import EnergyPanel from '../src/EnergyPanel';
import FeaturesPanel from '../src/FeaturesPanel';
import TrafficPanel from '../src/TrafficPanel';
import UpdatePanel from '../src/UpdatePanel';
import StoragePanel from '../src/StoragePanel';
import {registerMonitoringTool} from '../src/webmcp';
import {LogoMark, useStatusFavicon} from '../src/components/logo';
import {ActivityPanel, AiPanel, ContainersPanel, EventsPanel, GpuPanel, HealthPanel, HostDetails, ModelsPanel, Pill, ProcessesPanel, StatCards, TmuxPanel} from '../src/components/panels';
import {ago, clock, elapsed, featureOn, health} from '../src/lib/format';
import type {FeatureId, Features, Status} from '../src/lib/types';

// Grouped by what you are doing: watching the machine, managing what runs on it, configuring it.
// The 1–9/0 shortcuts follow this order.
const NAV = [
  {name: 'Overview', slug: 'overview', icon: LayoutDashboard, group: 'Monitor', blurb: 'A little clarity for everything you’re running.'},
  {name: 'Resources', slug: 'resources', icon: Activity, group: 'Monitor', blurb: 'Live resource usage and the processes behind it.'},
  {name: 'Storage', slug: 'storage', icon: HardDrive, group: 'Monitor', blurb: 'Drives, filesystems, temperatures and SMART health.'},
  {name: 'Energy', slug: 'energy', icon: Plug, group: 'Monitor', blurb: 'What the server draws from the wall, and what that costs.'},
  {name: 'Traffic', slug: 'traffic', icon: BarChart3, group: 'Monitor', blurb: 'Who is using your hosted sites, from which devices, and when.'},
  {name: 'Containers', slug: 'containers', icon: Box, group: 'Workloads', blurb: 'Keep your services running smoothly.'},
  {name: 'Tmux sessions', slug: 'tmux', icon: Terminal, group: 'Workloads', blurb: 'Persistent terminals, always within reach.'},
  {name: 'AI services', slug: 'ai', icon: Zap, group: 'Workloads', blurb: 'Monitor your coding agents and local models.'},
  {name: 'Hosted services', slug: 'services', icon: Globe, group: 'Workloads', blurb: 'Your apps, their health, and how they affect sleep.'},
  {name: 'Hosts', slug: 'hosts', icon: Server, group: 'System', blurb: 'The machine that keeps your home lab running.'},
  {name: 'Sleep & power', slug: 'power', icon: Moon, group: 'System', blurb: 'Save power without losing track of your work.'},
] as const;
const GROUPS = ['Monitor', 'Workloads', 'System'] as const;
/** Pages on the phone tab bar; everything else lives behind "More". */
const TABS: {name: PageName; label: string}[] = [{name: 'Overview', label: 'Overview'}, {name: 'Resources', label: 'Resources'}, {name: 'Storage', label: 'Storage'}, {name: 'AI services', label: 'AI'}];
type PageName = typeof NAV[number]['name'];
type NavItem = typeof NAV[number];
/** Pages that only make sense when a feature is present on this machine. */
const PAGE_FEATURE: Partial<Record<PageName, FeatureId>> = {Containers: 'docker', 'Tmux sessions': 'tmux', 'AI services': 'ai', Traffic: 'traffic', Energy: 'energy'};
const FEATURES_KEY = 'homebase.features';
const cachedFeatures = (): Features | null => { try { return JSON.parse(localStorage.getItem(FEATURES_KEY) || 'null'); } catch { return null; } };
const fromHash = (): PageName => NAV.find(n => n.slug === window.location.hash.replace(/^#\/?/, ''))?.name ?? 'Overview';

type Output = {title: string; body: string; session?: string; container?: string};

export default function Page() {
  return <ConfirmProvider><Home /></ConfirmProvider>;
}

function Home() {
  const ask = useConfirm();
  useEffect(registerMonitoringTool, []);
  const [d, setData] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [page, setPageState] = useState<PageName>(fromHash);
  const [output, setOutput] = useState<Output | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [palette, setPalette] = useState(false);
  const [updateRequest, setUpdateRequest] = useState(0); // top-bar Update button presses

  const setPage = useCallback((p: string) => {
    const item = NAV.find(n => n.name === p);
    if (!item) return;
    setPageState(item.name);
    if (window.location.hash !== `#/${item.slug}`) history.pushState(null, '', `#/${item.slug}`);
    window.scrollTo({top: 0}); // the document scrolls, not .main
  }, []);

  useEffect(() => {
    const onPop = () => setPageState(fromHash());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);


  // One status request at a time; a hung request times out instead of stalling the poll loop.
  const inFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => inFlight.current ??= (async () => {
    try {
      const r = await fetch('/api/status', {signal: AbortSignal.timeout(8000)});
      if (!r.ok) throw Error('Local agent is unavailable');
      setData(await r.json());
      setError('');
    } catch {
      setError('Connection lost. Retrying every 5 seconds.');
    } finally {
      inFlight.current = null;
    }
  })(), []);

  // Poll every 5s while the tab is visible; catch up immediately when it becomes visible again.
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const poll = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(first); clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  const manualRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refresh(), new Promise(r => setTimeout(r, 450))]);
    setRefreshing(false);
  };

  const action = async (kind: 'docker' | 'tmux' | 'agent', id: string, act: string, label = id, pid?: number) => {
    if (!d) return;
    setBusy(true);
    setPending(`${kind}:${id}:${act}`);
    try {
      const r = await fetch('/api/action', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': d.token}, body: JSON.stringify({kind, id, action: act, pid})});
      const result = await r.json() as {error?: string; output?: string};
      if (!r.ok) throw Error(result.error || 'Request failed');
      if (act === 'logs') setOutput({title: `Container logs · ${label}`, body: result.output || 'No output yet.', container: id});
      else if (act === 'capture') setOutput({title: `Session · ${id}`, body: result.output || 'No output yet.', session: id});
      else {
        if (kind === 'agent' && act === 'start') toast.success(`${label} started in tmux session “${result.output}”`, {description: `Attach with: tmux attach -t ${result.output}`});
        else if (kind === 'agent' || kind === 'tmux' && act === 'kill') toast.success(result.output || `${label}: ${act} done`);
        else toast.success(act === 'create' ? `Session “${id}” created` : `${label}: ${act} completed`);
        if (act === 'kill') setOutput(null);
        setCreating(false);
        setName('');
      }
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  // Keyboard: ⌘K / Ctrl+K palette, 1–9 and 0 jump to page, R refresh.
  // Optional features: the last known set is remembered so pages don't flash in and out while connecting.
  const [savedFeatures] = useState(cachedFeatures);
  const features = d?.features ?? savedFeatures;
  const featureKey = d?.features ? JSON.stringify(d.features) : '';
  useEffect(() => { if (featureKey) try { localStorage.setItem(FEATURES_KEY, featureKey); } catch { /* private mode */ } }, [featureKey]);
  const has = useCallback((f: FeatureId) => featureOn(features, f), [features]);
  const pages: NavItem[] = NAV.filter(n => { const f = PAGE_FEATURE[n.name]; return !f || has(f); });
  // A bookmarked page for a feature this machine doesn't have falls back to the overview.
  useEffect(() => { const f = PAGE_FEATURE[page]; if (d?.features && f && !d.features[f].on) setPage('Overview'); }, [d?.features, page, setPage]);

  const keyRef = useRef({setPage, manualRefresh, pages});
  useEffect(() => { keyRef.current = {setPage, manualRefresh, pages}; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); return; }
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input,textarea,select,[contenteditable=true],[role=dialog]')) return;
      if (/^[0-9]$/.test(e.key)) { const item = keyRef.current.pages[(Number(e.key) + 9) % 10]; if (item) keyRef.current.setPage(item.name); }
      else if (e.key === 'r') keyRef.current.manualRefresh();
      else if (e.key === '/') { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const containers = d?.containers.items || [];
  const sessions = d?.sessions.items || [];
  const uptime = (d?.uptime || 0) + (d ? (now - d.at) / 1000 : 0);
  const nav = NAV.find(n => n.name === page)!;
  const h = health(d, error);
  const stale = d ? now - d.at : 0;
  const counts: Partial<Record<PageName, number>> = {Containers: containers.length, 'Tmux sessions': sessions.length, ...(d?.alertsUnread ? {Traffic: d.alertsUnread} : {})};
  useStatusFavicon(h.level);
  const unread = d?.alertsUnread || 0;
  useEffect(() => { document.title = `${unread ? `(${unread}) ` : ''}${page} · Homebase`; }, [page, unread]);
  const lastUnread = useRef<number | null>(null);
  useEffect(() => {
    const n = d?.alertsUnread;
    if (n === undefined) return;
    if (lastUnread.current !== null && n > lastUnread.current) toast.warning(`${n - lastUnread.current} new security ${n - lastUnread.current === 1 ? 'alert' : 'alerts'}`, {description: 'Failed sign-ins or a new public device on your hosted site.', action: {label: 'View', onClick: () => setPage('Traffic')}});
    lastUnread.current = n;
  }, [d?.alertsUnread, setPage]);

  const containersPanel = (full?: boolean) => <ContainersPanel d={d} busy={busy} pending={pending} full={full} go={full ? undefined : () => setPage('Containers')}
    onAction={(id, act) => action('docker', id, act, containers.find(c => c.ID === id)?.Names)} onConfirm={async (c, act) => {
      if (await ask({title: `${act === 'stop' ? 'Stop' : 'Restart'} ${c.Names}?`, body: `This interrupts whatever is running in the container. ${act === 'stop' ? 'It stays stopped until you start it again.' : 'It should be back within a few seconds.'}`, confirm: act === 'stop' ? 'Stop container' : 'Restart container', destructive: act === 'stop'}))
        action('docker', c.ID, act, c.Names);
    }} />;
  const killSession = async (n: string) => {
    if (await ask({title: `Kill session “${n}”?`, body: 'Every window and process running inside this tmux session will be terminated. Unsaved work in it will be lost.', confirm: 'Kill session', destructive: true}))
      action('tmux', n, 'kill');
  };
  const AGENT_LABEL: Record<string, string> = {claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama'};
  const agentAction = async (n: string, act: 'start' | 'stop' | 'restart', pid?: number) => {
    const label = AGENT_LABEL[n] || n;
    if (n === 'ollama' && act !== 'start' && !(await ask({title: `${act === 'stop' ? 'Stop' : 'Restart'} the Ollama service?`, body: 'Loaded models are unloaded and in-flight requests fail. Apps that use the Ollama API will be unavailable until it is started again.', confirm: act === 'stop' ? 'Stop Ollama' : 'Restart Ollama', destructive: act === 'stop'}))) return;
    if (n !== 'ollama' && act === 'stop' && !(await ask({
      title: pid ? `Stop ${label} process ${pid}?` : `Stop all ${label} processes?`,
      body: <>{pid ? 'This process' : `All ${d?.agents.find(a => a.name === n)?.processes?.length ?? ''} running processes`} will receive a stop signal (SIGTERM). Any conversation or task in progress ends immediately.{n === 'claude' && <><br /><br /><strong>Heads-up:</strong> this includes any Claude Code session you are using right now.</>}</>,
      confirm: pid ? 'Stop process' : 'Stop all', destructive: true}))) return;
    action('agent', n, act, label, pid);
  };
  const tmuxPanel = (full?: boolean) => <TmuxPanel d={d} now={now} busy={busy} pending={pending} onOpen={n => action('tmux', n, 'capture')} onCreate={() => setCreating(true)} onKill={killSession} go={full ? undefined : () => setPage('Tmux sessions')} />;

  return (
    <SidebarProvider style={{'--sidebar-width': '232px'} as React.CSSProperties}>
      <Sidebar>
        <SidebarHeader className="brand">
          <span className="brand-symbol" title={h.title}><LogoMark level={h.level} size={19} /></span>
          <span>homebase<span className={`brand-period level-${h.level}`}>.</span></span>
        </SidebarHeader>
        <SidebarContent>
          <div className="workspace">
            <span className="host-avatar"><Server size={16} /></span>
            <div><strong>{d?.hostname || 'Home lab'}</strong><small>{d ? `${d.cores} cores · ${elapsed(uptime).split(' ').slice(0, 2).join(' ')} up` : 'Connecting…'}</small></div>
            <span className={`pulse-dot level-${h.level}`} title={h.title} />
          </div>
          <button className="sidebar-search" onClick={() => setPalette(true)}>
            <Search size={14} /><span>Search & jump</span><kbd>Ctrl K</kbd>
          </button>
          {GROUPS.filter(g => pages.some(p => p.group === g)).map(g => <div className="nav-group" key={g}>
            <div className="nav-label">{g}</div>
            <SidebarMenu className="nav-menu">
              {pages.map(({name: n, icon: Icon, group}, i) => group === g && (
                <SidebarMenuItem key={n}>
                  <NavButton active={page === n} onClick={() => setPage(n)}>
                    <Icon size={17} /><span>{n}</span>
                    {counts[n] ? <em className={n === 'Traffic' ? 'alert' : undefined}>{counts[n]}</em> : i < 10 ? <kbd className="nav-key">{(i + 1) % 10}</kbd> : null}
                  </NavButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </div>)}
        </SidebarContent>
        <SidebarFooter>
          <div className="sidebar-bottom">
            <span className="avatar">{(d?.user || '·').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').slice(0, 2).map(w => w[0]?.toUpperCase()).join('') || '·'}</span>
            <div><strong>{d?.user || 'Local administrator'}</strong><small>{typeof window !== 'undefined' && window.location.hostname.endsWith('.ts.net') ? 'via Tailscale' : '127.0.0.1 · this machine'}</small></div>
          </div>
          <div className="version"><button className="version-link" onClick={() => setPage('Hosts')} title="Version and updates">Homebase {d?.version ? `v${d.version}` : ''}</button>{d?.updateAvailable
            ? <button className="version-update" onClick={() => setPage('Hosts')} title="A newer Homebase is available">UPDATE</button>
            : <span>LOCAL</span>}</div>
        </SidebarFooter>
      </Sidebar>

      <main className="main">
        <header className="topbar">
          <div>
            <SidebarTrigger />
            <span className="topbar-logo brand-symbol" aria-hidden="true"><LogoMark level={h.level} size={15} /></span>
            <span className="breadcrumb"><span className="hide-sm">{d?.hostname || 'Workspace'}</span><ChevronRight size={13} className="hide-sm" /><strong>{page}</strong></span>
          </div>
          <div className="topbar-right">
            {d?.updateAvailable && <button className="button small primary topbar-update" onClick={() => { setPage('Hosts'); setUpdateRequest(n => n + 1); }} title="A newer Homebase is available">
              <Download size={13} /><span className="hide-sm">Update</span></button>}
            <button className="topbar-search" onClick={() => setPalette(true)} aria-label="Open command palette"><Search size={14} /><span>Search</span><kbd>Ctrl K</kbd></button>
            <span className={`connection ${error ? 'offline' : d ? '' : 'pending'}`} title={d ? `Last reading ${clock(d.at, true)}` : undefined}>
              <i />{error ? 'Disconnected' : d ? <>Live <span className="hide-sm">· {ago(stale)}</span></> : 'Connecting'}
            </span>
            <span className="topbar-divider hide-sm" />
            <span className="mono hide-sm">{clock(now)}</span>
          </div>
        </header>

        <div className="content" key={page}>
          <div className="page-heading">
            <div>
              <div className="eyebrow"><nav.icon size={12} />{page === 'Overview' ? 'Your server, at a glance' : 'Homebase'}</div>
              <h1>{page}</h1>
              <p>{nav.blurb}</p>
            </div>
            <button className="button" onClick={manualRefresh} disabled={refreshing} title="Refresh (R)">
              <RefreshCw size={15} className={refreshing ? 'spin' : ''} /><span>Refresh</span>
            </button>
          </div>

          {error && <div role="alert" className="error-banner">
            <span>{error}</span>
            <small>Last reading: {d ? `${clock(d.at, true)} (${ago(stale)})` : 'none'}</small>
            <button className="button small" onClick={manualRefresh} disabled={refreshing}><RefreshCw size={13} className={refreshing ? 'spin' : ''} /> Retry now</button>
          </div>}

          {(page === 'Overview' || page === 'Hosts') && (
            <div className={`host-strip level-${h.level}`}>
              <span className="host-icon"><Server size={22} /></span>
              <div className="host-identity">
                <strong>{d?.hostname || 'Local server'}<Pill on={!!d && !error}>{d ? (error ? 'Stale' : 'Online') : 'Connecting'}</Pill></strong>
                <small>{d?.platform || 'Discovering system'} <span>·</span> <span className="mono">{d?.interfaces[0]?.address || '127.0.0.1'}</span>{d?.cpuModel && <span className="hide-md"> <span>·</span> {d.cpuModel}</span>}</small>
              </div>
              <UptimeBlock d={d} uptime={uptime} />
            </div>
          )}

          {page === 'Overview' && <>
            <StatCards d={d} go={setPage} />
            <div className="chart-layout">
              <ActivityPanel d={d} />
              <HealthPanel d={d} error={error} go={setPage} />
            </div>
            {(has('docker') || has('tmux')) && <div className={`services-grid${has('docker') && has('tmux') ? '' : ' single'}`}>{has('docker') && containersPanel()}{has('tmux') && tmuxPanel()}</div>}
            {has('ai') && <AiPanel d={d} busy={busy} pending={pending} onAgent={agentAction} />}
            <EventsPanel d={d} now={now} />
          </>}
          {page === 'Resources' && <><StatCards d={d} go={setPage} /><ActivityPanel d={d} /><ProcessesPanel d={d} /><GpuPanel d={d} /></>}
          {page === 'Hosts' && <><UpdatePanel token={d?.token} now={now} autoStart={updateRequest} /><HostDetails d={d} uptime={uptime} /><FeaturesPanel features={d?.features} /></>}
          {page === 'Storage' && <StoragePanel d={d} />}
          {page === 'Containers' && containersPanel(true)}
          {page === 'Tmux sessions' && tmuxPanel(true)}
          {page === 'AI services' && <><AiPanel d={d} detailed busy={busy} pending={pending} onAgent={agentAction} />{(!d || d.ollamaOnline || d.agents.some(x => x.name === 'ollama' && x.installed)) && <ModelsPanel d={d} />}</>}
          {page === 'Hosted services' && <PowerPanel mode="services" token={d?.token} />}
          {page === 'Energy' && <EnergyPanel live={d?.energy} />}
          {page === 'Sleep & power' && <PowerPanel mode="settings" token={d?.token} />}
          {page === 'Traffic' && <TrafficPanel token={d?.token} />}

          <footer className="page-footer">
            <span><span className="tiny-dot" /> {error ? 'Readings may be stale' : 'Direct from your machine. No cloud required.'}</span>
            <span className="hide-sm">Press <kbd>1</kbd>–<kbd>0</kbd> to switch pages · <kbd>R</kbd> to refresh</span>
          </footer>
        </div>
      </main>
      <MobileTabs page={page} pages={pages} go={setPage} alerts={unread} />

      {/* Command palette */}
      <Dialog open={palette} onOpenChange={setPalette}>
        <DialogContent className="palette" showCloseButton={false}>
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription className="sr-only">Jump to a page or run an action</DialogDescription>
          <Command>
            <CommandInput placeholder="Jump to a page, container, or session…" />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup heading="Pages">
                {pages.map(({name: n, icon: Icon}, i) => (
                  <CommandItem key={n} value={`page ${n}`} onSelect={() => { setPage(n); setPalette(false); }}>
                    <Icon /><span>{n}</span>{i < 10 && <CommandShortcut>{(i + 1) % 10}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Actions">
                <CommandItem value="refresh status" onSelect={() => { setPalette(false); manualRefresh(); }}><RefreshCw /><span>Refresh status</span><CommandShortcut>R</CommandShortcut></CommandItem>
                {has('tmux') && <CommandItem value="new tmux session create" onSelect={() => { setPalette(false); setCreating(true); }}><Plus /><span>New tmux session</span></CommandItem>}
              </CommandGroup>
              {containers.length > 0 && <CommandGroup heading="Container logs">
                {containers.map(c => <CommandItem key={c.ID} value={`logs ${c.Names} ${c.Image}`} onSelect={() => { setPalette(false); action('docker', c.ID, 'logs', c.Names); }}><Box /><span>{c.Names}</span><CommandShortcut>{c.State}</CommandShortcut></CommandItem>)}
              </CommandGroup>}
              {sessions.length > 0 && <CommandGroup heading="Tmux sessions">
                {sessions.map(s => <CommandItem key={s.name} value={`tmux ${s.name}`} onSelect={() => { setPalette(false); action('tmux', s.name, 'capture'); }}><Terminal /><span>{s.name}</span></CommandItem>)}
              </CommandGroup>}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {/* Logs / pane output */}
      <Dialog open={!!output} onOpenChange={o => !o && setOutput(null)}>
        <DialogContent className="terminal-dialog">
          <DialogTitle>{output?.title}</DialogTitle>
          <DialogDescription>Read-only output from your server · last 80 lines</DialogDescription>
          <TerminalOutput text={output?.body || ''} />
          <div className="dialog-actions">
            <button className="button" onClick={() => navigator.clipboard.writeText(output?.body || '').then(() => toast.success('Output copied')).catch(() => toast.error('Clipboard unavailable'))}><Copy size={14} /> Copy output</button>
            {output?.session && <button className="button danger-outline" disabled={busy} onClick={() => killSession(output.session!)}><Trash2 size={14} /> Kill session</button>}
            {output?.session && <button className="button" onClick={() => navigator.clipboard.writeText(`tmux attach-session -t '${output.session!.replaceAll("'", "'\\''")}'`).then(() => toast.success('Attach command copied')).catch(() => toast.error('Clipboard unavailable'))}><Terminal size={14} /> Copy attach command</button>}
            <button className="button primary" disabled={busy} onClick={() => output?.session ? action('tmux', output.session, 'capture') : output?.container && action('docker', output.container, 'logs', output.title.split(' · ')[1])}><RefreshCw size={14} className={busy ? 'spin' : ''} /> Reload</button>
          </div>
        </DialogContent>
      </Dialog>

      {/* New tmux session */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogTitle>New tmux session</DialogTitle>
          <DialogDescription>Create a persistent terminal on {d?.hostname || 'this host'}.</DialogDescription>
          <form className="dialog-form" onSubmit={e => { e.preventDefault(); action('tmux', name, 'create'); }}>
            <label htmlFor="session-name">Session name</label>
            <input id="session-name" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="my-workspace" pattern="[a-zA-Z0-9_\-]{1,40}" required maxLength={40} autoComplete="off" spellCheck={false} />
            <p className="form-help">Letters, numbers, hyphens, and underscores.</p>
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => setCreating(false)}>Cancel</button>
              <button className="button primary" disabled={busy || !name}>{busy ? 'Creating…' : 'Create session'}</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>


      <Toaster theme="dark" position="bottom-right" toastOptions={{className: 'toast'}} />
    </SidebarProvider>
  );
}

/** Time since boot, split into awake vs. suspended. */
function UptimeBlock({d, uptime}: {d: Status | null; uptime: number}) {
  const sl = d?.sleep;
  const asleep = sl?.asleep ?? 0;
  const awake = Math.max(0, uptime - asleep);
  const pct = uptime ? (awake / uptime) * 100 : 100;
  return (
    <div className="host-uptime">
      <Clock size={15} />
      <div>
        <small>Since boot{sl ? ` · ${new Date(sl.bootAt).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}` : ''}</small>
        <strong className="mono">{d ? elapsed(uptime) : '—'}</strong>
        {sl && <>
          <div className="awake-bar" title={`Awake ${elapsed(awake)} · Asleep ${elapsed(asleep)}`}><span style={{width: `${pct}%`}} /></div>
          <div className="awake-legend"><span><i className="awake" />Awake {elapsed(awake)}</span><span><i className="asleep" />Asleep {asleep >= 60 ? elapsed(asleep) : '0m'}{sl.count ? ` · ${sl.count}×` : ''}</span></div>
        </>}
      </div>
    </div>
  );
}

/** Bottom tab bar on phones: the most-watched pages one tap away, the rest behind "More". */
function MobileTabs({page, pages, go, alerts}: {page: PageName; pages: NavItem[]; go: (p: string) => void; alerts: number}) {
  const {setOpenMobile} = useSidebar();
  // Preferred tabs that exist on this machine, topped up to four from the remaining pages in menu order.
  const tabs = TABS.filter(t => pages.some(p => p.name === t.name));
  for (const p of pages) if (tabs.length < TABS.length && !tabs.some(t => t.name === p.name)) tabs.push({name: p.name, label: p.name.split(' ')[0]});
  const inTabs = tabs.some(t => t.name === page);
  const more = NAV.find(n => n.name === page)!;
  return (
    <nav className="mobile-tabs" aria-label="Pages">
      {tabs.map(t => {
        const Icon = NAV.find(n => n.name === t.name)!.icon;
        return <button key={t.name} className={page === t.name ? 'on' : ''} aria-current={page === t.name ? 'page' : undefined} onClick={() => go(t.name)}><Icon size={19} /><span>{t.label}</span></button>;
      })}
      <button className={inTabs ? '' : 'on'} onClick={() => setOpenMobile(true)} aria-label="More pages">
        {inTabs ? <Menu size={19} /> : <more.icon size={19} />}<span>{inTabs ? 'More' : more.name.split(' ')[0]}</span>
        {alerts > 0 && <em>{alerts}</em>}
      </button>
    </nav>
  );
}

/** Nav button that closes the mobile sidebar sheet after navigating. */
function NavButton({active, onClick, children}: {active: boolean; onClick: () => void; children: React.ReactNode}) {
  const {isMobile, setOpenMobile} = useSidebar();
  return <SidebarMenuButton isActive={active} className="nav-button" onClick={() => { onClick(); if (isMobile) setOpenMobile(false); }}>{children}</SidebarMenuButton>;
}

function TerminalOutput({text}: {text: string}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return <pre ref={ref}>{text}</pre>;
}
