import {useEffect, useRef, useState} from 'react';
import {AlertTriangle, Ban, Check, Trash2} from 'lucide-react';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {ago, bytes} from './lib/format';

/** One checked item from POST /api/storage {action: 'delete-prepare-many'} (see server/usage.mjs). */
type Checked = {path: string; name: string; kind: string; bytes: number; files: number; newest: number | null; blocked: string[]; warnings: string[]; partial: boolean;
  trash: {available: boolean; location?: string; error?: string} | null};
type Prepared = {id: string | null; items: Checked[]; merged: number; total: {bytes: number; files: number; count: number}; blockedCount: number;
  trash: {available: boolean}; needsPassword: {trash: boolean; permanent: boolean}; trashDays: number};
type Outcome = {path: string; ok: boolean; error?: string};
export type DeleteResult = {mode: 'trash' | 'permanent'; done: number; failed: number; results: Outcome[]; freed?: number | null};

const post = async (token: string, body: object) => {
  const r = await fetch('/api/storage', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify(body)});
  const v = await r.json(); if (!r.ok) throw Error(v.error); return v;
};
const name = (p: string) => p.split('/').filter(Boolean).pop() || p;

/**
 * Delete one item or several. Two steps, both checked on the server: "prepare" re-inspects every item and returns a
 * short-lived id bound to those exact files; "delete" checks each again and skips any that changed in between.
 * `paths` are relative to the mount, as the map uses them.
 */
