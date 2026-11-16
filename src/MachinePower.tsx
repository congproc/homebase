import {useEffect, useRef, useState} from 'react';
import {Copy, Power, RotateCw} from 'lucide-react';
import {toast} from 'sonner';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';

type Machine = {control: boolean; setupCommand: string; retryAfter: number};
type Action = 'reboot' | 'poweroff';
const COPY: Record<Action, {title: string; verb: string; busy: string}> = {
  reboot: {title: 'Restart the server?', verb: 'Restart', busy: 'Restarting…'},
  poweroff: {title: 'Power off the server?', verb: 'Power off', busy: 'Powering off…'},
};

/** Restart / power off the whole machine. Each request needs the server account's login password. */
export default function MachinePower({token, hostname, user}: {token?: string; hostname?: string; user?: string}) {
  const [m, setM] = useState<Machine | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // After a wrong password the field is re-enabled empty; put the cursor back in it.
  useEffect(() => { if (error && !busy) input.current?.focus(); }, [error, busy]);
  useEffect(() => {
    let live = true;
    fetch('/api/machine').then(r => r.ok ? r.json() : null).then(v => { if (live && v) setM(v as Machine); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const open = (a: Action, e: React.MouseEvent<HTMLButtonElement>) => { opener.current = e.currentTarget; setAction(a); setPassword(''); setError(''); };
  const close = () => { if (!busy) { setAction(null); setPassword(''); } };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !action || !password) return;
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/machine', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify({action, password})});
      const result = await r.json() as {error?: string; output?: string};
      if (!r.ok) throw Error(result.error || 'Request failed');
      setPassword(''); setAction(null);
      toast.success(result.output || 'Done', {duration: 15000});
    } catch (err) {
      setPassword('');
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = () => m && navigator.clipboard.writeText(m.setupCommand).then(() => toast.success('Setup command copied')).catch(() => toast.error('Copy the displayed command manually'));

  if (!m) return null;
  const disabled = !token || !m.control;
  const title = m.control ? undefined : 'Needs the updated admin setup';
  const c = action ? COPY[action] : null;
  return (
    <div className="machine-power">
      <button className="button small" disabled={disabled} title={title ?? 'Restart the server'} onClick={e => open('reboot', e)}><RotateCw size={13} /> Restart</button>
      <button className="button small danger-outline" disabled={disabled} title={title ?? 'Power off the server'} onClick={e => open('poweroff', e)}><Power size={13} /> Power off</button>
      {!m.control && <button className="button small machine-setup" aria-label="Needs admin setup: copy the setup command" onClick={copy}><Copy size={13} /> <span>Needs admin setup</span></button>}
      <Dialog open={!!action} onOpenChange={o => !o && close()}>
        <DialogContent onCloseAutoFocus={e => { e.preventDefault(); opener.current?.focus(); }}>
          <DialogTitle>{c?.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="confirm-body">
              {action === 'reboot'
                ? <p><strong>{hostname || 'The server'}</strong> restarts. Containers, tmux sessions, coding agents and unsaved work stop; services set to start at boot come back on their own. The dashboard is unreachable for a minute or two.</p>
                : <p><strong>{hostname || 'The server'}</strong> shuts down completely. <strong>It will not turn on again by itself</strong> (no scheduled wake): someone has to press the power button or use Wake-on-LAN. You lose access to it from here until then.</p>}
            </div>
          </DialogDescription>
          <form className="dialog-form" onSubmit={submit}>
            <label htmlFor="machine-password">Password for <span className="mono">{user || 'the server account'}</span></label>
            <input ref={input} id="machine-password" type="password" autoComplete="current-password" autoFocus value={password}
              onChange={e => { setPassword(e.target.value); setError(''); }} disabled={busy} aria-invalid={!!error} aria-describedby="machine-password-help" />
            <p id="machine-password-help" className={error ? 'form-help form-error' : 'form-help'} aria-live="assertive">
              {error || (m.retryAfter ? `Too many wrong passwords. Try again in ${Math.ceil(m.retryAfter / 60)} min.` : null) || 'The login password of the account Homebase runs as on the server. It is checked on the server and never stored.'}
            </p>
            <div className="dialog-actions">
              <button type="button" className="button" onClick={close} disabled={busy}>Cancel</button>
              <button className="button destructive" disabled={busy || !password}>{action === 'reboot' ? <RotateCw size={14} className={busy ? 'spin' : ''} /> : <Power size={14} />} {busy ? c?.busy : c?.verb}</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
