import {useEffect, useRef, useState} from 'react';
import {AlertTriangle, Ban, Trash2} from 'lucide-react';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {ago, bytes} from './lib/format';

/** POST /api/storage {action: 'delete-prepare'} (see server/usage.mjs). */
type Prepared = {id: string | null; path: string; name: string; kind: string; bytes: number; files: number; newest: number | null; blocked: string[]; warnings: string[];
  trash: {available: boolean; location?: string; error?: string} | null; needsPassword: {trash: boolean; permanent: boolean}; trashDays: number; partial: boolean};
export type DeleteResult = {mode: 'trash' | 'permanent'; freed?: number | null; trash?: string};

const post = async (token: string, body: object) => {
  const r = await fetch('/api/storage', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify(body)});
  const v = await r.json(); if (!r.ok) throw Error(v.error); return v;
};

/**
 * Two steps, both checked on the server: "prepare" re-inspects the item and returns a short-lived id bound to that
 * exact file; "delete" checks it all again and refuses if the file changed in between.
 */
export default function DeleteDialog({mount, path, token, user, now, onClose, onDone}: {
  mount: string; path: string; token: string; user?: string; now: number; onClose: () => void; onDone: (r: DeleteResult) => void;
}) {
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'trash' | 'permanent'>('trash');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const pw = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    post(token, {action: 'delete-prepare', mount, path}).then(p => {
      if (!live) return;
      setPrep(p);
      if (!p.trash?.available) setMode('permanent');
    }, e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [mount, path, token]);

  const needsPassword = !!prep && prep.needsPassword[mode];
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!prep?.id || busy || (needsPassword && !password)) return;
    setBusy(true); setError('');
    try { onDone(await post(token, {action: 'delete', id: prep.id, mode, ...(needsPassword ? {password} : {})})); }
    catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      setPassword('');
      // A wrong password keeps the confirmation; anything else (changed, expired) needs a fresh look. The server can
      // also ask for a password the dialog did not expect (the folder grew past 1 GB / 1,000 files since the scan).
      if (/password/i.test(msg)) {
        if (!needsPassword) setPrep(p => p && {...p, needsPassword: {...p.needsPassword, [mode]: true}});
        requestAnimationFrame(() => pw.current?.focus());
      }
      else setPrep(p => p && {...p, id: null});
    } finally { setBusy(false); }
  }

  const dir = prep?.kind === 'dir' || prep?.kind === 'locked';
  const blocked = !!prep && prep.blocked.length > 0;
  return <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
    <DialogContent className="delete-dialog">
      <DialogTitle>{blocked ? 'This can’t be deleted' : `Delete ${prep?.name ?? path.split('/').pop()}?`}</DialogTitle>
      <DialogDescription asChild><div className="confirm-body">
        <p className="mono dd-path">{prep?.path ?? path}</p>
        {!prep && !error && <p className="dim">Checking it…</p>}
        {prep && <p>{bytes(prep.bytes)}{dir ? ` · ${prep.files.toLocaleString()} files` : ''}{prep.newest ? ` · last changed ${ago(now - prep.newest)}` : ''}
          {prep.partial && <span className="dim"> · some folders inside could not be read, so it may be larger</span>}</p>}
        {blocked && <ul className="dd-blocked">{prep!.blocked.map(b => <li key={b}><Ban size={13} />{b}</li>)}</ul>}
        {!blocked && !!prep?.warnings.length && <ul className="dd-warn">{prep.warnings.map(w => <li key={w}><AlertTriangle size={13} />{w}</li>)}</ul>}
      </div></DialogDescription>

      {prep && !blocked && <form onSubmit={submit} className="dd-form">
        <fieldset className="dd-modes" disabled={busy || !prep.id}>
          <label className={mode === 'trash' ? 'on' : ''}>
            <input type="radio" name="mode" checked={mode === 'trash'} disabled={!prep.trash?.available} onChange={() => { setMode('trash'); setError(''); }} />
            <span><strong>Move to trash</strong>
              <small>{prep.trash?.available ? <>Can be restored. Frees space only once it is emptied{prep.trashDays ? <>, which Homebase does after {prep.trashDays} days</> : null}.</> : prep.trash?.error || 'No trash on this filesystem.'}</small></span>
          </label>
          <label className={mode === 'permanent' ? 'on danger' : ''}>
            <input type="radio" name="mode" checked={mode === 'permanent'} onChange={() => { setMode('permanent'); setError(''); }} />
            <span><strong>Delete permanently</strong><small>Frees the space now. It cannot be undone.</small></span>
          </label>
        </fieldset>
        {needsPassword && <div className="dd-password">
          <label htmlFor="delete-password">Password for <span className="mono">{user || 'the server account'}</span></label>
          <input ref={pw} id="delete-password" type="password" autoComplete="current-password" autoFocus value={password} disabled={busy}
            onChange={e => { setPassword(e.target.value); setError(''); }} aria-invalid={!!error} />
          <p className="form-help">{mode === 'permanent' ? 'Required for every permanent delete.' : 'Required for items over 1 GB or 1,000 files.'} Checked on the server, never stored.</p>
        </div>}
        {error && <p className="form-help form-error" role="alert">{error}</p>}
        {!prep.id && !error && <p className="form-help form-error">This confirmation expired. Close and try again.</p>}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={`button ${mode === 'permanent' ? 'destructive' : 'primary'}`} disabled={busy || !prep.id || (needsPassword && !password)}>
            <Trash2 size={13} />{busy ? 'Working…' : mode === 'trash' ? 'Move to trash' : 'Delete permanently'}
          </button>
        </div>
      </form>}
      {(blocked || (!prep && error)) && <>
        {!prep && error && <p className="form-help form-error">{error}</p>}
        <div className="dialog-actions"><button className="button" onClick={onClose} autoFocus>Close</button></div>
      </>}
    </DialogContent>
  </Dialog>;
}
