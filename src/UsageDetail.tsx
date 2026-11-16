import {useEffect, useState} from 'react';
import {AlertTriangle, ArrowRight, Cpu, GitBranch, Package, Trash2, X} from 'lucide-react';
import {toast} from 'sonner';
import DeleteDialog, {type DeleteResult} from './DeleteDialog';
import {ago, bytes, since} from './lib/format';

export type Verdict = 'safe' | 'review' | 'keep';
export type Categories = Record<string, {label: string; verdict: Verdict; hint: string}>;
/** Category verdict → legend text and colour. "none" is anything no rule recognised. */
export const VERDICTS: Record<Verdict | 'none', [string, string]> = {
  safe: ['Safe to clean', 'var(--lime)'], review: ['Review', 'var(--amber)'], keep: ['Keep / use its tool', 'var(--pink)'], none: ['Uncategorised', '#5b5e66'],
};

/** /api/storage/item (see server/usage-item.mjs). */
type Item = {
  path: string; name: string; kind: string; size: number; apparent: number; files: number; newest: number | null; oldest: number | null;
  partial: boolean; error: string | null; hardlink: boolean; shareOfUsed: number | null; fstype: string; growth?: number | null; isNew?: boolean;
  category: {id: string; label: string; verdict: Verdict; hint: string} | null;
  gone?: boolean; statError?: string | null; changed?: boolean;
  stat?: {mtime: number; ctime: number; atime: number; birthtime: number | null; atimeQuality: 'exact' | 'approximate' | 'none'; user: string; group: string; mode: string; nlink: number; mine: boolean};
  reclaim?: {bytes: number; uncertain: boolean; notes: string[]};
  openBy?: {items: {pid: number; name: string; files: number; deleted: number; cwd: boolean}[]; more: number; hidden: number};
  packages?: string[]; git?: {root: string; branch: string | null; lastActivity: number | null; worktree: boolean} | null;
  canDelete?: {ok: boolean; reason?: string};
  extensions?: {top: {ext: string; bytes: number; files: number}[]; small: number; complete: boolean} | null;
};

const when = (t: number | null | undefined, now: number) => t ? <span title={new Date(t).toLocaleString()}>{since(now - t)} <span className="dim">· {new Date(t).toLocaleDateString()}</span></span> : '—';
/** The toast after a delete, for one item or a batch. */
export function announceDelete(r: DeleteResult, label: string) {
  if (!r.done) return;
  const what = r.done === 1 && !r.failed ? label : `${r.done} item${r.done === 1 ? '' : 's'}`;
  toast.success(r.mode === 'trash' ? `${what} moved to the trash` : `${what} deleted`, {description: [
    r.mode === 'trash' ? 'Frees space once the trash is emptied. Restore from Cleanup → Trash.' : r.freed != null ? `${bytes(r.freed)} freed` : '',
    r.failed ? `${r.failed} could not be deleted.` : ''].filter(Boolean).join(' ') || undefined});
}
const pct = (v: number) => v >= 0.1 ? `${(v * 100).toFixed(0)}%` : v >= 0.001 ? `${(v * 100).toFixed(1)}%` : '<0.1%';