export default function DeleteDialog({mount, paths, token, user, now, onClose, onDone}: {
  mount: string; paths: string[]; token: string; user?: string; now: number; onClose: () => void; onDone: (r: DeleteResult) => void;
}) {
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'trash' | 'permanent'>('trash');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<DeleteResult | null>(null);
  const pw = useRef<HTMLInputElement>(null);
  const key = paths.join('\n');

  useEffect(() => {
    let live = true;
    post(token, {action: 'delete-prepare-many', mount, paths: key.split('\n')}).then((p: Prepared) => {
      if (!live) return;
      setPrep(p);
      if (!p.trash.available) setMode('permanent');
    }, e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [mount, key, token]);

  const needsPassword = !!prep && prep.needsPassword[mode];
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!prep?.id || busy || (needsPassword && !password)) return;
    setBusy(true); setError('');
    try {
      const r: DeleteResult = await post(token, {action: 'delete-many', id: prep.id, mode, ...(needsPassword ? {password} : {})});
      // Everything went: close. Some did not: show which and why, then close from there.
      if (r.failed) setPartial(r); else onDone(r);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      setPassword('');
      // A wrong password keeps the confirmation; anything else (expired) needs a fresh look. The server can also ask
      // for a password the dialog did not expect (something grew past 1 GB / 1,000 files since the scan).
      if (/password/i.test(msg)) {
        if (!needsPassword) setPrep(p => p && {...p, needsPassword: {...p.needsPassword, [mode]: true}});
        requestAnimationFrame(() => pw.current?.focus());
      } else setPrep(p => p && {...p, id: null});
    } finally { setBusy(false); }
  }

  const single = paths.length === 1 && prep?.items.length === 1 ? prep.items[0] : null;
  const allBlocked = !!prep && !prep.id && !error && prep.blockedCount === prep.items.length;
  const title = partial ? `${partial.done} of ${partial.done + partial.failed} ${partial.mode === 'trash' ? 'moved to the trash' : 'deleted'}`
    : allBlocked ? (single ? 'This can’t be deleted' : 'None of these can be deleted')
    : single ? `Delete ${single.name}?` : prep ? `Delete ${prep.total.count} item${prep.total.count === 1 ? '' : 's'}?` : `Delete ${paths.length === 1 ? name(paths[0]) : `${paths.length} items`}?`;
  const dir = (k: string) => k === 'dir' || k === 'locked';

  const close = () => { if (partial) onDone(partial); else onClose(); };
  return <Dialog open onOpenChange={o => { if (!o && !busy) close(); }}>
    <DialogContent className="delete-dialog">
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription asChild><div className="confirm-body">
        {!prep && !error && <p className="dim">Checking {paths.length === 1 ? 'it' : `${paths.length} items`}…</p>}
        {partial ? <ul className="dd-results">{partial.results.map(r => <li key={r.path} className={r.ok ? 'ok' : 'no'}>
            {r.ok ? <Check size={13} /> : <Ban size={13} />}<span className="mono">{name(r.path)}</span>{!r.ok && <span>{r.error}</span>}</li>)}</ul>
        : single ? <>
          <p className="mono dd-path">{single.path}</p>
          <p>{bytes(single.bytes)}{dir(single.kind) ? ` · ${single.files.toLocaleString()} files` : ''}{single.newest ? ` · last changed ${ago(now - single.newest)}` : ''}
            {single.partial && <span className="dim"> · some folders inside could not be read, so it may be larger</span>}</p>
          {single.blocked.length > 0 && <ul className="dd-blocked">{single.blocked.map(b => <li key={b}><Ban size={13} />{b}</li>)}</ul>}
          {!single.blocked.length && single.warnings.length > 0 && <ul className="dd-warn">{single.warnings.map(w => <li key={w}><AlertTriangle size={13} />{w}</li>)}</ul>}
        </> : prep && <>
          <p>{bytes(prep.total.bytes)} · {prep.total.files.toLocaleString()} files in {prep.total.count} item{prep.total.count === 1 ? '' : 's'}
            {prep.merged > 0 && <span className="dim"> · {prep.merged} selected item{prep.merged === 1 ? ' is' : 's are'} inside another selected folder and go{prep.merged === 1 ? 'es' : ''} with it</span>}</p>
          {prep.blockedCount > 0 && <p className="dd-skip">{prep.blockedCount} can’t be deleted and will be left alone.</p>}
          <ul className="dd-items">{prep.items.map(i => <li key={i.path} className={i.blocked.length ? 'blocked' : ''}>
            <span className="mono" title={i.path}>{i.name}{dir(i.kind) ? '/' : ''}</span>
            <span className="dd-size">{bytes(i.bytes)}</span>
            {i.blocked.length > 0 ? <span className="dd-why no"><Ban size={12} />{i.blocked[0]}</span>
              : i.warnings.length > 0 ? <span className="dd-why warn"><AlertTriangle size={12} />{i.warnings[0]}</span> : null}
          </li>)}</ul>
        </>}
      </div></DialogDescription>

      {prep && !partial && !allBlocked && <form onSubmit={submit} className="dd-form">
        <fieldset className="dd-modes" disabled={busy || !prep.id}>
          <label className={mode === 'trash' ? 'on' : ''}>
            <input type="radio" name="mode" checked={mode === 'trash'} disabled={!prep.trash.available} onChange={() => { setMode('trash'); setError(''); }} />
            <span><strong>Move to trash</strong>
              <small>{prep.trash.available ? <>Can be restored. Frees space only once it is emptied{prep.trashDays ? <>, which Homebase does after {prep.trashDays} days</> : null}.</>
                : (single?.trash?.error || prep.items.find(i => i.trash?.error)?.trash?.error || 'No trash on this filesystem.')}</small></span>
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
          <p className="form-help">{mode === 'permanent' ? 'Required for every permanent delete.' : 'Required for over 1 GB or 1,000 files in total.'} Checked on the server, never stored.</p>
        </div>}
        {error && <p className="form-help form-error" role="alert">{error}</p>}
        {!prep.id && !error && <p className="form-help form-error">This confirmation expired. Close and try again.</p>}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={`button ${mode === 'permanent' ? 'destructive' : 'primary'}`} disabled={busy || !prep.id || (needsPassword && !password)}>
            <Trash2 size={13} />{busy ? 'Working…' : `${mode === 'trash' ? 'Move to trash' : 'Delete permanently'}${prep.total.count > 1 ? ` (${prep.total.count})` : ''}`}
          </button>
        </div>
      </form>}
      {(partial || allBlocked || (!prep && error)) && <>
        {!prep && error && <p className="form-help form-error">{error}</p>}
        <div className="dialog-actions"><button className="button" onClick={close} autoFocus>Close</button></div>
      </>}
    </DialogContent>
  </Dialog>;
}
