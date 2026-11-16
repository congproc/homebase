import {useCallback, useEffect, useState} from 'react';
import {Copy, Cpu, Map as MapIcon, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {Empty} from './components/panels';
import {useConfirm} from './components/confirm';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {ago, bytes, since} from './lib/format';
import {VERDICTS, type Verdict} from './UsageDetail';

/** /api/storage/cleanup (see server/cleanup.mjs). */
type Tool = {id: string; label: string; about: string; command: string; root: boolean; category: string; perItem: boolean; available: boolean; runnable: boolean;
  bytes: number; detail: string | null; items?: {name: string; bytes: number; modified: number | null}[]};
type Candidate = {path: string; kind: string; category: string; label: string; verdict: Verdict; hint: string; bytes: number; files: number; newest: number | null;
  reason: string; tool: string | null; inUse: boolean};
type Group = {category: string; label: string; verdict: Verdict; bytes: number; count: number};
type Growth = {since: number; total: number; items: {path: string; kind: string; growth: number; bytes: number; isNew: boolean; newest: number | null}[]};
type DeletedOpen = {items: {pid: number; name: string; path: string; bytes: number}[]; total: number; hidden: number};
type Gap = {fsUsed: number; scanned: number; errors: number; stoppedEarly: boolean; at: number};
type Cleanup = {home?: string; tools: Tool[]; candidates: {items: Candidate[]; groups: Group[]; more: number; scanned: boolean}; growth: Growth | null; deletedOpen: DeletedOpen; gap: Gap | null};

/** Candidates shown before "Show all": the ranking puts what matters first, and a phone should not scroll past 40. */
const TOP = 10;
// Removing these cannot be undone by the tool itself (a re-download is not an undo), so the confirm button is red.
const DESTRUCTIVE = new Set(['trash', 'ollama', 'docker-images', 'snaps']);
/** ~ for the home folder, and long paths cut in the middle, where the least telling part is. */
const short = (p: string, h?: string, max = 72) => {
  const s = h && p.startsWith(h + '/') ? '~' + p.slice(h.length) : p;
  return s.length <= max ? s : s.slice(0, 26) + '…' + s.slice(-(max - 27));
};

export default function UsageCleanup({mount, token, now, scannedAt, version = 0, setupCommand, onShow, onChanged}: {
  mount: string; token?: string; now: number; scannedAt?: number; version?: number; setupCommand?: string; onShow: (path: string) => void; onChanged?: () => void;
}) {
  const [data, setData] = useState<{key: string; value?: Cleanup; error?: string} | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const ask = useConfirm();
  const key = `${mount}:${scannedAt}:${tick}:${version}`;

  useEffect(() => {
    let live = true;
    fetch(`/api/storage/cleanup?mount=${encodeURIComponent(mount)}${tick ? '&refresh=1' : ''}`)
      .then(async r => { const v = await r.json(); if (!r.ok) throw Error(v.error); return v as Cleanup; })
      .then(value => { if (live) setData({key, value}); }, e => { if (live) setData({key, error: (e as Error).message}); });
    return () => { live = false; };
  }, [mount, key, tick]);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  async function run(tool: Tool, arg?: string) {
    if (!token) return;
    const what = arg ? `${tool.label}: ${arg}` : tool.label;
    const size = arg ? tool.items?.find(i => i.name === arg)?.bytes : tool.bytes;
    if (!(await ask({title: arg ? `Remove ${arg}?` : `${tool.label}?`, destructive: DESTRUCTIVE.has(tool.id), confirm: arg ? 'Remove model' : 'Clean up',
      body: <><p>{tool.about}</p>{size ? <p>Expected to free about <strong>{bytes(size)}</strong>.</p> : null}<p className="dim">Runs <code>{arg ? tool.command.replace('<model>', arg) : tool.command}</code>.</p></>}))) return;
    setBusy(tool.id + (arg ?? ''));
    try {
      const r = await fetch('/api/storage', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify({action: 'cleanup', tool: tool.id, ...(arg ? {arg} : {})})});
      const v = await r.json(); if (!r.ok) throw Error(v.error);
      toast.success(`${what}: done`, {description: v.freed != null ? `${bytes(v.freed)} freed` : v.output?.slice(0, 200)});
      refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success('Command copied')).catch(() => toast.error('Copy the command manually'));

  const value = data?.key === key ? data.value : undefined, error = data?.key === key ? data.error : undefined;
  if (error) return <Empty compact icon={Sparkles} title="Cleanup suggestions unavailable">{error}</Empty>;
  if (!value) return <p className="dim usage-loading">Measuring what can be cleaned…</p>;

  const {tools, candidates, growth, deletedOpen, gap} = value;
  // Under 1 MB is not worth a card (an empty trash still has a few KB of folders).
  const worth = (t: Tool) => t.bytes >= 1024 * 1024;
  const useful = tools.filter(t => t.available && worth(t)), idle = tools.filter(t => t.available && !worth(t));
  const needsSetup = useful.some(t => t.root && !t.runnable);
  // Candidates a tool already covers are shown with that tool, which measures them properly.
  const toolReady = new Set(useful.map(t => t.id));
  const items = candidates.items.filter(i => !i.tool || !toolReady.has(i.tool));
  const total = useful.reduce((a, t) => a + t.bytes, 0);

  return <div className="cleanup">
    <section>
      <div className="cleanup-head">
        <div><h4>Cleanups by each tool</h4><p className="dim">The tool’s own command, so nothing it manages gets broken.{total ? <> About <strong>{bytes(total)}</strong> can be freed this way.</> : null}</p></div>
        <button className="button small" onClick={refresh}><RefreshCw size={12} />Measure again</button>
      </div>
      {needsSetup && <div className="setup-notice compact"><ShieldCheck size={18} /><div>
        <strong>Allow the system cleanups from here</strong>
        <p>APT, journal and snap cleanups need root. Run the administrator setup again: it adds a rule for exactly these three commands. Until then, copy the command and run it yourself.</p>
        {setupCommand && <div className="setup-command"><code>{setupCommand}</code><button className="button" aria-label="Copy setup command" onClick={() => copy(setupCommand)}><Copy size={14} /></button></div>}
      </div></div>}
      {useful.length ? <div className="cleanup-tools">{useful.map(t => t.perItem ? <div key={t.id} className="cleanup-tool wide">
          <div className="ct-main"><strong>{t.label}</strong><p className="dim">{t.about}</p></div>
          <ul className="ct-items">{(t.items || []).map(m => <li key={m.name}>
            <span className="mono">{m.name}</span><span>{bytes(m.bytes)}</span><span className="dim">{m.modified ? `pulled ${ago(now - m.modified)}` : ''}</span>
            <button className="button small danger-outline" disabled={!!busy || !t.runnable} onClick={() => run(t, m.name)}>{busy === t.id + m.name ? 'Removing…' : 'Remove'}</button>
          </li>)}</ul>
        </div> : <div key={t.id} className="cleanup-tool">
          <div className="ct-main"><strong>{t.label}</strong><p className="dim">{t.about}</p>{t.detail && <p className="dim ct-detail" title={t.detail}>{t.detail}</p>}</div>
          <div className="ct-side">
            <span className="ct-bytes">≈ {bytes(t.bytes)}</span>
            {t.runnable ? <button className="button small" disabled={!!busy} onClick={() => run(t)}>{busy === t.id ? 'Working…' : 'Clean up'}</button>
              : <button className="button small" onClick={() => copy(t.command)} title={t.command}><Copy size={12} />Copy command</button>}
          </div>
        </div>)}</div>
        : <p className="dim">Nothing for the package tools to clean right now.</p>}
      {idle.length > 0 && <p className="dim cleanup-idle">Already clean: {idle.map(t => t.label.replace(/^(Clean|Clear|Remove|Empty) (the )?/i, '')).join(', ')}.</p>}
    </section>

    {growth && <section>
      <div className="cleanup-head"><div><h4>Grew since the previous scan</h4><p className="dim">
        Compared with the scan {ago(now - growth.since)}: {Math.abs(growth.total) < 1024 ** 2 ? 'about the same overall' : `${growth.total > 0 ? '+' : '−'}${bytes(Math.abs(growth.total))} overall`}.</p></div></div>
      {growth.items.length ? <div className="cleanup-list">{growth.items.map(g => <div key={g.path} className="cleanup-item">
        <i className="ci-dot" style={{background: g.isNew ? 'var(--red)' : 'var(--amber)'}} />
        <div className="ci-main"><span className="mono ci-path" title={g.path}>{short(g.path, value.home)}</span>
          <span className="dim ci-reason">{g.isNew ? 'new' : 'grew'} · now {bytes(g.bytes)}{g.newest ? ` · last change ${since(now - g.newest)}` : ''}</span></div>
        <span className="ci-bytes growth-up">+{bytes(g.growth)}</span>
        <button className="button small" onClick={() => onShow(g.path)}><MapIcon size={12} />Show</button>
      </div>)}</div> : <p className="dim">Nothing grew by more than 100 MB.</p>}
    </section>}

    <section>
      <div className="cleanup-head"><div><h4>Worth reviewing</h4><p className="dim">Ranked by size, how safe the category is, and how long since anything inside changed. Recently changed folders rank lower.</p></div></div>
      {!candidates.scanned ? <p className="dim">Scan this filesystem to get suggestions.</p> : <>
        {candidates.groups.length > 0 && <div className="cleanup-groups">{candidates.groups.map(g => <span key={g.category} title={`${g.count} item${g.count === 1 ? '' : 's'}`}>
          <i style={{background: VERDICTS[g.verdict][1]}} />{g.label}<strong>{bytes(g.bytes)}</strong></span>)}</div>}
        {items.length ? <div className="cleanup-list">{items.slice(0, showAll ? items.length : TOP).map(c => <div key={c.path} className="cleanup-item">
          <i className="ci-dot" style={{background: VERDICTS[c.verdict][1]}} />
          <div className="ci-main">
            <span className="mono ci-path" title={c.path}>{short(c.path, value.home)}</span>
            <span className="dim ci-reason">{c.reason}{c.inUse && <span className="ci-inuse"><Cpu size={11} />open in a running program</span>}</span>
          </div>
          <span className="ci-bytes">{bytes(c.bytes)}</span>
          <button className="button small" onClick={() => onShow(c.path)} title="Show it in the map with its details"><MapIcon size={12} />Show</button>
        </div>)}</div> : <p className="dim">Nothing large stands out.</p>}
        {items.length > TOP && <button className="button small show-more" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show the top 10' : `Show all ${items.length}`}</button>}
        {candidates.more > 0 && (showAll || items.length <= TOP) && <p className="dim cleanup-idle">And {candidates.more} smaller items.</p>}
        <p className="dim cleanup-idle">Use Show to open an item with its details, then Delete… there. Deleting moves it to the trash first.</p>
      </>}
    </section>

    <HiddenSpace gap={gap} deleted={deletedOpen} now={now} home={value.home} />

    <TrashList token={token} now={now} version={version} onChanged={onChanged} home={value.home} />
  </div>;
}

type TrashItem = {id: string; original: string; dir: string; name: string; at: number; bytes: number; files: number; mount: string};

/** What Homebase moved to the trash: restore it, or delete it for good now instead of waiting for the auto-empty. */
function TrashList({token, now, version, onChanged, home}: {token?: string; now: number; version: number; onChanged?: () => void; home?: string}) {
  const [data, setData] = useState<{items: TrashItem[]; days: number} | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [purging, setPurging] = useState<TrashItem | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/storage/trash').then(r => r.ok ? r.json() : null).then(v => { if (live && v) setData(v); }).catch(() => {});
    return () => { live = false; };
  }, [version, tick]);
  async function act(e: TrashItem, action: 'trash-restore' | 'trash-purge', password?: string) {
    if (!token) return;
    setBusy(e.id);
    try {
      const r = await fetch('/api/storage', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify({action, id: e.id, ...(password ? {password} : {})})});
      const v = await r.json(); if (!r.ok) throw Error(v.error);
      toast.success(action === 'trash-restore' ? 'Restored' : 'Deleted for good', {description: action === 'trash-restore' ? `Back at ${short(e.original, home)}. Rescan to see it in the map.` : v.freed != null ? `${bytes(v.freed)} freed` : undefined});
      setTick(t => t + 1); setPurging(null); onChanged?.();
    } catch (err) { if (action === 'trash-purge') throw err; toast.error((err as Error).message); } finally { setBusy(null); }
  }
  if (!data?.items.length) return null;
  const total = data.items.reduce((a, e) => a + e.bytes, 0);
  return <section>
    <div className="cleanup-head"><div><h4>Trash</h4><p className="dim">Moved here from this dashboard: {bytes(total)}, still using space until deleted.{data.days ? ` Each item is deleted for good ${data.days} days after it was moved.` : ''}</p></div></div>
    <div className="cleanup-list">{data.items.map(e => {
      const left = data.days ? Math.max(0, Math.ceil((e.at + data.days * 86400000 - now) / 86400000)) : null;
      return <div key={e.id} className="cleanup-item trash-item">
        <Trash2 size={13} className="dim" />
        <div className="ci-main"><span className="mono ci-path" title={e.original}>{short(e.original, home)}</span>
          <span className="dim ci-reason">moved {ago(now - e.at)}{left != null ? ` · deleted for good in ${left} day${left === 1 ? '' : 's'}` : ''}</span></div>
        <span className="ci-bytes">{bytes(e.bytes)}</span>
        <span className="trash-actions">
          <button className="button small" disabled={!!busy} onClick={() => act(e, 'trash-restore')}><RotateCcw size={12} />Restore</button>
          <button className="button small danger-outline" disabled={!!busy} onClick={() => setPurging(e)}>Delete now</button>
        </span>
      </div>;
    })}</div>
    {purging && <PurgeDialog item={purging} label={short(purging.original, home)} busy={busy === purging.id} onClose={() => setPurging(null)} onConfirm={pw => act(purging, 'trash-purge', pw)} />}
  </section>;
}

