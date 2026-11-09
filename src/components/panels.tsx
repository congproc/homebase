import {useMemo, useState} from 'react';

const pct1 = (v: number) => String(Math.round(v * 10) / 10);
/** Swaps a button icon for a spinner while that exact action is in flight. */
const Busy = ({on, size = 14, children}: {on: boolean; size?: number; children: React.ReactNode}) => on ? <RefreshCw size={size} className="spin" /> : <>{children}</>;
import {
  Activity, AlertTriangle, ArrowDown, Clock, ArrowUp, ArrowUpDown, Box, Check, ChevronRight, Copy, Cpu, HardDrive, Layers,
  Gauge, MemoryStick, Network, Play, Plus, Power, RefreshCw, Search, Square, Terminal, Trash2, WifiOff, X,
} from 'lucide-react';
import {Table, TableHeader, TableBody, TableRow, TableHead, TableCell} from '@/components/ui/table';
import {AreaChart, Ring, Sparkline} from './charts';
import {ClaudeIcon, CodexIcon, OllamaIcon} from './agent-icons';
import {toast} from 'sonner';
import {Num} from './motion';
import {ago, bytes, clock, diskHealth, elapsed, health, levelColor, levelFor, rate} from '../lib/format';
import type {Container, Proc, Status} from '../lib/types';

/* ---------- primitives ---------- */

