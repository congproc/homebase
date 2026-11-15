import {useCallback, useEffect, useState} from 'react';
import {AlertTriangle, ArrowRight, Check, Copy, Cpu, Gauge, Info, Leaf, Lightbulb, RefreshCw, Rocket, Scale, Sparkles, Zap} from 'lucide-react';
import {toast} from 'sonner';
import {Switch} from '@/components/ui/switch';
import {Panel, Pill} from './components/panels';
import {ago, money, watts} from './lib/format';

type ProfileName = 'eco' | 'balanced' | 'performance';
type Mode = 'off' | 'auto' | ProfileName;
type Settings = {mode: Mode; idleProfile: 'eco' | 'balanced'; cpuBusy: number; gpuBusy: number; ollamaBoost: boolean; calmMinutes: number};
type SmiGpu = {index: number; name: string; utilization: number | null; draw: number | null; limit: number | null; min: number | null; default: number | null; pstate: string};
type ProfileState = {
  settings: Settings; current: ProfileName | null; since: number | null; reason: string; error: string | null;
  switches: {at: number; profile: ProfileName; reason: string}[]; control: boolean; setupCommand: string;
  system: {ppd: string | null; epp: string | null; governor: string | null; cpuLimit: number | null; cpuBurst: number | null; gpus: SmiGpu[]};
  report: {month: string; profiles: Partial<Record<ProfileName, {hours: number; measuredHours: number; avgWatts: number | null}>>}[];
  signals: {cpu: number; gpu: number | null; models: number; at: number} | null;
  watts: number | null; pricePerKwh: number | null; currency: string;
};
type Advice = {id: string; status: 'suggest' | 'info' | 'ok'; title: string; detail: string; watts?: number | null; wattsNote?: string;
  action?: {kind: 'page'; page: string; label: string} | {kind: 'profile'} | {kind: 'command'; command: string; label: string} | {kind: 'note'; label: string}};
type AdviceState = {items: Advice[]; watts: number | null; pricePerKwh: number | null; currency: string};

const PROFILE_INFO: Record<ProfileName, {label: string; icon: React.ElementType; blurb: string}> = {
  eco: {label: 'Eco', icon: Leaf, blurb: 'CPU in power-saver, sustained CPU power about half its rating, GPU at its lowest power limit.'},
  balanced: {label: 'Balanced', icon: Scale, blurb: 'Stock sustained CPU power with shorter bursts, GPU limit halfway.'},
  performance: {label: 'Performance', icon: Rocket, blurb: 'Full firmware CPU limits and the GPU’s default power limit.'},
};
const MODES: {id: Mode; label: string}[] = [{id: 'off', label: 'Off'}, {id: 'auto', label: 'Auto'}, {id: 'eco', label: 'Eco'}, {id: 'balanced', label: 'Balanced'}, {id: 'performance', label: 'Performance'}];
const HOURS_PER_MONTH = 24 * 30;
const monthly = (w: number, price: number | null, currency: string) => price ? money((w * HOURS_PER_MONTH / 1000) * price, currency) : null;
const monthName = (key: string) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString([], {month: 'long'}); };

async function post(token: string, body: object) {
  const r = await fetch('/api/profile', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify(body)});
  const result = await r.json();
  if (!r.ok) throw Error(result.error || 'Request failed');
  return result as ProfileState;
}

function usePolled<T>(url: string, every: number) {
  const [data, setData] = useState<T | null>(null);
  const refresh = useCallback(async () => {
    try { const r = await fetch(url); if (r.ok) setData(await r.json() as T); } catch { /* next poll */ }
  }, [url]);
  useEffect(() => { const first = setTimeout(refresh, 0); const id = setInterval(refresh, every); return () => { clearTimeout(first); clearInterval(id); }; }, [refresh, every]);
  return [data, setData, refresh] as const;
}

