import {useCallback, useEffect, useState} from 'react';
import {ArrowUpRight, Check, Clock, Copy, Globe, Info, Moon, Play, Power as PowerIcon, RefreshCw, ShieldCheck, Sun, AlertTriangle} from 'lucide-react';
import {useConfirm} from './components/confirm';
import {Switch} from '@/components/ui/switch';
import {toast} from 'sonner';
import {Empty, Panel, Pill, Skeleton} from './components/panels';
import DesktopPanel from './DesktopPanel';

type Config = {enabled: boolean; sleepTime: string; wakeTime: string; blockSsh: boolean; blockTmux: boolean; services: Record<string, boolean>};
type HostedService = {id: string; remoteUrl?: string; unit: string; name: string; description: string; scope: string; state: string; subState: string; pid: number | null; memory: number | null; cpuSeconds: number | null; startedAt: string | null; bootEnabled: boolean; restart: string; type: string; preventSleep: boolean; blockingNow: boolean; url?: string; port?: number; manual?: boolean; error?: string; responding?: boolean; endpointStatus?: number; job?: {timer: string | null; next: string | null; lastStart: string | null; lastExit: string | null; result: string | null; exitStatus: number}};
type Power = {setupCommand: string; installed: boolean; serviceControl?: boolean; config: Config; configError?: string; timezone: string; timerState: string; nextAttempt: string | null; lastAttempt: string | null; lastOutcome: string; lastReasons: string[]; services: HostedService[]; error?: string};


const duration = (date: string | null) => {
  if (!date) return '—';
  const start = Date.parse(date);
  if (!Number.isFinite(start)) return date;
  const minutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const rel = (iso: string | null) => {
  if (!iso) return '—';
  const diff = Date.parse(iso) - Date.now(), m = Math.round(Math.abs(diff) / 60000);
  const txt = m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return diff > 0 ? `in ${txt}` : `${txt} ago`;
};
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const sleepLength = (from: string, to: string) => { const m = (toMin(to) - toMin(from) + 1440) % 1440 || 1440; return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };

/** 24-hour bar showing the nightly sleep window and the current time. */
function DayTimeline({sleep, wake, enabled, timezone}: {sleep: string; wake: string; enabled: boolean; timezone: string}) {
  const s = toMin(sleep) / 1440 * 100, w = toMin(wake) / 1440 * 100;
  const segments = s <= w ? [[s, w - s]] : [[s, 100 - s], [0, w]];
  let nowPct = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone}).format(new Date()).split(':').map(Number);
    nowPct = ((parts[0] % 24) * 60 + parts[1]) / 1440 * 100;
  } catch { nowPct = (new Date().getHours() * 60 + new Date().getMinutes()) / 1440 * 100; }
  return (
    <div className={`day-timeline ${enabled ? '' : 'disabled'}`} aria-label={`Sleeps ${sleep} to ${wake}`}>
      <div className="day-bar">
        {segments.map(([left, width], i) => <span key={i} className="day-sleep" style={{left: `${left}%`, width: `${width}%`}} />)}
        <span className="day-now" style={{left: `${nowPct}%`}}><em>now</em></span>
      </div>
      <div className="day-hours">{[0, 6, 12, 18, 24].map(h => <span key={h}>{String(h).padStart(2, '0')}:00</span>)}</div>
    </div>
  );
}