export function Panel({title, sub, action, className = '', children}: {title: string; sub?: React.ReactNode; action?: React.ReactNode; className?: string; children: React.ReactNode}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div><h2>{title}</h2>{sub && <p>{sub}</p>}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

export const ViewAll = ({onClick}: {onClick: () => void}) =>
  <button className="text-button" onClick={onClick}>View all <ChevronRight size={14} /></button>;

export function Empty({icon: Icon, title, children}: {icon: React.ElementType; title: string; children?: React.ReactNode}) {
  return <div className="empty"><span className="empty-icon"><Icon size={20} /></span><strong>{title}</strong>{children && <span>{children}</span>}</div>;
}

export function Pill({on, children}: {on: boolean; children: React.ReactNode}) {
  return <span className={`status ${on ? 'green' : 'muted'}`}><i />{children}</span>;
}

export const Skeleton = ({h = 16, w = '100%'}: {h?: number; w?: number | string}) =>
  <span className="skeleton" style={{height: h, width: w}} />;

/* ---------- overview: stats ---------- */

export function StatCards({d}: {d: Status | null}) {
  const hist = d?.history || [];
  const times = hist.map(p => p.at);
  const gpu = d?.gpu?.available ? d.gpu.items : [];
  const g0 = gpu[0]; // primary: discrete first
  const gpuUtil = g0?.utilization ?? 0;
  const gpuL = levelFor(gpuUtil, 85, 97);
  const cpuL = levelFor(d?.cpu ?? 0), memL = levelFor(d?.memory.percent ?? 0, 80, 92), diskL = levelFor(d?.disk?.percent ?? 0, 80, 92);
  return (
    <div className={`stats${gpu.length ? ' has-gpu' : ''}`}>
      <div className="stat">
        <div className="stat-label"><span><Cpu size={15} />CPU</span>{d && <Ring value={d.cpu} color={levelColor[cpuL]} size={38} />}</div>
        <div className="stat-value">{d ? <><Num value={d.cpu} format={pct1} /><small>%</small></> : <Skeleton h={30} w={90} />}</div>
        <div className="stat-sub">{d ? `${d.cores} cores · load ${d.load[0].toFixed(2)}` : 'Waiting for data'}</div>
        <Sparkline times={times} values={hist.map(p => p.cpu)} color="var(--lime)" max={Math.max(10, ...hist.map(p => p.cpu)) * 1.3} />
      </div>
      <div className="stat">
        <div className="stat-label"><span><MemoryStick size={15} />Memory</span>{d && <Ring value={d.memory.percent} color={levelColor[memL] === 'var(--lime)' ? 'var(--violet)' : levelColor[memL]} size={38} />}</div>
        <div className="stat-value">{d ? <Num value={d.memory.used} format={bytes} /> : <Skeleton h={30} w={110} />}</div>
        <div className="stat-sub">{d ? `of ${bytes(d.memory.total)} · ${d.memory.percent}% used` : 'Waiting for data'}</div>
        <Sparkline times={times} values={hist.map(p => p.memory)} color="var(--violet)" max={100} />
      </div>
      {g0 && <div className="stat">
        <div className="stat-label"><span><Gauge size={15} />GPU{gpu.length > 1 && <small className="dim">+{gpu.length - 1}</small>}</span>{g0.utilization != null && <Ring value={gpuUtil} color={levelColor[gpuL] === 'var(--lime)' ? 'var(--pink)' : levelColor[gpuL]} size={38} />}</div>
        <div className="stat-value">{g0.utilization != null ? <><Num value={gpuUtil} format={v => String(Math.round(v))} /><small>%</small></> : '—'}</div>
        <div className="stat-sub" title={g0.name}>{[g0.memory ? `${bytes(g0.memory.used)} VRAM` : g0.kind === 'integrated' ? 'Shared memory' : g0.name,
          g0.temperature != null && `${g0.temperature}°C`, g0.power != null && `${Math.round(g0.power)} W`].filter(Boolean).join(' · ')}</div>
        <Sparkline times={times} values={hist.map(p => p.gpu ?? 0)} color="var(--pink)" max={100} />
      </div>}
      <div className="stat">
        <div className="stat-label"><span><HardDrive size={15} />Storage</span>{d?.disk && <Ring value={d.disk.percent} color={levelColor[diskL] === 'var(--lime)' ? 'var(--amber)' : levelColor[diskL]} size={38} />}</div>
        <div className="stat-value">{d?.disk ? <Num value={d.disk.used} format={bytes} /> : d ? '—' : <Skeleton h={30} w={110} />}</div>
        <div className="stat-sub">{d?.disk ? `${bytes(d.disk.total - d.disk.used)} free of ${bytes(d.disk.total)}` : 'Root filesystem'}</div>
        <div className="meter"><span style={{width: `${d?.disk?.percent || 0}%`, background: diskL === 'ok' ? 'var(--amber)' : levelColor[diskL]}} /></div>
        <div className="meter-legend"><span>{d?.disk?.percent ?? 0}% used</span><span className="mono">mounted at /</span></div>
      </div>
      <div className="stat">
        <div className="stat-label"><span><Network size={15} />Network</span></div>
        <div className="stat-value net-value">{d ? <><ArrowDown size={16} className="sky" /><Num value={d.network.download} format={rate} /></> : <Skeleton h={30} w={120} />}</div>
        <div className="stat-sub">{d ? <><ArrowUp size={12} className="pink" /> <Num value={d.network.upload} format={rate} /> upload</> : 'Waiting for data'}</div>
        <div className="spark-stack">
          <Sparkline times={times} values={hist.map(p => p.download)} color="var(--sky)" max={Math.max(1024, ...hist.map(p => Math.max(p.download, p.upload))) * 1.2} />
          <Sparkline times={times} values={hist.map(p => p.upload)} color="var(--pink)" max={Math.max(1024, ...hist.map(p => Math.max(p.download, p.upload))) * 1.2} />
        </div>
      </div>
    </div>
  );
}

/* ---------- overview: activity chart ---------- */

const METRICS = {
  cpu: {label: 'CPU'},
  memory: {label: 'Memory'},
  network: {label: 'Network'},
  gpu: {label: 'GPU'},
} as const;

export function ActivityPanel({d}: {d: Status | null}) {
  const [chosen, setMetric] = useState<keyof typeof METRICS>('cpu');
  const hasGpu = !!d?.gpu?.available;
  const metric = chosen === 'gpu' && !hasGpu ? 'cpu' : chosen;
  const tabs = (Object.keys(METRICS) as (keyof typeof METRICS)[]).filter(m => m !== 'gpu' || hasGpu);
  const hist = d?.history || [];
  const times = hist.map(p => p.at);
  const series = metric === 'network'
    ? [{label: 'Download', color: 'var(--sky)', values: hist.map(p => p.download)}, {label: 'Upload', color: 'var(--pink)', values: hist.map(p => p.upload)}]
    : metric === 'gpu'
    ? [{label: 'GPU', color: 'var(--pink)', values: hist.map(p => p.gpu ?? 0)}, ...(hist.some(p => p.vram != null) ? [{label: 'VRAM', color: 'var(--amber)', values: hist.map(p => p.vram ?? 0)}] : [])]
    : [{label: metric === 'cpu' ? 'CPU' : 'Memory', color: metric === 'cpu' ? 'var(--lime)' : 'var(--violet)', values: hist.map(p => p[metric])}];
  const main = series[0].values;
  const avg = main.length ? main.reduce((a, b) => a + b, 0) / main.length : 0;
  const peak = main.length ? Math.max(...main) : 0;
  const fmt = metric === 'network' ? rate : (v: number) => `${Math.round(v)}%`;
  const minutes = hist.length > 1 ? Math.round((hist.at(-1)!.at - hist[0].at) / 60000) : 0;
  return (
    <Panel title="Resource activity" sub={hist.length > 1 ? `Live · every 5 seconds · last ${minutes || '<1'} min` : 'Live · every 5 seconds'} className="usage-panel"
      action={<div className="segmented" role="tablist">{tabs.map(m =>
        <button key={m} role="tab" aria-selected={metric === m} className={metric === m ? 'selected' : ''} onClick={() => setMetric(m)}>{METRICS[m].label}</button>)}</div>}>
      <div className="chart-summary">
        <div><small>Current</small><strong>{main.length ? <Num value={main.at(-1)!} format={fmt} /> : '—'}</strong></div>
        <div><small>Average</small><strong>{main.length ? <Num value={avg} format={fmt} /> : '—'}</strong></div>
        <div><small>Peak</small><strong>{main.length ? <Num value={peak} format={fmt} /> : '—'}</strong></div>
        <div className="chart-legend">{series.map(s => <span key={s.label}><i style={{background: s.color}} />{s.label}</span>)}</div>
      </div>
      <AreaChart series={series} times={times} max={metric === 'network' ? undefined : 100} format={fmt} />
    </Panel>
  );
}

/* ---------- overview: health ---------- */

export function HealthPanel({d, error, go}: {d: Status | null; error: string; go: (p: string) => void}) {
  const h = health(d, error);
  const containers = d?.containers.items || [];
  const running = containers.filter(c => c.State === 'running').length;
  const Icon = h.level === 'ok' ? Check : h.level === 'offline' ? WifiOff : h.level === 'pending' ? RefreshCw : AlertTriangle;
  return (
    <Panel title="System health" className="system-panel" action={<Activity size={16} className="dim" />}>
      <div className={`health-status level-${h.level}`}>
        <span className="health-ring"><Icon size={20} /></span>
        <div>
          <strong>{h.title}</strong>
          <small>{h.reasons.length ? h.reasons.join(' · ') : d ? `${d.hostname} is responding normally` : 'Waiting for first reading'}</small>
        </div>
      </div>
      <div className="health-row"><span>Load average <em>1 / 5 / 15m</em></span><strong className="mono">{d?.load.map(v => v.toFixed(2)).join(' / ') || '—'}</strong></div>
      <button className="health-row link" onClick={() => go('Containers')}><span>Running containers</span><strong>{running} <span className="dim">/ {containers.length}</span></strong></button>
      <button className="health-row link" onClick={() => go('Tmux sessions')}><span>Tmux sessions</span><strong>{d?.sessions.items.length ?? '—'}</strong></button>
      {!!d?.disks?.items.length && (() => {
        const levels = d.disks.items.map(x => diskHealth(x).level), bad = levels.filter(l => l !== 'ok').length;
        const hottest = Math.max(...d.disks.items.map(x => x.temperature ?? -Infinity));
        return <button className="health-row link" onClick={() => go('Storage')}><span>Drives</span>
          <span className={bad ? (levels.includes('critical') ? 'red' : 'amber') : 'lime'}>{bad ? `${bad} need${bad === 1 ? 's' : ''} attention` : `${d.disks.items.length} healthy`}{Number.isFinite(hottest) ? <span className="dim"> · {Math.round(hottest)}°C</span> : null}</span></button>;
      })()}
      <button className="health-row link" onClick={() => go('AI services')}><span>Ollama API</span><span className={d?.ollamaOnline ? 'lime' : 'dim'}>{d?.ollamaOnline ? `Connected · ${d.models.length} loaded` : 'Unavailable'}</span></button>
    </Panel>
  );
}

/* ---------- containers ---------- */

export function ContainersPanel({d, busy, pending, onAction, onConfirm, full, go}: {
  d: Status | null; busy: boolean; pending?: string | null; full?: boolean; go?: () => void;
  onAction: (id: string, act: string) => void; onConfirm: (c: Container, act: 'stop' | 'restart') => void;
}) {
  const [q, setQ] = useState('');
  const all = d?.containers.items || [];
  const items = all.filter(c => !q || `${c.Names} ${c.Image}`.toLowerCase().includes(q.toLowerCase()));
  const running = all.filter(c => c.State === 'running').length;
  return (
    <Panel title="Containers" sub={`${running} running · ${all.length - running} stopped`}
      action={full ? all.length > 0 && <SearchBox value={q} onChange={setQ} placeholder="Filter containers" /> : go && <ViewAll onClick={go} />}>
      {!all.length
        ? <Empty icon={Box} title={!d ? 'Connecting…' : d.containers.available ? 'No containers yet' : 'Docker unavailable'}>
            {d?.containers.available ? 'Containers on this host will appear here.' : d?.containers.error || 'Waiting for the local agent…'}
          </Empty>
        : !items.length ? <Empty icon={Search} title="No matches">Nothing matches “{q}”.</Empty>
        : <Table>
            <TableHeader><TableRow><TableHead>Name / image</TableHead><TableHead>Status</TableHead><TableHead className="hide-sm">Uptime</TableHead>{full && <TableHead className="hide-sm">Ports</TableHead>}<TableHead className="right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>{items.map(c => (
              <TableRow key={c.ID}>
                <TableCell><div className="resource-name"><span className="resource-icon"><Box size={16} /></span><div><strong>{c.Names}</strong><small>{c.Image}</small></div></div></TableCell>
                <TableCell><Pill on={c.State === 'running'}>{c.State}</Pill></TableCell>
                <TableCell className="mono dim hide-sm">{c.Status}</TableCell>
                {full && <TableCell className="mono dim hide-sm ports">{c.Ports || '—'}</TableCell>}
                <TableCell>
                  <div className="row-actions">
                    <button title="View logs" aria-label={`View ${c.Names} logs`} disabled={busy} onClick={() => onAction(c.ID, 'logs')}><Busy on={pending === `docker:${c.ID}:logs`} size={14}><Terminal size={15} /></Busy></button>
                    {c.State === 'running' ? <>
                      <button title="Restart" aria-label={`Restart ${c.Names}`} disabled={busy} onClick={() => onConfirm(c, 'restart')}><RefreshCw size={14} className={pending === `docker:${c.ID}:restart` ? 'spin' : ''} /></button>
                      <button title="Stop" className="danger" aria-label={`Stop ${c.Names}`} disabled={busy} onClick={() => onConfirm(c, 'stop')}><Busy on={pending === `docker:${c.ID}:stop`} size={13}><Square size={13} /></Busy></button>
                    </> : <button title="Start" aria-label={`Start ${c.Names}`} disabled={busy} onClick={() => onAction(c.ID, 'start')}><Busy on={pending === `docker:${c.ID}:start`}><Play size={15} /></Busy></button>}
                  </div>
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>}
    </Panel>
  );
}

function SearchBox({value, onChange, placeholder}: {value: string; onChange: (v: string) => void; placeholder: string}) {
  return (
    <label className="search-box">
      <Search size={14} />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && <button type="button" aria-label="Clear filter" onClick={() => onChange('')}><X size={13} /></button>}
    </label>
  );
}