/** Everything known about one file or folder, to decide whether it can go. Shows the current folder when nothing is selected. */
export default function UsageDetail({mount, path, parentSize, now, scannedAt, onOpen, onClose, token, user, onDeleted}: {
  mount: string; path: string; parentSize: number | null; now: number; scannedAt?: number; onOpen?: () => void; onClose?: () => void;
  token?: string; user?: string; onDeleted?: (r: DeleteResult) => void;
}) {
  const [state, setState] = useState<{key: string; item?: Item; error?: string} | null>(null);
  const [deleting, setDeleting] = useState(false);
  const key = `${mount}:${path}:${scannedAt}`;
  useEffect(() => {
    let live = true;
    fetch(`/api/storage/item?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(path)}`)
      .then(async r => { const v = await r.json(); if (!r.ok) throw Error(v.error); return v as Item; })
      .then(item => { if (live) setState({key, item}); }, e => { if (live) setState({key, error: (e as Error).message}); });
    return () => { live = false; };
  }, [mount, path, key]);
  const it = state?.key === key ? state.item : undefined;
  const error = state?.key === key ? state.error : undefined;

  const head = <div className="ud-head">
    <div><small className="dim">{onClose ? 'Selected' : 'This folder'}</small><strong className="mono" title={path}>{it?.name || path.split('/').pop() || mount}</strong></div>
    <div className="ud-head-actions">
      {onOpen && <button className="button small" onClick={onOpen}>Open<ArrowRight size={12} /></button>}
      {onClose && <button className="icon-button" aria-label="Clear selection" onClick={onClose}><X size={14} /></button>}
    </div>
  </div>;
  if (error) return <aside className="usage-detail">{head}<p className="dim">{error}</p></aside>;
  if (!it) return <aside className="usage-detail">{head}<p className="dim">Loading details…</p></aside>;

  const dir = it.kind === 'dir' || it.kind === 'locked' || it.kind === 'mount';
  const st = it.stat, cat = it.category, open = it.openBy;
  const warnings = [
    it.gone && 'It no longer exists. It was deleted or moved after the scan.',
    it.changed && 'It changed type since the scan. Rescan before acting on it.',
    it.statError && `Could not be read now (${it.statError}).`,
    it.error && it.kind === 'locked' && (it.error === 'TIMEOUT' ? 'The scan ran out of time here.' : 'The scan could not read inside it, so its size is incomplete.'),
    it.partial && it.kind === 'dir' && 'Some folders inside could not be read, so the size is incomplete.',
    it.kind === 'mount' && 'Another filesystem is mounted here. Its space is not counted in this scan; pick it above to scan it.',
  ].filter(Boolean) as string[];
  const rows: [string, React.ReactNode, string?][] = [
    ['On disk', <>{bytes(it.size)}{parentSize ? <span className="dim"> · {pct(it.size / parentSize)} of this folder</span> : null}</>],
    ...(it.apparent > it.size * 1.1 + 4096 ? [['Apparent size', `${bytes(it.apparent)} (sparse or compressed)`, 'What programs see as the length; the disk holds less'] as [string, string, string]] : []),
    ...(it.shareOfUsed != null ? [['Of used space', pct(it.shareOfUsed)] as [string, string]] : []),
    ...(dir ? [['Files', it.files.toLocaleString()] as [string, string]] : []),
    ...(it.isNew ? [['Since the previous scan', 'New'] as [string, string]] : it.growth != null ? [['Since the previous scan', Math.abs(it.growth) < 1024 ** 2 ? 'About the same' : `${it.growth > 0 ? '+' : '−'}${bytes(Math.abs(it.growth))}`] as [string, string]] : []),
    ...(it.reclaim ? [['Deleting frees', <>{it.reclaim.uncertain ? '≈ up to ' : ''}{bytes(it.reclaim.bytes)}</>] as [string, React.ReactNode]] : []),
    ...(dir ? [
      ['Newest change inside', when(it.newest, now), 'Most recent modification of any file below. A folder’s own date only changes when entries are added or removed.'],
      ['Oldest file inside', it.oldest ? when(it.oldest, now) : <span className="dim">Rescan to see</span>],
    ] as [string, React.ReactNode, string?][] : [['Modified', when(st?.mtime ?? it.newest, now), 'Last change to the content']] as [string, React.ReactNode, string?][]),
    ...(st ? [
      ...(dir ? [['Folder entries changed', when(st.mtime, now), 'Last time something was added, removed or renamed directly in this folder']] as [string, React.ReactNode, string?][] : []),
      ['Metadata changed', when(st.ctime, now), 'ctime: permissions, owner, renames or content. Not the creation time.'],
      ...(st.birthtime ? [['Created', when(st.birthtime, now)] as [string, React.ReactNode]] : []),
      ...(st.atimeQuality !== 'none' ? [['Last read', <>{when(st.atime, now)}{st.atimeQuality === 'approximate' && <span className="dim"> · approximate</span>}</>,
        st.atimeQuality === 'approximate' ? 'This filesystem uses relatime: reads update this at most once a day, and only when it is older than the last change' : undefined]] as [string, React.ReactNode, string?][] : []),
      ['Owner', <span className="mono">{st.user}:{st.group}</span>],
      ['Permissions', <span className="mono">{st.mode}{st.nlink > 1 && !dir ? ` · ${st.nlink} links` : ''}</span>],
    ] as [string, React.ReactNode, string?][] : []),
  ];

  return <aside className="usage-detail">
    {head}
    {warnings.map(w => <div key={w} className="gpu-note drive-warn"><AlertTriangle size={13} />{w}</div>)}
    {cat ? <div className="ud-cat" style={{borderColor: VERDICTS[cat.verdict][1]}}>
      <span className="ud-verdict" style={{color: VERDICTS[cat.verdict][1]}}>{VERDICTS[cat.verdict][0]}</span>
      <strong>{cat.label}</strong>
      <p>{cat.hint}</p>
    </div> : !it.gone && <div className="ud-cat none"><span className="ud-verdict dim">Uncategorised</span><p className="dim">Not a known cache, log or system location. Judge by the dates and owner below.</p></div>}
    <dl className="detail-list compact ud-list">{rows.map(([k, v, t]) => <div key={k} title={t}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {!!it.reclaim?.notes.length && <ul className="ud-notes">{it.reclaim.notes.map(n => <li key={n}>{n}</li>)}</ul>}
    {it.canDelete && <p className={`ud-perm ${it.canDelete.ok ? '' : 'no'}`}>{it.canDelete.ok ? 'You can delete this as the dashboard user.' : `You can’t delete this as the dashboard user: ${it.canDelete.reason}.`}</p>}
    {/* Only a selected item, never the folder being browsed; the server makes the real decision when asked. */}
    {onClose && token && it.canDelete?.ok && !it.gone && it.kind !== 'mount' && cat?.verdict !== 'keep' &&
      <button className="button small danger-outline ud-delete" onClick={() => setDeleting(true)}><Trash2 size={12} />Delete…</button>}
    {deleting && token && <DeleteDialog mount={mount} paths={[path]} token={token} user={user} now={now} onClose={() => setDeleting(false)}
      onDone={r => { setDeleting(false); announceDelete(r, it.name); onDeleted?.(r); }} />}

    {open && (open.items.length > 0 || open.hidden > 0) && <div className="ud-section">
      <h5><Cpu size={12} />In use</h5>
      {open.items.length ? <ul className="ud-procs">{open.items.map(p => <li key={p.pid}><span className="mono">{p.name}</span><span className="dim">PID {p.pid} · {[p.files && `${p.files} open file${p.files > 1 ? 's' : ''}${p.deleted ? ` (${p.deleted} already deleted)` : ''}`, p.cwd && 'working directory'].filter(Boolean).join(' · ')}</span></li>)}
        {open.more > 0 && <li className="dim">and {open.more} more</li>}</ul>
        : <p className="dim">None of your processes use it.</p>}
      {open.hidden > 0 && <p className="dim ud-small">{open.hidden} processes of other users (root, services) can’t be checked without root.</p>}
    </div>}

    {!!it.packages?.length && <div className="ud-section">
      <h5><Package size={12} />Installed by {it.packages.length === 1 ? 'package' : `${it.packages.length} packages`}</h5>
      <p className="mono ud-small">{it.packages.slice(0, 8).join(', ')}{it.packages.length > 8 ? ` and ${it.packages.length - 8} more` : ''}</p>
      <p className="dim ud-small">Remove it with <span className="mono">sudo apt remove</span>, not by deleting files.</p>
    </div>}

    {it.git && <div className="ud-section">
      <h5><GitBranch size={12} />Git repository</h5>
      <p className="ud-small"><span className="mono">{it.git.branch || 'no branch'}</span>{it.git.lastActivity ? <span className="dim"> · last git activity {ago(now - it.git.lastActivity)}</span> : null}</p>
      {it.git.root !== it.path && <p className="dim ud-small mono" title={it.git.root}>in {it.git.root}</p>}
      <p className="dim ud-small">Check for uncommitted or unpushed work (<span className="mono">git status</span>, <span className="mono">git log @{'{u}'}..</span>) before deleting.</p>
    </div>}

    {it.extensions && (it.extensions.top.length > 0 || it.extensions.small > 0) && <div className="ud-section">
      <h5>What it holds</h5>
      <ul className="ud-ext">{it.extensions.top.map(e => <li key={e.ext}><span className="mono">{e.ext}</span><span className="meter small"><span style={{width: `${Math.max(2, e.bytes / it.size * 100)}%`}} /></span><span>{bytes(e.bytes)}</span></li>)}
        {it.extensions.small > 0 && <li><span className="dim">files under 1 MB</span><span className="meter small"><span style={{width: `${Math.max(2, it.extensions.small / it.size * 100)}%`, background: '#6b6e76'}} /></span><span>{bytes(it.extensions.small)}</span></li>}</ul>
    </div>}
  </aside>;
}
