import {useCallback, useEffect, useRef, useState} from 'react';
import {AlertTriangle, ArrowUpRight, Check, Copy, Download, RefreshCw, ShieldCheck} from 'lucide-react';
import {toast} from 'sonner';
import {useConfirm} from './components/confirm';
import {Panel, Pill, Skeleton} from './components/panels';
import {ago} from './lib/format';

type UpdateState = {
  current: string; instance: string; repo: string; sourceCheckout: boolean; method: 'release' | 'git'; blocked: string | null; autoCheck: boolean;
  latest: {version: string; name: string; notes: string; url: string; publishedAt: string} | null;
  available: boolean; checkedAt: number | null; error: string | null;
  job: {state: 'downloading' | 'installing' | 'done' | 'failed'; version: string; at: number; error?: string; log?: string} | null;
  rootIntegration: {installed: boolean; outdated: string[]; command?: string};
};

async function post(token: string | undefined, action: 'check' | 'apply'): Promise<UpdateState> {
  if (!token) throw Error('Still connecting, try again in a moment');
  const r = await fetch('/api/update', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify({action})});
  const j = await r.json();
  if (!r.ok) throw Error(j.error || 'Request failed');
  return j;
}

const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => toast.error('Copy failed'));

/** `autoStart` changes (e.g. the top-bar Update button) → run the update flow once, with confirmation. */
export default function UpdatePanel({token, now, autoStart = 0}: {token?: string; now: number; autoStart?: number}) {
  const ask = useConfirm();
  const [u, setU] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);
  const [waitingFor, setWaitingFor] = useState<string | null>(null); // version we expect after the restart
  const startedFrom = useRef<string | null>(null); // server instance the update started on

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/update', {signal: AbortSignal.timeout(8000)});
      if (!r.ok) return;
      const j: UpdateState = await r.json();
      setU(j);
      // An update started elsewhere (top bar, another tab) is running: follow it to the restart.
      if (!startedFrom.current && (j.job?.state === 'installing' || j.job?.state === 'downloading')) { startedFrom.current = j.instance; setWaitingFor(j.job.version); }
      // A new server process answered: the update restarted Homebase. Reload so the new dashboard code is used too.
      if (startedFrom.current && j.instance !== startedFrom.current) {
        toast.success(`Updated to Homebase ${j.current}`);
        setTimeout(() => window.location.reload(), 800);
      }
      if (j.job?.state === 'failed' && startedFrom.current) { startedFrom.current = null; setWaitingFor(null); }
    } catch { /* restarting: keep polling */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!waitingFor) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [waitingFor, load]);

  const check = async () => {
    setBusy('check');
    try {
      const j = await post(token, 'check');
      setU(j);
      if (j.error) toast.error(j.error);
      else toast.success(j.available ? `Homebase ${j.latest?.version} is available` : 'Homebase is up to date');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };

  const apply = useCallback(async (u: UpdateState) => {
    if (!u.latest) return;
    if (u.blocked) { toast.error(u.blocked); return; }
    const ok = await ask({
      title: `Update to Homebase ${u.latest.version}?`,
      body: <>
        {u.method === 'git'
          ? <p>This copy runs from a git checkout: Homebase runs <code>git pull --ff-only</code> and <code>./install.sh --in-place</code>, then restarts. Your settings are kept.</p>
          : <p>Homebase downloads the release from <span className="mono">github.com/{u.repo}</span>, checks its SHA-256, installs it over the current version and restarts. Your settings are kept.</p>}
        <p>The dashboard is unavailable for a few seconds and reloads by itself.</p>
      </>,
      confirm: 'Update and restart',
    });
    if (!ok) return;
    setBusy('apply');
    try {
      startedFrom.current = u.instance;
      setWaitingFor(u.latest.version);
      setU(await post(token, 'apply'));
    } catch (e) {
      startedFrom.current = null;
      setWaitingFor(null);
      toast.error((e as Error).message);
    } finally { setBusy(null); }
  }, [ask, token]);

  // Top-bar button: run once per press, as soon as the status is loaded.
  const handled = useRef(0);
  useEffect(() => {
    if (!autoStart || autoStart === handled.current || !u) return;
    handled.current = autoStart;
    void apply(u);
  }, [autoStart, u, apply]);

  if (!u) return <Panel title="Homebase" sub="App version and updates"><div className="update-body"><Skeleton h={18} w="60%" /></div></Panel>;

  const job = u.job, updating = !!waitingFor || job?.state === 'installing' || job?.state === 'downloading';
  const status = updating ? <Pill on>Updating…</Pill>
    : u.available ? <span className="status warn"><i />Update available</span>
    : u.latest ? <Pill on>Up to date</Pill> : null;

  return (
    <Panel title="Homebase" sub={<>Version <span className="mono">{u.current}</span> · updates from <a href={`https://github.com/${u.repo}/releases`} target="_blank" rel="noreferrer">github.com/{u.repo}</a></>}
      className="update-panel"
      action={<button className="button small" onClick={check} disabled={!!busy || updating}><RefreshCw size={13} className={busy === 'check' ? 'spin' : ''} /> Check now</button>}>
      <div className="update-body">
        <div className="update-row">
          <div>
            <strong>{updating ? `Installing ${waitingFor || job?.version}` : u.available ? `Homebase ${u.latest!.version} is available` : `Homebase ${u.current}`}</strong>
            <small>
              {u.checkedAt ? `Checked ${ago(Math.max(0, now - u.checkedAt))}` : u.autoCheck ? 'Not checked yet' : 'Automatic checks are off'}
              {u.latest && <> · latest <a href={u.latest.url} target="_blank" rel="noreferrer">{u.latest.version} <ArrowUpRight size={11} /></a></>}
              {u.error && <> · <span className="warn-text">{u.error}</span></>}
            </small>
          </div>
          {status}
        </div>

        {u.available && !updating && <>
          <button className="button primary" onClick={() => apply(u)} disabled={!!busy || !!u.blocked}><Download size={14} /> Update to {u.latest!.version}</button>
          {u.blocked && <div className="update-note"><AlertTriangle size={14} /><span>{u.blocked}</span></div>}
          {u.method === 'git' && !u.blocked && <small className="update-hint">Git checkout: updates with <code>git pull --ff-only</code>.</small>}
        </>}

        {updating && <div className="update-note info"><RefreshCw size={14} className="spin" /><span>Downloading, verifying and installing. The dashboard restarts and reloads by itself; this usually takes under a minute.</span></div>}

        {job?.state === 'failed' && !updating && <div className="update-note"><AlertTriangle size={14} /><div><strong>{job.error || 'The update failed.'}</strong>{job.log && <pre>{job.log}</pre>}</div></div>}

        {u.available && u.latest?.notes && !updating && <details className="update-notes"><summary>What’s new in {u.latest.version}</summary><pre>{u.latest.notes}</pre></details>}

        {u.rootIntegration.installed && (u.rootIntegration.outdated.length
          ? <div className="update-note"><ShieldCheck size={14} /><div>
              <strong>Sleep & power scripts need a refresh</strong>
              <span>The root-installed {u.rootIntegration.outdated.join(', ')} differ from this version. Run once (asks for your password):</span>
              <span className="update-cmd"><code>{u.rootIntegration.command}</code><button className="icon-button" aria-label="Copy command" onClick={() => copy(u.rootIntegration.command!)}><Copy size={13} /></button></span>
            </div></div>
          : <div className="update-ok"><Check size={13} /> Sleep & power scripts match this version</div>)}
      </div>
    </Panel>
  );
}