export default function PowerPanel({mode, token}: {mode: 'services' | 'settings'; token?: string}) {
  const [power, setPower] = useState<Power | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const ask = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/power');
      if (!r.ok) throw Error('Unable to read sleep settings');
      const value = await r.json() as Power;
      setPower(value);
      setDraft(old => old ?? structuredClone(value.config));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { const first = setTimeout(refresh, 0); const id = setInterval(refresh, 15000); return () => { clearTimeout(first); clearInterval(id); }; }, [refresh]);

  const save = async (config: Config) => {
    if (!token) return;
    setSaving(true);
    try {
      const r = await fetch('/api/power', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify(config)});
      const value = await r.json() as Power & {error?: string};
      if (!r.ok) throw Error(value.error || 'Could not save settings');
      setPower(value);
      setDraft(structuredClone(value.config));
      toast.success('Sleep policy saved');
      setError('');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const control = async (s: HostedService, action: 'start' | 'stop' | 'restart') => {
    if (!token) return;
    if (action !== 'start') {
      const self = s.id === 'user:homebase.service';
      const ok = await ask({
        title: `${action === 'stop' ? 'Stop' : 'Restart'} ${s.name}?`,
        body: self ? 'The dashboard will disconnect for a few seconds and reconnect automatically.'
          : `${s.unit} will be ${action === 'stop' ? 'stopped' : 'restarted'}. Anyone using it will be disconnected${action === 'stop' ? ' until you start it again' : ' briefly'}.${action === 'stop' && s.bootEnabled ? ' It will still start again at the next boot.' : ''}`,
        confirm: action === 'stop' ? 'Stop service' : 'Restart service', destructive: action === 'stop',
      });
      if (!ok) return;
    }
    setPending(s.id);
    try {
      const r = await fetch('/api/action', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify({kind: 'service', id: s.id, action})});
      const result = await r.json() as {error?: string; output?: string};
      if (!r.ok) throw Error(result.error || 'Request failed');
      toast.success(result.output || `${s.name}: ${action} requested`);
      await refresh();
      if (s.job) [3000, 8000, 20000].forEach(ms => setTimeout(refresh, ms));
    } catch (e) {
      toast.error((e as Error).message, {duration: 10000});
    } finally {
      setPending(null);
    }
  };
  const disabled = saving || !token || !power?.installed;
  if (!power) return error
    ? <div className="error-banner">{error}</div>
    : <div className="power-view"><div className="power-summary">{[0, 1, 2].map(i => <div key={i}><Skeleton h={44} /></div>)}</div><Skeleton h={260} /></div>;

  const serviceUrl = (s: HostedService) => {
    if (!window.location.hostname.endsWith('.ts.net')) return s.url;
    if (s.id === 'user:homebase.service') return window.location.origin;
    return s.remoteUrl?.replaceAll('{hostname}', window.location.hostname);
  };
  const startup = (s: HostedService) => s.manual ? 'Running manually' : s.bootEnabled ? 'Starts at boot' : s.type === 'oneshot' ? 'Scheduled / on demand' : 'Not enabled at boot';
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(power.config);
  const active = power.services.filter(s => s.state === 'active');
  const blocking = power.services.filter(s => s.blockingNow);

  return (
    <div className="power-view">
      {error && <div role="alert" className="error-banner">{error}</div>}
      {power.configError && <div className="error-banner">{power.configError}</div>}
      {!power.installed && (
        <div className="setup-notice">
          <ShieldCheck size={20} />
          <div>
            <strong>One-time administrator setup</strong>
            <p>Monitoring is live. To save sleep settings from here, run this once in a terminal. It connects the dashboard to your existing sleep policy.</p>
            <div className="setup-command">
              <code>{power.setupCommand}</code>
              <button className="button" aria-label="Copy setup command" onClick={() => navigator.clipboard.writeText(power.setupCommand).then(() => toast.success('Setup command copied')).catch(() => toast.error('Copy the displayed command manually'))}><Copy size={14} /></button>
            </div>
          </div>
        </div>
      )}

      {mode === 'services' && power.installed && !power.serviceControl && power.services.some(s => s.scope === 'system') && (
        <div className="setup-notice">
          <ShieldCheck size={20} />
          <div>
            <strong>Enable start/stop for system services</strong>
            <p>User services can be controlled now. System services such as Ollama need one more admin step: re-run the installer to add a rule that only allows start, stop, and restart of the custom units listed here.</p>
            <div className="setup-command">
              <code>{power.setupCommand}</code>
              <button className="button" aria-label="Copy setup command" onClick={() => navigator.clipboard.writeText(power.setupCommand).then(() => toast.success('Setup command copied')).catch(() => toast.error('Copy the displayed command manually'))}><Copy size={14} /></button>
            </div>
          </div>
        </div>
      )}
      {mode === 'services' ? <>
        <div className="power-summary">
          <div><span className="summary-icon"><Globe size={17} /></span><div><strong>{active.length}<small> / {power.services.length}</small></strong><span>services running</span></div></div>
          <div><span className={`summary-icon ${blocking.length ? 'amber' : ''}`}><ShieldCheck size={17} /></span><div><strong>{blocking.length}</strong><span>{blocking.length ? `blocking sleep: ${blocking.map(s => s.name).join(', ')}` : 'preventing sleep'}</span></div></div>
          <div><span className="summary-icon violet"><Moon size={17} /></span><div><strong>{power.config.enabled ? power.config.sleepTime : 'Off'}</strong><span>nightly sleep attempt</span></div></div>
        </div>
        <Panel title="Hosted services" sub="Custom system and user services · refreshed every 15 seconds"
          action={<button className="text-button" onClick={refresh}><RefreshCw size={14} /> Refresh</button>}>
          {!power.services.length ? <Empty icon={Globe} title="No custom services found" /> :
          <div className="hosted-services">{power.services.map(s => {
            const url = serviceUrl(s);
            const up = s.state === 'active' || (!!s.job && s.state === 'activating');
            return (
              <article className={`hosted-service ${up ? 'up' : 'down'}`} key={s.id}>
                <div className="hosted-title">
                  <span className="hosted-icon"><Globe size={19} /></span>
                  <div><h3>{s.name}</h3>{s.description && s.description !== s.unit && s.description !== s.name && <p>{s.description}</p>}</div>
                  {s.job && !up
                    ? <span className={`status ${s.job.result && s.job.result !== 'success' ? 'failed' : 'muted'}`}><i />{s.job.result && s.job.result !== 'success' ? 'Last run failed' : 'Scheduled job'}</span>
                    : <Pill on={up}>{up ? (s.job ? 'Running now' : s.subState || 'active') : s.state}</Pill>}
                </div>
                <div className="service-meta"><span className="mono">{s.unit}</span><span>·</span><span>{s.scope === 'user' ? 'User service' : 'System service'}</span>
                  {url && up && <a href={url} target="_blank" rel="noreferrer" className="service-open">Open <ArrowUpRight size={13} /></a>}
                </div>
                {s.job ? <div className="service-metrics">
                  <div><span>Schedule</span><strong className="mono">{s.job.timer || 'Manual only'}</strong></div>
                  <div><span>Next run</span><strong>{up ? 'Running now…' : rel(s.job.next)}</strong></div>
                  <div><span>Last run</span><strong>{rel(s.job.lastExit || s.job.lastStart)}</strong>
                    {s.job.lastStart && s.job.lastExit && <small className={s.job.result === 'success' ? 'lime' : 'service-error'}>{s.job.result === 'success' ? 'Succeeded' : `Failed (${s.job.result}${s.job.exitStatus ? `, exit ${s.job.exitStatus}` : ''})`} · took {Math.max(0, Math.round((Date.parse(s.job.lastExit) - Date.parse(s.job.lastStart)) / 1000))}s</small>}</div>
                  <div><span>Type</span><strong>Runs, then exits</strong></div>
                </div> : <div className="service-metrics">
                  <div><span>Endpoint</span><strong className="mono">{s.port ? `:${s.port}` : 'Background'}</strong>
                    {s.responding !== undefined && <small className={s.responding ? 'lime' : 'service-error'}>{s.responding ? 'Responding' : 'Not responding'}</small>}</div>
                  <div><span>Uptime</span><strong>{up ? duration(s.startedAt) : '—'}</strong></div>
                  <div><span>Memory</span><strong>{s.memory === null ? '—' : `${(s.memory / 1024 / 1024).toFixed(0)} MB`}</strong></div>
                  <div><span>Startup</span><strong className={s.bootEnabled ? 'lime' : ''}>{startup(s)}</strong></div>
                </div>}
                {!s.manual && (
                  <div className="service-controls">
                    {s.job && !up ? <button className="button small primary" disabled={!token || !!pending || (s.scope === 'system' && !power.serviceControl)} onClick={() => control(s, 'start')}><Play size={13} className={pending === s.id ? 'spin' : ''} /> {pending === s.id ? 'Starting…' : 'Run now'}</button>
                    : up ? <>
                      <button className="button small" disabled={!token || !!pending || (s.scope === 'system' && !power.serviceControl)} onClick={() => control(s, 'restart')}><RefreshCw size={13} className={pending === s.id ? 'spin' : ''} /> Restart</button>
                      {s.id !== 'user:homebase.service' && <button className="button small danger-outline" disabled={!token || !!pending || (s.scope === 'system' && !power.serviceControl)} onClick={() => control(s, 'stop')}><PowerIcon size={13} /> Stop</button>}
                    </> : <button className="button small primary" disabled={!token || !!pending || (s.scope === 'system' && !power.serviceControl)} onClick={() => control(s, 'start')}><Play size={13} className={pending === s.id ? 'spin' : ''} /> {pending === s.id ? 'Starting…' : 'Start'}</button>}
                    {s.scope === 'system' && !power.serviceControl && <span className="control-hint">System service · needs updated admin setup</span>}
                  </div>
                )}
                <div className="service-policy">
                  <div><strong>Prevent sleep while running</strong><p>{s.preventSleep ? 'Keeps the server awake whenever this service is active.' : 'Allows sleep; the process resumes when the server wakes.'}</p></div>
                  <Switch aria-label={`Prevent sleep while ${s.name} is running`} checked={s.preventSleep} disabled={disabled || !!s.manual}
                    onCheckedChange={checked => save({...power.config, services: {...power.config.services, [s.id]: checked}})} />
                </div>
                <div className="service-recovery">
                  {s.restart === 'always' || s.restart === 'on-failure' ? <Check size={13} /> : <Info size={13} />}
                  <span>{s.restart === 'always' || s.restart === 'on-failure' ? `Auto-recovers · restart ${s.restart.replaceAll('-', ' ')}` : 'No automatic crash recovery'}</span>
                  {s.blockingNow && <span className="blocking-label"><AlertTriangle size={12} /> Blocking sleep now</span>}
                </div>
                {s.error && <p className="service-error">{s.error}</p>}
              </article>
            );
          })}</div>}
        </Panel>
        <div className="power-explainer"><Info size={16} /><p>Turning off a service’s sleep block does not bypass your CPU, network, backup, GPU, SSH, or tmux safeguards. Suspend pauses running services in memory; they continue after wake. Boot-enabled services also return after a reboot.</p></div>
      </> : draft && <>
        <div className="sleep-schedule">
          <div className="schedule-ends">
            <div><span className="schedule-icon"><Moon size={22} /></span><div><small>Sleep attempt</small><strong>{power.config.sleepTime}</strong></div></div>
            <div className="schedule-mid"><span>{power.config.enabled ? `${sleepLength(power.config.sleepTime, power.config.wakeTime)} of power saving` : 'Schedule disabled'}</span></div>
            <div><span className="schedule-icon morning"><Sun size={22} /></span><div><small>Wake up</small><strong>{power.config.wakeTime}</strong></div></div>
          </div>
          <DayTimeline sleep={draft.sleepTime} wake={draft.wakeTime} enabled={draft.enabled} timezone={power.timezone} />
          <div className="schedule-foot"><span><Clock size={13} /> Next attempt: {power.nextAttempt || 'Not scheduled'}</span><span>{power.timezone}</span></div>
        </div>

        <form onSubmit={e => { e.preventDefault(); save(draft); }} className="power-form">
          <Panel title="Nightly schedule" sub="Uses your existing system timer and RTC wake alarm.">
            <div className="setting-row">
              <div><label htmlFor="night-enabled">Automatic nightly sleep</label><p>Attempt suspend once each night when no sleep blockers are present.</p></div>
              <Switch id="night-enabled" checked={draft.enabled} disabled={disabled} onCheckedChange={enabled => setDraft({...draft, enabled})} />
            </div>
            <div className="schedule-inputs">
              <div><label htmlFor="sleep-time">Sleep at</label><input id="sleep-time" type="time" required value={draft.sleepTime} disabled={disabled} onChange={e => setDraft({...draft, sleepTime: e.target.value})} /></div>
              <div><label htmlFor="wake-time">Wake at</label><input id="wake-time" type="time" required value={draft.wakeTime} disabled={disabled} onChange={e => setDraft({...draft, wakeTime: e.target.value})} /></div>
              <p>Times use {power.timezone}. If the server is busy, that night’s sleep is skipped. Wake time is the next occurrence after sleep.</p>
            </div>
          </Panel>

          <Panel title="Activity safeguards" sub="Choose whether open connections and terminals should prevent sleep.">
            <div className="setting-row">
              <div><label htmlFor="ssh-block">SSH connections prevent sleep</label><p>Includes idle connections and SSH tunnels used to access this dashboard.</p></div>
              <Switch id="ssh-block" disabled={disabled} checked={draft.blockSsh} onCheckedChange={blockSsh => setDraft({...draft, blockSsh})} />
            </div>
            <div className="setting-row">
              <div><label htmlFor="tmux-block">Non-shell tmux commands prevent sleep</label><p>Includes Claude and Codex waiting for input inside a tmux pane.</p></div>
              <Switch id="tmux-block" disabled={disabled} checked={draft.blockTmux} onCheckedChange={blockTmux => setDraft({...draft, blockTmux})} />
            </div>
            <div className="fixed-safeguards">
              <ShieldCheck size={16} />
              <div>
                <strong>Workload protection is always on</strong>
                <ul>{['System CPU ≥ 15%', 'Container CPU ≥ 10%', 'Network ≥ 1 MiB/s', 'Backups & transfers', 'GPU jobs & load (NVIDIA, AMD, Intel)', 'Sleep inhibitors & overrides'].map(x => <li key={x}>{x}</li>)}</ul>
              </div>
            </div>
          </Panel>

          <div className={`save-settings ${dirty ? 'dirty' : ''}`}>
            <span>{dirty ? <><i /> Unsaved changes</> : <><Check size={13} /> Settings match the saved policy</>}</span>
            <button type="button" className="button" disabled={saving || !dirty} onClick={() => setDraft(structuredClone(power.config))}>Reset</button>
            <button className="button primary" disabled={disabled || !dirty}>{saving ? 'Saving…' : 'Save settings'}</button>
          </div>
        </form>

        <DesktopPanel token={token} />

        <Panel title="Last nightly check" sub={power.lastAttempt || 'No previous attempt recorded'} action={<Pill on={/resum|suspend/i.test(power.lastOutcome)}>{power.lastOutcome}</Pill>}>
          <div className="sleep-history">
            {power.lastReasons.length
              ? <ul>{power.lastReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
              : <p>No blocking reasons recorded in the latest check.</p>}
            <div><Clock size={14} /><span>Next attempt: {power.nextAttempt || 'Not scheduled'} · Timer {power.timerState}</span></div>
          </div>
        </Panel>
      </>}
    </div>
  );
}