const copy = (text: string, what = 'Command') => navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`)).catch(() => toast.error('Copy it manually'));

/** Eco / Balanced / Performance, or Auto: frugal while idle, full power the moment the server gets busy. */
export function PowerProfilePanel({token, now}: {token?: string; now: number}) {
  const [p, setP] = usePolled<ProfileState>('/api/profile', 10000);
  const [edit, setDraft] = useState<Settings | null>(null); // unsaved Auto rules; null = showing the saved ones
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const draft = edit ?? p.settings;

  const save = async (next: Partial<Settings>) => {
    if (!token) return;
    setBusy(true);
    try {
      const result = await post(token, {...p.settings, ...next});
      setP(result); setDraft(null);
      toast.success(result.settings.mode === 'off' ? 'Homebase no longer changes the power profile' : `Power profile: ${MODES.find(m => m.id === result.settings.mode)?.label}`);
    } catch (e) { toast.error((e as Error).message, {duration: 10000}); }
    finally { setBusy(false); }
  };
  const mode = p.settings.mode;
  const autoDirty = (['idleProfile', 'cpuBusy', 'gpuBusy', 'ollamaBoost', 'calmMinutes'] as const).some(k => draft[k] !== p.settings[k]);
  const gpu = p.system.gpus[0];
  const status = mode === 'off' ? 'Not managed' : p.current ? PROFILE_INFO[p.current].label : 'Applying…';
  const sub = mode === 'off' ? 'Homebase leaves the CPU and GPU power settings as the system set them'
    : mode === 'auto' ? `Auto · ${p.current ? PROFILE_INFO[p.current].label : '…'}${p.reason ? ` · ${p.reason}` : ''}${p.since ? ` · since ${ago(Math.max(0, now - p.since))}` : ''}`
    : `Fixed ${PROFILE_INFO[mode].label} profile`;

  // Savings report: hours spent below Performance, priced by how much less they measured than Performance did.
  const month = p.report[0];
  const perf = month?.profiles.performance?.avgWatts ?? null;
  const saved = month && perf != null ? (['eco', 'balanced'] as const).reduce((wh, k) => {
    const v = month.profiles[k]; return v?.avgWatts != null ? wh + Math.max(0, perf - v.avgWatts) * v.hours : wh;
  }, 0) : null;

  return (
    <Panel title="Power profile" sub={sub} className="profile-panel" action={<Pill on={mode !== 'off' && !!p.current}>{status}</Pill>}>
      <div className="profile-modes">
        <div className="segmented" role="radiogroup" aria-label="Power profile mode">
          {MODES.map(m => <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'selected' : ''} disabled={busy || !token || (!p.control && m.id !== 'off')} onClick={() => mode !== m.id && save({mode: m.id})}>
            {m.id === 'auto' && <Sparkles size={12} />}{m.label}
          </button>)}
        </div>
        {busy && <RefreshCw size={14} className="spin dim" />}
      </div>

      <div className="profile-cards">
        {(Object.keys(PROFILE_INFO) as ProfileName[]).map(k => {
          const I = PROFILE_INFO[k].icon, active = mode !== 'off' && p.current === k;
          return <div key={k} className={`profile-card ${k}${active ? ' active' : ''}`}>
            <span className="profile-icon"><I size={16} /></span>
            <div><strong>{PROFILE_INFO[k].label}{mode === 'auto' && (k === 'performance' ? <em>when busy</em> : k === p.settings.idleProfile ? <em>when idle</em> : null)}</strong><p>{PROFILE_INFO[k].blurb}</p></div>
            {active && <Check size={15} className="profile-check" />}
          </div>;
        })}
      </div>

      <div className="profile-now">
        <div><small><Cpu size={12} /> CPU profile</small><strong>{p.system.ppd || p.system.governor || '—'}</strong>{p.system.epp && <span>{p.system.epp.replace(/_/g, ' ')}</span>}</div>
        <div><small><Gauge size={12} /> CPU power limit</small><strong>{p.system.cpuLimit != null ? `${p.system.cpuLimit} W` : '—'}</strong>{p.system.cpuBurst != null && <span>bursts to {p.system.cpuBurst} W</span>}</div>
        <div><small><Zap size={12} /> GPU power limit</small><strong>{gpu?.limit != null ? `${Math.round(gpu.limit)} W` : '—'}</strong>{gpu && <span>{gpu.draw != null ? `drawing ${watts(gpu.draw)}` : ''}{gpu.pstate ? ` · ${gpu.pstate}` : ''}</span>}</div>
        <div><small><Zap size={12} /> Server now</small><strong>{p.watts != null ? watts(p.watts) : '—'}</strong>{p.watts != null && p.pricePerKwh ? <span>{monthly(p.watts, p.pricePerKwh, p.currency)} / month at this rate</span> : <span>from the smart plug</span>}</div>
      </div>

      {mode === 'auto' && <details className="profile-auto" open={autoDirty || undefined}>
        <summary className="profile-auto-head">
          <strong>Auto rules</strong>
          <span className="dim">Boost at CPU ≥ {p.settings.cpuBusy}%{p.system.gpus.length ? ` or GPU ≥ ${p.settings.gpuBusy}%` : ''}{p.settings.ollamaBoost ? ' or a loaded model' : ''} · back after {p.settings.calmMinutes} min{p.signals ? ` · now CPU ${Math.round(p.signals.cpu)}%` : ''}</span>
        </summary>
        <div className="profile-rules">
          <label>While idle use
            <span className="segmented small">{(['eco', 'balanced'] as const).map(k => <button type="button" key={k} className={draft.idleProfile === k ? 'selected' : ''} onClick={() => setDraft({...draft, idleProfile: k})}>{PROFILE_INFO[k].label}</button>)}</span>
          </label>
          <label>Boost when CPU ≥<span className="num-input"><input type="number" min={20} max={95} value={draft.cpuBusy} onChange={e => setDraft({...draft, cpuBusy: Number(e.target.value)})} />%</span><small>averaged over 30 s</small></label>
          {p.system.gpus.length > 0 && <label>or GPU ≥<span className="num-input"><input type="number" min={5} max={95} value={draft.gpuBusy} onChange={e => setDraft({...draft, gpuBusy: Number(e.target.value)})} />%</span></label>}
          <label className="switch-label"><Switch checked={draft.ollamaBoost} onCheckedChange={ollamaBoost => setDraft({...draft, ollamaBoost})} /> or an Ollama model is loaded</label>
          <label>Back to {PROFILE_INFO[draft.idleProfile].label} after<span className="num-input"><input type="number" min={1} max={30} value={draft.calmMinutes} onChange={e => setDraft({...draft, calmMinutes: Number(e.target.value)})} />min</span><small>quiet</small></label>
        </div>
        {autoDirty && <div className="profile-auto-save">
          <button className="button" disabled={busy} onClick={() => setDraft(null)}>Reset</button>
          <button className="button primary" disabled={busy} onClick={() => save(draft)}>Save rules</button>
        </div>}
      </details>}

      {p.error && mode !== 'off' && <div className="profile-error"><AlertTriangle size={14} /> {p.error}</div>}

      {(month || p.switches.length > 0) && <div className="profile-foot">
        {month && <div className="profile-report">
          <strong>{monthName(month.month)} so far</strong>
          <div className="profile-bars">
            {(Object.keys(PROFILE_INFO) as ProfileName[]).filter(k => month.profiles[k]).map(k => {
              const v = month.profiles[k]!, total = Object.values(month.profiles).reduce((a, x) => a + (x?.hours || 0), 0) || 1;
              return <div key={k} className={`profile-bar ${k}`}>
                <span>{PROFILE_INFO[k].label}</span>
                <i><b style={{width: `${Math.max(2, (v.hours / total) * 100)}%`}} /></i>
                <span className="mono">{v.hours.toFixed(1)} h</span>
                <span className="mono dim">{v.avgWatts != null ? `avg ${watts(v.avgWatts)}` : '—'}</span>
              </div>;
            })}
          </div>
          <p>{saved != null && saved > 0
            ? <>About <strong>{(saved / 1000).toFixed(2)} kWh</strong>{p.pricePerKwh ? <> ({money((saved / 1000) * p.pricePerKwh, p.currency)})</> : null} saved versus running on Performance all month, from the plug’s measurements in each profile.</>
            : 'Savings appear once the plug has measured time in both Performance and a lower profile.'}</p>
        </div>}
        {p.switches.length > 0 && <div className="profile-log">
          <strong>Recent switches</strong>
          <ul>{p.switches.slice(0, 5).map(s => <li key={s.at}><span className={`dot ${s.profile}`} />{PROFILE_INFO[s.profile].label}<span className="dim"> · {s.reason} · {ago(Math.max(0, now - s.at))}</span></li>)}</ul>
        </div>}
      </div>}

      {!p.control && <div className="setup-command">
        <span className="control-hint">Power profiles need the updated admin setup. Run once on the server (asks for your password):</span>
        <code>{p.setupCommand}</code>
        <button className="button" aria-label="Copy setup command" onClick={() => copy(p.setupCommand, 'Setup command')}><Copy size={14} /></button>
      </div>}
    </Panel>
  );
}

/** Measured and estimated ways to cut the server's power use, each priced per month. */
export function AdvisorPanel({go}: {go: (page: string) => void}) {
  const [a] = usePolled<AdviceState>('/api/advisor', 60000);
  if (!a) return null;
  const open = a.items.filter(i => i.status !== 'ok'), done = a.items.filter(i => i.status === 'ok');
  const potential = open.reduce((n, i) => n + (i.watts || 0), 0);
  const cost = (w: number) => monthly(w, a.pricePerKwh, a.currency);
  return (
    <Panel title="Power-saving advisor" className="advisor-panel"
      sub={open.length ? `${open.length} suggestion${open.length === 1 ? '' : 's'}${potential >= 1 ? ` · at least ${watts(potential)}${cost(potential) ? ` ≈ ${cost(potential)} a month` : ''}` : ''}` : 'Nothing left to tune on this machine'}>
      <ul className="advice-list">
        {open.map(i => <li key={i.id} className={`advice ${i.status}`}>
          <span className="advice-icon">{i.status === 'suggest' ? <Lightbulb size={15} /> : <Info size={15} />}</span>
          <div className="advice-body">
            <strong>{i.title}</strong>
            <p>{i.detail}</p>
            {i.action?.kind === 'command' && <div className="setup-command"><code>{i.action.command}</code><button className="button small" aria-label="Copy" onClick={() => copy((i.action as {command: string}).command)}><Copy size={13} /></button></div>}
          </div>
          <div className="advice-side">
            {i.watts != null && i.watts >= 0.5
              ? <><strong>−{watts(i.watts)}</strong>{cost(i.watts) && <span>{cost(i.watts)}/mo</span>}{i.wattsNote && <small>{i.wattsNote}</small>}</>
              : i.wattsNote && <small>{i.wattsNote}</small>}
            {i.action?.kind === 'page' && <button className="text-button" onClick={() => go((i.action as {page: string}).page)}>{i.action.label} <ArrowRight size={13} /></button>}
            {i.action?.kind === 'profile' && <button className="text-button" onClick={() => { go('power/save'); setTimeout(() => document.querySelector('.profile-panel')?.scrollIntoView({behavior: 'smooth'}), 50); }}>Set up Auto <ArrowRight size={13} /></button>}
            {i.action?.kind === 'note' && <span className="advice-tag">{i.action.label}</span>}
          </div>
        </li>)}
      </ul>
      {done.length > 0 && <div className="advice-done">{done.map(i => <span key={i.id} title={i.detail}><Check size={12} /> {i.title}</span>)}</div>}
    </Panel>
  );
}