/* ---------- tmux ---------- */

export function TmuxPanel({d, now, busy, pending, onOpen, onCreate, onKill, go}: {d: Status | null; now: number; busy: boolean; pending?: string | null; onOpen: (name: string) => void; onCreate: () => void; onKill: (name: string) => void; go?: () => void}) {
  const sessions = d?.sessions.items || [];
  return (
    <Panel title="Tmux sessions" sub={`${sessions.length} persistent ${sessions.length === 1 ? 'workspace' : 'workspaces'}`} action={go && <ViewAll onClick={go} />}>
      <div className="session-list">
        {!sessions.length
          ? <Empty icon={Terminal} title="No active sessions">Create a workspace that keeps running after you disconnect.</Empty>
          : sessions.map(s => (
            <div className="session" key={s.name}>
              <button className="session-open" onClick={() => onOpen(s.name)} disabled={busy} aria-label={`Preview ${s.name}`}>
                <span className="terminal-icon"><Terminal size={16} /></span>
                <div><strong>{s.name}</strong><small>{s.windows} {s.windows === 1 ? 'window' : 'windows'} · up {elapsed(now / 1000 - s.created)}</small></div>
                <Pill on={!!s.attached}>{s.attached ? 'Attached' : 'Detached'}</Pill>
              </button>
              <div className="row-actions">
                <button title="Kill session" className="danger" aria-label={`Kill ${s.name}`} disabled={busy} onClick={() => onKill(s.name)}><Busy on={pending === `tmux:${s.name}:kill`}><Trash2 size={14} /></Busy></button>
                <button title="Preview" aria-label={`Preview ${s.name}`} disabled={busy} onClick={() => onOpen(s.name)}><Busy on={pending === `tmux:${s.name}:capture`}><ChevronRight size={15} /></Busy></button>
              </div>
            </div>
          ))}
        <button className="add-session" onClick={onCreate}><Plus size={15} /> New session</button>
      </div>
    </Panel>
  );
}