/** Emptying one item from the trash is a permanent delete, so it asks for the password like the delete dialog does. */
function PurgeDialog({item, label, busy, onClose, onConfirm}: {item: TrashItem; label: string; busy: boolean; onClose: () => void; onConfirm: (password: string) => Promise<void>}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    try { await onConfirm(password); } catch (err) { setError((err as Error).message); setPassword(''); }
  }
  return <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
    <DialogContent className="delete-dialog">
      <DialogTitle>Delete it for good?</DialogTitle>
      <DialogDescription asChild><div className="confirm-body"><p className="mono dd-path">{label}</p><p>{bytes(item.bytes)} · cannot be undone.</p></div></DialogDescription>
      <form onSubmit={submit} className="dd-form">
        <div className="dd-password">
          <label htmlFor="purge-password">Server account password</label>
          <input id="purge-password" type="password" autoComplete="current-password" autoFocus value={password} disabled={busy} onChange={e => { setPassword(e.target.value); setError(''); }} aria-invalid={!!error} />
          <p className="form-help">Required for every permanent delete. Checked on the server, never stored.</p>
        </div>
        {error && <p className="form-help form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="button destructive" disabled={busy || !password}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

/**
 * Space the map cannot show: what the filesystem reports as used minus what the scan found, with the likely causes,
 * and the deleted files that running programs still hold open (their space returns when the program closes them).
 */
function HiddenSpace({gap, deleted, now, home}: {gap: Gap | null; deleted: DeletedOpen; now: number; home?: string}) {
  const missing = gap ? gap.fsUsed - gap.scanned : 0;
  if (!gap && !deleted.items.length) return null;
  const MB = 1024 ** 2;
  return <section>
    <div className="cleanup-head"><div><h4>Space the map can’t see</h4>
      {gap && <p className="dim">When it was scanned {ago(now - gap.at)}, the filesystem reported {bytes(gap.fsUsed)} used and the scan found {bytes(gap.scanned)}{missing > 64 * MB ? <>: <strong>{bytes(missing)}</strong> is not in the map.</> : '. Nearly everything is accounted for.'}</p>}
    </div></div>
    {gap && missing > 64 * MB && <ul className="hidden-causes">
      {gap.errors > 0 && <li><strong>{gap.errors.toLocaleString()} folders the dashboard user can’t read</strong> (other users’ and system folders). Their contents are not counted.</li>}
      {deleted.total > MB && <li><strong>{bytes(deleted.total)} in deleted files still open</strong> (below). Restarting the program releases it.</li>}
      <li>Filesystem metadata and journal, and on btrfs/ZFS, snapshots. These are not files.</li>
      {gap.stoppedEarly && <li>The scan ran out of time, so part of the tree was not read.</li>}
    </ul>}
    {deleted.items.length > 0 && <>
      <p className="dim cleanup-idle">Deleted files still held open by a running program keep their space until it closes them. Restarting that program or its service frees it.</p>
      <div className="cleanup-list">{deleted.items.map(d => <div key={`${d.pid}:${d.path}`} className="cleanup-item">
        <i className="ci-dot" style={{background: 'var(--violet)'}} />
        <div className="ci-main"><span className="mono ci-path" title={d.path}>{short(d.path, home)} <span className="dim">(deleted)</span></span>
          <span className="dim ci-reason">held by {d.name} · PID {d.pid}</span></div>
        <span className="ci-bytes">{bytes(d.bytes)}</span>
        <span />
      </div>)}</div>
    </>}
    {deleted.hidden > 0 && <p className="dim cleanup-idle">{deleted.hidden} processes of other users (root, services) can’t be checked without root, so their deleted-but-open files are not listed.</p>}
  </section>;
}
