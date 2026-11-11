import {useCallback, useEffect, useState} from 'react';
import {Copy, Monitor, MonitorOff, RefreshCw} from 'lucide-react';
import {toast} from 'sonner';
import {useConfirm} from './components/confirm';
import {Panel, Pill} from './components/panels';

type Desktop = {
  installed: boolean; manager: string | null; running: boolean; state: string; bootDefault: string; bootsToDesktop: boolean;
  sessions: {user: string; type: string; active: boolean}[]; memory: number | null; control: boolean; setupCommand: string;
};
const mb = (b: number) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;

/** Turn the server's graphical desktop on or off (now and at boot) to free memory and GPU. */
export default function DesktopPanel({token}: {token?: string}) {
  const [d, setD] = useState<Desktop | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = useConfirm();
  const refresh = useCallback(async () => {
    try { const r = await fetch('/api/desktop'); if (r.ok) setD(await r.json() as Desktop); } catch { /* next poll */ }
  }, []);
  useEffect(() => { const first = setTimeout(refresh, 0); const id = setInterval(refresh, 15000); return () => { clearTimeout(first); clearInterval(id); }; }, [refresh]);
  if (!d || !d.installed) return null;

  const switchTo = async (action: 'on' | 'off') => {
    if (!token) return;
    if (action === 'off') {
      const people = d.sessions.map(s => s.user);
      const ok = await ask({
        title: 'Turn off the desktop?',
        body: <>
          <p>{people.length ? <>Desktop sessions on the server ({[...new Set(people)].join(', ')}) are signed out, and <strong>unsaved work in desktop apps is lost</strong>.</> : 'The login screen is stopped.'}</p>
          <p>SSH, Tailscale, Homebase, tmux sessions and your hosted services keep running. The server boots without the desktop from now on, until you turn it back on here.</p>
        </>,
        confirm: 'Turn off desktop', destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/action', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify({kind: 'desktop', action})});
      const result = await r.json() as {error?: string; output?: string; desktop?: Desktop};
      if (!r.ok) throw Error(result.error || 'Request failed');
      if (result.desktop) setD(result.desktop);
      toast.success(result.output || `Desktop turned ${action}`);
      [3000, 10000].forEach(ms => setTimeout(refresh, ms));
    } catch (e) {
      toast.error((e as Error).message, {duration: 10000});
    } finally {
      setBusy(false);
    }
  };

  const copy = () => navigator.clipboard.writeText(d.setupCommand).then(() => toast.success('Setup command copied')).catch(() => toast.error('Copy the displayed command manually'));
  const mismatch = d.running !== d.bootsToDesktop;
  return (
    <Panel title="Desktop (GUI)" sub={`${d.manager || 'Display manager'} · a headless server does not need it; turning it off frees memory and the GPU`}
      action={<Pill on={d.running}>{d.running ? 'On' : d.state === 'inactive' ? 'Off' : d.state}</Pill>}>
      <div className="setting-row">
        <div>
          <label style={{display: "inline-flex", alignItems: "center", gap: 6}}>{d.running ? <><Monitor size={14} /> Desktop is running</> : <><MonitorOff size={14} /> Desktop is off</>}</label>
          <p>
            {d.running
              ? <>{d.sessions.length ? `${d.sessions.length} desktop session${d.sessions.length === 1 ? '' : 's'} (${d.sessions.map(s => `${s.user}, ${s.type}`).join('; ')})` : 'Login screen only, nobody signed in'}{d.memory ? <> · using about <strong>{mb(d.memory)}</strong> of memory</> : null}.</>
              : 'Only the text console is available on the server’s screen. Manage it over SSH or from here.'}
            {' '}{d.bootsToDesktop ? 'Starts at boot.' : 'Does not start at boot.'}
            {mismatch && ' The boot setting differs from what is running now; pressing the button sets both.'}
          </p>
        </div>
        {d.running
          ? <button className="button danger-outline" disabled={!token || busy || !d.control} onClick={() => switchTo('off')}><MonitorOff size={14} className={busy ? 'spin' : ''} /> {busy ? 'Turning off…' : 'Turn off'}</button>
          : <button className="button primary" disabled={!token || busy || !d.control} onClick={() => switchTo('on')}>{busy ? <RefreshCw size={14} className="spin" /> : <Monitor size={14} />} {busy ? 'Starting…' : 'Turn on'}</button>}
      </div>
      {!d.control && (
        <div className="setup-command">
          <span className="control-hint">Needs the updated admin setup. Run once on the server (asks for your password):</span>
          <code>{d.setupCommand}</code>
          <button className="button" aria-label="Copy setup command" onClick={copy}><Copy size={14} /></button>
        </div>
      )}
    </Panel>
  );
}