/* ---------- AI ---------- */

const AGENT_META: Record<string, {title: string; cls: string; icon: React.ReactNode; tagline: string; install: string}> = {
  claude: {title: 'Claude Code', cls: 'logo-claude', icon: <ClaudeIcon size={21} />, tagline: 'Anthropic coding agent', install: 'curl -fsSL https://claude.ai/install.sh | bash'},
  codex: {title: 'Codex', cls: 'logo-codex', icon: <CodexIcon size={21} />, tagline: 'OpenAI coding agent', install: 'npm install -g @openai/codex'},
  ollama: {title: 'Ollama', cls: 'logo-ollama', icon: <OllamaIcon size={22} />, tagline: 'Local model runtime', install: 'curl -fsSL https://ollama.com/install.sh | sh'},
};

export type AgentAction = (name: string, action: 'start' | 'stop' | 'restart', pid?: number) => void;

export function AiPanel({d, detailed, busy, pending, onAgent}: {d: Status | null; detailed?: boolean; busy: boolean; pending?: string | null; onAgent: AgentAction}) {
  const agents = d?.agents || [{name: 'claude'}, {name: 'codex'}, {name: 'ollama'}];
  return (
    <Panel title="AI services" sub="Coding agents and local models on this host">
      <div className="agents">{agents.map(a => {
        const meta = AGENT_META[a.name] || {title: a.name, cls: '', icon: <Layers size={20} />, tagline: '', install: ''};
        const procs = a.processes || [];
        const live = procs.length > 0 || (a.name === 'ollama' && !!d?.ollamaOnline);
        const cpu = procs.reduce((n, p) => n + p.cpu, 0);
        const mem = procs.reduce((n, p) => n + p.memory, 0);
        const missing = !!d && a.installed === false && !live;
        const state = !d ? 'pending' : live ? 'live' : missing ? 'missing' : 'idle';
        return (
          <div className={`agent ${live ? 'live' : ''} ${missing ? 'missing' : ''}`} key={a.name}>
            <div className="agent-top">
              <span className={`agent-logo ${meta.cls}`}>{meta.icon}<i className={`agent-dot ${state}`} title={live ? 'Running' : missing ? 'Not installed' : 'Idle'} /></span>
              <div><h3>{meta.title}</h3><p>{meta.tagline}</p></div>
              <Pill on={live}>{live ? 'Running' : missing ? 'Not installed' : d ? 'Idle' : 'Connecting'}</Pill>
            </div>
            {missing && meta.install ? (
              <div className="agent-install">
                <small>Not found on this host’s PATH. Install with:</small>
                <div className="setup-command">
                  <code>{meta.install}</code>
                  <button className="button small" aria-label={`Copy ${meta.title} install command`} title="Copy" onClick={() => navigator.clipboard.writeText(meta.install).then(() => toast.success('Install command copied')).catch(() => toast.error('Copy the command manually'))}><Copy size={13} /></button>
                </div>
              </div>
            ) : <div className="agent-metrics">
              <div title={a.name === 'ollama' ? 'Models loaded in memory' : undefined}><small>{a.name === 'ollama' ? 'Models' : 'Processes'}</small><strong>{a.name === 'ollama' ? d?.models.length ?? 0 : procs.length}</strong></div>
              <div><small>CPU</small><strong>{procs.length ? `${cpu.toFixed(1)}%` : '—'}</strong></div>
              <div><small>Memory</small><strong>{procs.length ? `${mem.toFixed(1)}%` : '—'}</strong></div>
              <div title="Longest-running process"><small>Running for</small><strong>{procs.length ? elapsed(Math.max(...procs.map(p => p.elapsed))) : '—'}</strong></div>
            </div>}
            {d && !missing && (
              <div className="agent-actions">
                {a.name === 'ollama' ? (live
                  ? <>
                      <button className="button small" disabled={busy} onClick={() => onAgent(a.name, 'restart')}><RefreshCw size={13} className={pending === `agent:${a.name}:restart` ? 'spin' : ''} /> Restart</button>
                      <button className="button small danger-outline" disabled={busy} onClick={() => onAgent(a.name, 'stop')}><Busy on={pending === `agent:${a.name}:stop`} size={13}><Power size={13} /></Busy> Stop service</button>
                    </>
                  : <button className="button small primary" disabled={busy} onClick={() => onAgent(a.name, 'start')}><Busy on={pending === `agent:${a.name}:start`} size={13}><Power size={13} /></Busy> Start service</button>)
                : <>
                    <button className="button small" disabled={busy} onClick={() => onAgent(a.name, 'start')}><Busy on={pending === `agent:${a.name}:start`} size={13}><Play size={13} /></Busy> {procs.length ? 'New session' : 'Start in tmux'}</button>
                    {procs.length > 0 && <button className="button small danger-outline" disabled={busy} onClick={() => onAgent(a.name, 'stop')}><Busy on={pending === `agent:${a.name}:stop`} size={13}><Power size={13} /></Busy> Stop all</button>}
                  </>}
              </div>
            )}
            {detailed && procs.length > 0 && (
              <div className="process-list">
                {[...procs].sort((x, y) => y.elapsed - x.elapsed).map(p => (
                  <div key={p.pid}><span className="mono">{p.pid}</span><span className="pname">{p.name}</span><span>{p.cpu.toFixed(1)}%</span><span className="mono dim">{elapsed(p.elapsed)}</span>
                    {a.name !== 'ollama' ? <button className="proc-kill" title={`Stop PID ${p.pid}`} aria-label={`Stop ${p.name} PID ${p.pid}`} disabled={busy} onClick={() => onAgent(a.name, 'stop', p.pid)}><X size={13} /></button> : <span />}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}</div>
    </Panel>
  );
}

const VENDOR_LABEL = {nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel'} as const;

export function GpuPanel({d}: {d: Status | null}) {
  if (!d?.gpu?.available) return null;
  return <>{d.gpu.items.map(g => {
    const hist = g.history || [], times = hist.map(p => p.at);
    const metrics: [string, string, string?][] = [
      ['Utilization', g.utilization != null ? `${g.utilization}%` : '—', g.utilizationSource === 'idle-residency' ? 'Time the GPU was not idle (from idle residency)' : undefined],
      [g.kind === 'integrated' && !g.memory ? 'Memory' : 'VRAM', g.memory ? `${bytes(g.memory.used)} / ${bytes(g.memory.total)}` : g.kind === 'integrated' ? 'Shared' : '—'],
      ['Temperature', g.temperature != null ? `${g.temperature}°C` : '—'],
      ['Power', g.power != null ? `${g.power.toFixed(0)} W${g.powerLimit ? ` / ${g.powerLimit.toFixed(0)} W` : ''}` : '—'],
      ['Fan', g.fan != null ? `${g.fan}%${g.fanRpm ? ` · ${g.fanRpm} rpm` : ''}` : g.fanRpm != null ? `${g.fanRpm} rpm` : '—'],
      ['Core clock', g.clock != null ? `${g.clock}${g.clockMax ? ` / ${g.clockMax}` : ''} MHz` : '—'],
    ];
    const tempL = levelFor(g.temperature ?? 0, 80, 88);
    const charted = [
      {label: 'Utilization %', color: 'var(--pink)', key: 'utilization'},
      {label: 'Temperature °C', color: 'var(--red)', key: 'temperature'},
      {label: 'Power W', color: 'var(--sky)', key: 'power'},
    ].filter(c => hist.some(p => p[c.key as 'utilization'] != null));
    const sub = [`${VENDOR_LABEL[g.vendor]} · ${g.kind}`, g.driver && `driver ${g.driver}${g.driverVersion ? ` ${g.driverVersion}` : ''}`, g.pstate, g.id].filter(Boolean).join(' · ');
    const hasProcUtil = g.processes.some(p => p.utilization != null);
    return <Panel key={g.id} title={g.name} sub={<span className="mono-sub">{sub}</span>} className="gpu-panel">
      {g.note && <div className="gpu-note"><AlertTriangle size={14} />{g.note}</div>}
      <div className="gpu-metrics">{metrics.map(([k, v, tip]) => <div key={k} title={tip}><small>{k}</small><strong style={k === 'Temperature' && tempL !== 'ok' ? {color: levelColor[tempL]} : undefined}>{v}</strong></div>)}</div>
      {(g.memory || (g.powerLimit && g.power != null)) && <div className="gpu-meters">
        {g.memory && <div><div className="meter-legend"><span>VRAM</span><span>{g.memory.percent}%</span></div><div className="meter"><span style={{width: `${g.memory.percent}%`, background: 'var(--amber)'}} /></div></div>}
        {g.powerLimit && g.power != null && <div><div className="meter-legend"><span>Power</span><span>{Math.round((g.power / g.powerLimit) * 100)}%</span></div><div className="meter"><span style={{width: `${Math.min(100, (g.power / g.powerLimit) * 100)}%`, background: 'var(--pink)'}} /></div></div>}
      </div>}
      {charted.length > 0 && hist.length > 1 && <div className="gpu-temp-chart">
        <AreaChart series={charted.map(c => ({label: c.label, color: c.color, values: hist.map(p => p[c.key as 'utilization'] ?? 0)}))} times={times} format={v => String(Math.round(v))} height={140} />
        <div className="chart-legend">{charted.map(c => <span key={c.key}><i style={{background: c.color}} />{c.label}</span>)}</div>
      </div>}
      <div className="gpu-procs">
        <h4>Processes using this GPU</h4>
        {g.processes.length
          ? <div className={`process-list${hasProcUtil ? ' with-util' : ''}`}>{g.processes.map(p => <div key={p.pid}><span className="mono">{p.pid}</span><span className="pname">{p.name}</span>
              {hasProcUtil && <span>{p.utilization != null ? `${p.utilization}%` : '—'}</span>}<span>{p.memory ? bytes(p.memory) : '—'}</span></div>)}</div>
          : <p className="dim">{g.vendor === 'nvidia' ? 'No CUDA compute jobs running.' : 'No processes from this account are using the GPU.'}</p>}
      </div>
    </Panel>;
  })}</>;
}

export function ModelsPanel({d}: {d: Status | null}) {
  return (
    <Panel title="Loaded models" sub="Models currently resident in Ollama memory">
      {d?.models.length
        ? <div className="models">{d.models.map(m => {
            const vram = m.size ? Math.round((m.size_vram / m.size) * 100) : 0;
            return <div key={m.name}>
              <span className="resource-icon violet"><Layers size={16} /></span>
              <strong>{m.name}</strong>
              <div className="model-meta"><span>{bytes(m.size)}</span><div className="meter small"><span style={{width: `${vram}%`, background: 'var(--violet)'}} /></div><span>{vram}% GPU</span></div>
            </div>;
          })}</div>
        : <Empty icon={Layers} title="No models loaded">Models appear here while Ollama keeps them in memory for inference.</Empty>}
    </Panel>
  );
}

/* ---------- hosts ---------- */

export function HostDetails({d, uptime}: {d: Status | null; uptime: number}) {
  const rows: [string, React.ReactNode][] = [
    ['Hostname', d?.hostname], ['Operating system', d?.platform], ['Processor', d?.cpuModel], ['Logical cores', d?.cores],
    ['Memory', d && bytes(d.memory.total)], ['Root filesystem', d?.disk && bytes(d.disk.total)], ['Uptime', d && elapsed(uptime)],
    ['Load average', d?.load.map(v => v.toFixed(2)).join(' / ')],
  ];
  return <div className="host-grid">
    <Panel title="Machine" sub="Detected from this host">
      <dl className="detail-list">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}</dl>
    </Panel>
    <div className="host-side">
    <Panel title="Sleep since boot" sub={d?.sleep ? `Booted ${new Date(d.sleep.bootAt).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})} · nightly suspend periods from the kernel log` : 'Suspend periods from the kernel log'}>
      {d?.sleep?.periods.length
        ? <dl className="detail-list">{[...d.sleep.periods].reverse().map(p => (
            <div key={p.from}><dt>{new Date(p.from).toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'})}</dt>
              <dd><span className="mono">{clock(p.from)} → {clock(p.to)}</span> <span className="dim">· {elapsed((p.to - p.from) / 1000)}</span></dd></div>
          ))}</dl>
        : <Empty icon={Clock} title="No sleep since boot">The server has been awake the whole time since it last started.</Empty>}
    </Panel>
    <Panel title="Network interfaces" sub="Non-loopback IPv4 addresses">
      {d?.interfaces.length
        ? <dl className="detail-list">{d.interfaces.map(n => <div key={n.name + n.address}><dt className="mono">{n.name}</dt><dd className="mono">{n.address}</dd></div>)}</dl>
        : <Empty icon={Network} title="No external interfaces" />}
    </Panel>
    </div>
  </div>;
}

/* ---------- processes ---------- */

type SortKey = 'name' | 'pid' | 'cpu' | 'memory' | 'elapsed';

export function ProcessesPanel({d}: {d: Status | null}) {
  const [sort, setSort] = useState<{key: SortKey; desc: boolean}>({key: 'cpu', desc: true});
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const list = (d?.processes || []).filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()) || String(p.pid).includes(q));
    return [...list].sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return sort.desc ? -c : c;
    });
  }, [d, sort, q]);
  const cols: [SortKey, string][] = [['name', 'Process'], ['pid', 'PID'], ['cpu', 'CPU'], ['memory', 'Memory'], ['elapsed', 'Elapsed']];
  const head = (key: SortKey, label: string) => (
    <TableHead key={key} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button className={`sort ${sort.key === key ? 'on' : ''}`} onClick={() => setSort(s => ({key, desc: s.key === key ? !s.desc : key !== 'name'}))}>
        {label}{sort.key === key ? (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />) : <ArrowUpDown size={12} />}
      </button>
    </TableHead>
  );
  const maxCpu = Math.max(1, ...rows.map(p => p.cpu));
  return (
    <Panel title="Top processes" sub="CPU values are lifetime averages reported by ps" action={<SearchBox value={q} onChange={setQ} placeholder="Filter by name or PID" />}>
      {!d ? <div className="pad"><Skeleton h={120} /></div> : !rows.length ? <Empty icon={Search} title="No matching processes" /> :
        <Table>
          <TableHeader><TableRow>{cols.map(([k, l]) => head(k, l))}</TableRow></TableHeader>
          <TableBody>{rows.map((p: Proc) => (
            <TableRow key={p.pid}>
              <TableCell><strong className="pname">{p.name}</strong></TableCell>
              <TableCell className="mono dim">{p.pid}</TableCell>
              <TableCell><div className="cell-bar"><span>{p.cpu.toFixed(1)}%</span><i style={{width: `${(p.cpu / maxCpu) * 100}%`}} /></div></TableCell>
              <TableCell>{p.memory.toFixed(1)}%</TableCell>
              <TableCell className="mono dim">{elapsed(p.elapsed)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>}
    </Panel>
  );
}

/* ---------- events ---------- */

export function EventsPanel({d, now}: {d: Status | null; now: number}) {
  const events = (d?.events || []).filter(e => !/^Polling (paused|resumed)/.test(e.message)).slice(0, 6);
  return (
    <Panel title="Recent activity" sub="Actions taken through this dashboard since the agent started">
      {events.length
        ? <ol className="timeline">{events.map((e, i) => <li key={e.at + e.message + i}><i /><span>{e.message}</span><small title={new Date(e.at).toLocaleString()}>{ago(now - e.at)} · {clock(e.at)}</small></li>)}</ol>
        : <Empty icon={Activity} title="Nothing yet">Container and session actions will be listed here.</Empty>}
    </Panel>
  );
}
