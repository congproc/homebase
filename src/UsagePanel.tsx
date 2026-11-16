import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, ArrowRight, Check, CheckCheck, ChevronRight, Copy, FolderOpen, FolderSearch, ListChecks, Lock, RefreshCw, Square, Trash2, X} from 'lucide-react';
import {toast} from 'sonner';
import {Panel, Empty} from './components/panels';
import {ago, bytes, levelColor, levelFor, since} from './lib/format';
import UsageDetail, {VERDICTS, announceDelete, type Categories} from './UsageDetail';
import DeleteDialog from './DeleteDialog';
import UsageCleanup from './UsageCleanup';

/** Compact node from /api/storage/tree (see server/usage-scan.mjs). */
type UNode = {n: string; k: 'dir' | 'file' | 'link' | 'other' | 'files' | 'mount' | 'locked' | 'more'; d: number; s: number; f: number; m: number;
  ch?: UNode[]; c?: number; e?: string; p?: 1; h?: 1; x?: number; o?: number; t?: string; g?: number; nw?: 1};
type ScanMeta = {scannedAt: number; durationMs: number; files: number; dirs: number; bytes: number; errors: number; vanished?: number; partial: boolean; previous?: {scannedAt: number; bytes: number} | null};
type Space = {percent: number; level: 'ok' | 'warn' | 'critical'; forecast: {perDay: number; daysLeft: number | null; days: number} | null; suggest?: {path: string; bytes: number; label: string}[]};
type MountInfo = {mount: string; fstype: string; source: string; total?: number; used?: number; available?: number; scan: ScanMeta | null;
  running: {startedAt: number; progress: {files: number; dirs: number; bytes: number; errors: number; path: string}} | null; lastError: string | null; space?: Space | null};
type TreeResponse = {mount: string; path: string; meta: ScanMeta | null; node: UNode | null; categories?: Categories};
type Rect = {x: number; y: number; w: number; h: number};
type ColorMode = 'category' | 'age' | 'type' | 'growth';
const MODES: [ColorMode, string][] = [['category', 'Category'], ['age', 'Age'], ['growth', 'Growth'], ['type', 'Type']];

const DAY = 86400000;
const AGES: [number, string, string][] = [[7 * DAY, 'under a week', '22%'], [30 * DAY, 'under a month', '38%'], [180 * DAY, 'under 6 months', '55%'], [365 * DAY, 'under a year', '72%'], [Infinity, 'over a year', '90%']];
const TYPES: Record<string, [string, string]> = {dir: ['Folder', 'var(--sky)'], file: ['File', 'var(--amber)'], files: ['Small files', '#6b6e76'], more: ['Smaller items', '#4d5057'],
  locked: ['Unreadable', 'var(--red)'], mount: ['Other filesystem', 'var(--violet)'], link: ['Link', '#6b6e76'], other: ['Other', '#6b6e76']};

const label = (n: UNode) => n.k === 'files' ? `${(n.x ?? n.f).toLocaleString()} smaller files` : n.k === 'more' ? `${(n.x ?? 0).toLocaleString()} smaller items` : n.n;
const ageColor = (m: number, now: number) => { const a = now - m; const step = AGES.find(([limit]) => a < limit)!; return `color-mix(in srgb, var(--amber) ${step[2]}, var(--surface-2, #1b1c20))`; };
const fixed = (n: UNode) => n.k === 'locked' || n.k === 'mount' || n.k === 'more';
// Growth since the previous scan, as a share of the tile's own size: red = grew (or new), blue = shrank, grey = steady.
const GROWTH: [string, string][] = [['New', 'var(--red)'], ['Grew a lot', 'color-mix(in srgb, var(--red) 70%, var(--surface-2, #1b1c20))'], ['Grew', 'color-mix(in srgb, var(--amber) 55%, var(--surface-2, #1b1c20))'],
  ['About the same', '#4d5057'], ['Shrank', 'color-mix(in srgb, var(--sky) 60%, var(--surface-2, #1b1c20))'], ['Not compared', '#33353b']];
// Absolute or relative: +200 MB inside an 88 GB home still shows, so the trail to where it grew stays visible.
const MiB = 1024 ** 2;
const growthStep = (n: UNode) => n.nw ? 0 : n.g == null ? 5
  : n.g >= 1024 * MiB || (n.g > 0.25 * n.d && n.g > 50 * MiB) ? 1
  : n.g >= 100 * MiB || (n.g > 0.02 * n.d && n.g > MiB) ? 2
  : n.g < -MiB ? 4 : 3;
const signed = (v: number) => (v >= 0 ? '+' : '−') + bytes(Math.abs(v));
const colorOf = (n: UNode, mode: ColorMode, now: number, cats?: Categories) =>
  mode === 'type' || fixed(n) ? TYPES[n.k]?.[1] ?? '#6b6e76'
  : mode === 'growth' ? GROWTH[growthStep(n)][1]
  : mode === 'category' ? VERDICTS[(n.t && cats?.[n.t]?.verdict) || 'none'][1]
  : ageColor(n.m, now);
// Label colour: light text on grey and on the faint (recent) age steps, dark text on the strong colours.
const ink = (n: UNode, mode: ColorMode, now: number) => {
  if (mode === 'type' || fixed(n)) return ['files', 'more', 'link', 'other'].includes(n.k) ? 'var(--text)' : '#121316';
  if (mode === 'category') return n.t ? '#121316' : 'var(--text)';
  if (mode === 'growth') return growthStep(n) <= 1 ? '#121316' : 'var(--text)';
  return AGES.findIndex(([limit]) => now - n.m < limit) >= 3 ? '#121316' : 'var(--text)';
};
const age = (m: number, now: number) => m ? since(now - m) : '—';
const tip = (n: UNode, parent: number, now: number, cats?: Categories) => [label(n), `${bytes(n.d)} on disk${n.s > n.d * 1.1 + 4096 ? ` · ${bytes(n.s)} apparent (sparse or compressed)` : ''}`,
  parent ? `${(n.d / parent * 100).toFixed(1)}% of this folder` : '', n.f > 1 || n.k === 'dir' ? `${n.f.toLocaleString()} files` : '', n.m ? `Newest change ${age(n.m, now)} (${new Date(n.m).toLocaleDateString()})` : '',
  n.k === 'locked' ? `Not read: ${n.e === 'TIMEOUT' ? 'the scan ran out of time' : n.e === 'EACCES' || n.e === 'EPERM' ? 'permission denied' : n.e}` : '',
  n.nw ? 'New since the previous scan' : n.g != null && Math.abs(n.g) >= 1024 ** 2 ? `${signed(n.g)} since the previous scan` : '',
  n.t && cats?.[n.t] ? `${cats[n.t].label} · ${VERDICTS[cats[n.t].verdict][0]}` : '',
  n.k === 'mount' ? 'Another filesystem is mounted here; scan it on its own' : '', n.h ? 'Hardlink: its data is counted at another name' : '', n.p && n.k === 'dir' ? 'Some folders inside could not be read' : ''].filter(Boolean).join('\n');

/** Squarified treemap layout (Bruls et al.): rows of tiles whose aspect ratios stay close to 1. */
export function squarify(values: number[], r: Rect): Rect[] {
  const total = values.reduce((a, v) => a + v, 0), out: Rect[] = [];
  if (!total || r.w <= 0 || r.h <= 0) return values.map(() => ({x: r.x, y: r.y, w: 0, h: 0}));
  const scale = (r.w * r.h) / total, areas = values.map(v => v * scale);
  let {x, y, w, h} = r, i = 0;
  const worst = (row: number[], side: number) => { const s = row.reduce((a, v) => a + v, 0), max = Math.max(...row), min = Math.min(...row); return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min)); };
  while (i < areas.length) {
    const side = Math.min(w, h), row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row.push(areas[j++]);
    const sum = row.reduce((a, v) => a + v, 0);
    if (w >= h) { const cw = sum / h; let cy = y; for (const a of row) { out.push({x, y: cy, w: cw, h: a / cw}); cy += a / cw; } x += cw; w -= cw; }
    else { const ch = sum / w; let cx = x; for (const a of row) { out.push({x: cx, y, w: a / ch, h: ch}); cx += a / ch; } y += ch; h -= ch; }
    i = j;
  }
  return out;
}

/** Children worth a tile: anything under 0.5% of the parent is folded into one "smaller items" tile. */
function tiles(node: UNode): UNode[] {
  const ch = (node.ch || []).filter(c => c.d > 0), min = node.d * 0.005;
  const keep = ch.filter(c => c.d >= min && c.k !== 'more'), rest = ch.filter(c => c.d < min || c.k === 'more');
  if (rest.length) keep.push({n: '', k: 'more', d: rest.reduce((a, c) => a + c.d, 0), s: rest.reduce((a, c) => a + c.s, 0), f: rest.reduce((a, c) => a + c.f, 0),
    m: Math.max(...rest.map(c => c.m)), x: rest.reduce((a, c) => a + (c.k === 'more' || c.k === 'files' ? c.x ?? 1 : 1), 0)});
  return keep;
}

/** How a click selects: replace (plain), toggle one (Ctrl/Cmd, or select mode), or a range in list order (Shift). */
type How = {add?: boolean; range?: boolean};
type Pick = (rel: string[], how?: How) => void;
/** Right-click (or the Menu key) on an item: `key` is its path relative to the folder shown. */
type Menu = (e: React.MouseEvent | React.KeyboardEvent, key: string) => void;
const howOf = (e: React.MouseEvent | React.KeyboardEvent): How => ({add: e.ctrlKey || e.metaKey, range: e.shiftKey});
/** Click selects (details below), Ctrl/Cmd-click adds, double-click opens a folder. */
function Treemap({node, mode, now, cats, selected, select, open, menu}: {node: UNode; mode: ColorMode; now: number; cats?: Categories; selected: Set<string>; select: Pick; open: Pick; menu: Menu}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({w: 0, h: 0});
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({w: e.contentRect.width, h: e.contentRect.height}));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const top = useMemo(() => tiles(node), [node]);
  const rects = useMemo(() => squarify(top.map(c => c.d), {x: 0, y: 0, w: size.w, h: size.h}), [top, size]);
  const HEAD = 18, PAD = 2;
  return <div className="treemap" ref={ref} role="list" aria-label="Disk usage treemap">
    {size.w > 0 && top.map((c, i) => {
      const r = rects[i], drill = c.k === 'dir', pickable = !!c.n;
      const nestable = drill && c.ch?.length && r.w > 70 && r.h > 46;
      const inner = nestable ? tiles(c) : [];
      const innerRects = nestable ? squarify(inner.map(g => g.d), {x: PAD, y: HEAD, w: r.w - PAD * 2, h: r.h - HEAD - PAD}) : [];
      const showLabel = r.w > 46 && r.h > 18;
      return <div key={c.k + c.n + i} role="listitem" className={`tm-tile kind-${c.k}${pickable ? ' pick' : ''}${nestable ? ' nested' : ''}${pickable && selected.has(c.n) ? ' selected' : ''}`}
        style={{left: r.x, top: r.y, width: r.w, height: r.h, ...(nestable ? {} : {background: colorOf(c, mode, now, cats), color: ink(c, mode, now)})}}
        title={tip(c, node.d, now, cats)} onClick={pickable ? e => select([c.n], howOf(e)) : undefined} onDoubleClick={drill ? () => open([c.n]) : undefined} onContextMenu={pickable ? e => menu(e, c.n) : undefined}>
        {showLabel && <span className="tm-label"><strong>{c.k === 'locked' && <Lock size={10} />}{label(c)}</strong>{r.h > 34 && !nestable && <small>{bytes(c.d)}</small>}{nestable && <small>{bytes(c.d)}</small>}</span>}
        {inner.map((g, j) => { const q = innerRects[j]; const gd = g.k === 'dir', gp = !!g.n;
          return <div key={g.k + g.n + j} className={`tm-tile inner kind-${g.k}${gp ? ' pick' : ''}${gp && selected.has(c.n + '/' + g.n) ? ' selected' : ''}`} style={{left: q.x, top: q.y, width: q.w, height: q.h, background: colorOf(g, mode, now, cats), color: ink(g, mode, now)}}
            title={`${c.n}/${tip(g, c.d, now, cats)}`} onClick={e => { e.stopPropagation(); const h = howOf(e); select(gp ? [c.n, g.n] : [c.n], {add: h.add || h.range}); }} onDoubleClick={e => { e.stopPropagation(); if (gd) open([c.n, g.n]); else if (drill) open([c.n]); }} onContextMenu={e => { e.stopPropagation(); menu(e, gp ? `${c.n}/${g.n}` : c.n); }}>
            {q.w > 46 && q.h > 16 && <span className="tm-label"><strong>{label(g)}</strong>{q.h > 30 && <small>{bytes(g.d)}</small>}</span>}
          </div>; })}
      </div>;
    })}
  </div>;
}

/** `now` is the status snapshot time, so ages and "scanned … ago" advance with each dashboard poll. */
export default function UsagePanel({token, now, setupCommand, user}: {token?: string; now: number; setupCommand?: string; user?: string}) {
  const [mounts, setMounts] = useState<MountInfo[] | null>(null);
  const [mount, setMount] = useState<string | null>(null);
  const [path, setPath] = useState('/');
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ColorMode>('category');
  // Selection, per folder: `items` are paths relative to the folder being shown ("a" or "a/b" from the treemap's inner
  // tiles); `focus` is the one whose details are shown; `anchor` is where a Shift-click range starts.
  const [sel, setSel] = useState<{at: string; items: string[]; focus: string | null; anchor: string | null} | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [batch, setBatch] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<{x: number; y: number; keys: string[]; from: HTMLElement | null} | null>(null);
  // Selection keys are listened for on the document (see onKeys); the ref always holds this render's handler.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onDoc = (e: KeyboardEvent) => keysRef.current(e);
    document.addEventListener('keydown', onDoc);
    return () => document.removeEventListener('keydown', onDoc);
  }, []);
  const [view, setView] = useState<'map' | 'cleanup'>('map');
  // Bumped after a delete: the server already took the item off its cached tree, so just fetch again.
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try { const r = await fetch('/api/storage'); if (r.ok) { const v = await r.json() as {mounts: MountInfo[]}; setMounts(v.mounts); setMount(m => m && v.mounts.some(x => x.mount === m) ? m : v.mounts[0]?.mount ?? null); } } catch { /* next poll */ }
  }, []);
  const current = mounts?.find(m => m.mount === mount) || null;
  const running = !!current?.running, scannedAt = current?.scan?.scannedAt;
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (!mounts?.some(m => m.running)) return; const t = setInterval(refresh, 1500); return () => clearInterval(t); }, [mounts, refresh]);

  useEffect(() => {
    if (!mount) return;
    let live = true; setLoading(true);
    fetch(`/api/storage/tree?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(path)}&depth=2`)
      .then(async r => { const v = await r.json(); if (!r.ok) throw Error(v.error); return v as TreeResponse; })
      .then(v => { if (live) setTree(v); })
      .catch(e => { if (!live) return; if (path !== '/') { toast.error(e.message); setPath('/'); } else setTree(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [mount, path, scannedAt, version]);

  async function act(action: 'scan' | 'cancel') {
    if (!mount || !token) return;
    setBusy(true);
    try {
      const r = await fetch('/api/storage', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Server-Token': token}, body: JSON.stringify({action, mount})});
      const v = await r.json(); if (!r.ok) throw Error(v.error);
      await refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  const parts = path.split('/').filter(Boolean);
  const go = (to: string[]) => setPath('/' + to.join('/'));
  const open = (rel: string[]) => go([...parts, ...rel]);
  // A selection belongs to the folder it was made in; opening another folder shows that folder's own details.
  const here = `${mount}:${path}`;
  const cur = sel && sel.at === here ? sel : null;
  const picked = cur?.items ?? [];
  const pickedSet = new Set(picked);
  const rel = cur?.focus ? cur.focus.split('/') : [];
  const node = tree?.node, cats = tree?.categories;
  const order = (node?.ch || []).filter(c => c.n).map(c => c.n);
  const select = (r: string[], how: How = {}) => {
    const key = r.join('/'), p = cur ?? {at: here, items: [], focus: null, anchor: null};
    let next: typeof sel;
    if (how.range && p.anchor && order.includes(p.anchor) && order.includes(key)) {
      const [a, b] = [order.indexOf(p.anchor), order.indexOf(key)].sort((x, y) => x - y);
      next = {...p, items: order.slice(a, b + 1), focus: key};
    } else if (how.add || how.range || selectMode) {
      if (p.items.includes(key)) {
        const items = p.items.filter(x => x !== key);
        next = items.length ? {...p, items, focus: items.at(-1)!, anchor: key} : null;
      } else {
        const outer = p.items.find(x => key.startsWith(x + '/'));
        if (outer) { toast.info(`Already included: it is inside ${outer.split('/').pop()}, which is selected`); return; }
        // A folder replaces anything already selected inside it.
        next = {...p, items: [...p.items.filter(x => !x.startsWith(key + '/')), key], focus: key, anchor: key};
      }
    } else {
      next = p.items.length === 1 && p.items[0] === key ? null : {at: here, items: [key], focus: key, anchor: key};
    }
    setSel(next);
    // On touch screens the details sit below the list (see .usage-main in CSS): bring them into view for a single
    // pick. Not with a mouse, where moving the page between the two clicks of a double-click would open the wrong folder.
    if (next?.items.length === 1 && !selectMode && window.matchMedia('(max-width: 1180px) and (pointer: coarse)').matches)
      requestAnimationFrame(() => panelRef.current?.querySelector('.usage-detail')?.scrollIntoView({behavior: 'smooth', block: 'start'}));
  };
  const selectAll = () => order.length && setSel({at: here, items: order, focus: order.at(-1)!, anchor: order[0]});
  const clear = () => { setSel(null); setSelectMode(false); };
  const sizeOf = (key: string) => node ? findRel(node, key.split('/'))?.d ?? 0 : 0;
  const pickedBytes = picked.reduce((a, k) => a + sizeOf(k), 0);
  const fromMount = (key: string) => '/' + [...parts, ...key.split('/')].join('/');
  /** Esc clears; Ctrl/Cmd-A selects the whole folder (not while typing in a field). */
  /**
   * Right-click: like a file manager, an item that is part of the selection keeps the selection; any other item
   * becomes the selection. Touch long-press is left to select mode (it fires contextmenu too).
   */
  const openMenu: Menu = (e, key) => {
    e.preventDefault();
    if ('pointerType' in e.nativeEvent && (e.nativeEvent as PointerEvent).pointerType === 'touch') return;
    const keys = pickedSet.has(key) ? picked : [key];
    if (!pickedSet.has(key)) setSel({at: here, items: [key], focus: key, anchor: key});
    const from = e.currentTarget as HTMLElement;
    const r = from.getBoundingClientRect();
    const at = 'clientX' in e && (e.clientX || e.clientY) ? {x: e.clientX, y: e.clientY} : {x: r.left + 24, y: r.bottom - 4};
    setMenu({...at, keys, from});
  };
  const absolute = (key: string) => (mount === '/' ? '' : mount) + fromMount(key);
  /**
   * Esc clears, Delete deletes the selection, Ctrl/Cmd-A selects the whole folder: while focus is in this panel or on
   * the page itself (it lands on the body when the focused button goes away), never while typing or in a dialog/menu.
   */
  const onKeys = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest?.('input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]') || document.querySelector('[role=dialog]')) return;
    if (t !== document.body && !panelRef.current?.contains(t)) return;
    if (e.key === 'Escape' && (picked.length || selectMode)) { e.preventDefault(); clear(); }
    else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && picked.length && token && view === 'map') { e.preventDefault(); setBatch(picked.map(fromMount)); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && view === 'map' && order.length) { e.preventDefault(); selectAll(); }
  };
  useLayoutEffect(() => { keysRef.current = onKeys; });
  /** From the cleanup list: open the item's folder in the map and select the item. */
  const show = (abs: string) => {
    const relParts = (mount === '/' ? abs : abs.slice((mount || '').length)).split('/').filter(Boolean);
    const parent = '/' + relParts.slice(0, -1).join('/');
    const key = relParts.at(-1)!;
    setPath(parent); setSel({at: `${mount}:${parent}`, items: [key], focus: key, anchor: key}); setView('map');
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({behavior: 'smooth', block: 'start'}));
  };

  if (mounts && !mounts.length) return <Panel title="Disk usage"><Empty icon={FolderSearch} title="No filesystems to scan">No mounted ext4, xfs, btrfs or similar filesystem was found.</Empty></Panel>;

  const scan = current?.scan, prog = current?.running?.progress;
  const sub = running && prog ? `Scanning… ${prog.files.toLocaleString()} files · ${bytes(prog.bytes)} so far`
    : scan ? `Scanned ${ago(now - scan.scannedAt)} · ${(scan.durationMs / 1000).toFixed(0)} s · ${scan.files.toLocaleString()} files${scan.partial ? ' · incomplete' : ''}`
    : 'Find the folders and files that take up space';
  const action = <div className="usage-actions">
    {running ? <button className="button small" disabled={busy} onClick={() => act('cancel')}><Square size={12} />Stop</button>
      : <button className={`button small${scan ? '' : ' primary'}`} disabled={busy || !mount || !token} onClick={() => act('scan')}><RefreshCw size={12} />{scan ? 'Rescan' : 'Scan'}</button>}
  </div>;

  return <Panel title="Disk usage" sub={sub} action={action} className="usage-panel">
    <div className="usage-body" ref={panelRef}>
      {mounts && mounts.length > 1 && <div className="usage-mounts" role="tablist">{mounts.map(m => {
        const pct = m.total ? Math.round((m.used ?? 0) / m.total * 100) : null, l = levelFor(pct ?? 0, 80, 92);
        return <button key={m.mount} role="tab" aria-selected={m.mount === mount} className={m.mount === mount ? 'selected' : ''} onClick={() => { if (m.mount === mount) { setPath('/'); return; } setMount(m.mount); setPath('/'); setTree(null); }}>
          <span className="mono">{m.mount}</span>
          <small>{m.fstype}{m.total ? ` · ${bytes(m.used)} of ${bytes(m.total)}` : ''}{m.running ? ' · scanning' : ''}</small>
          <small className={`usage-forecast level-${m.space?.level || 'ok'}`}>{forecastText(m.space)}</small>
          {pct != null && <span className="meter small"><span style={{width: `${pct}%`, background: l === 'ok' ? 'var(--amber)' : levelColor[l]}} /></span>}
        </button>;
      })}</div>}

      {current?.space && current.space.level !== 'ok' && <div className={`space-banner level-${current.space.level}`} role="status">
        <AlertTriangle size={16} />
        <div>
          <strong>{current.mount} is {current.space.percent}% full{current.space.forecast?.daysLeft != null ? `, and fills up in about ${Math.max(1, Math.round(current.space.forecast.daysLeft))} days at ${bytes(current.space.forecast.perDay)}/day` : ''}.</strong>
          {current.space.suggest?.length ? <p>Biggest things to review: {current.space.suggest.map((x, i) => <span key={x.path}>{i ? ', ' : ''}<button className="link-button mono" onClick={() => show(x.path)}>{x.path.split('/').pop()}</button> {bytes(x.bytes)}</span>)}.</p>
            : <p>{current.scan ? 'See Cleanup for what can go.' : 'Scan it to see what takes the space.'}</p>}
        </div>
        <button className="button small" onClick={() => setView('cleanup')}>Open Cleanup</button>
      </div>}
      {current?.lastError && <div className="gpu-note">Last scan failed: {current.lastError}</div>}
      {running && prog && <div className="usage-progress"><span className="mono">{prog.path}</span><span>{prog.dirs.toLocaleString()} folders{prog.errors ? ` · ${prog.errors} unreadable` : ''}</span></div>}

      {mount && <div className="segmented usage-views" role="tablist" aria-label="View">
        {([['map', 'Map'], ['cleanup', 'Cleanup']] as const).map(([v, text]) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'selected' : ''} onClick={() => setView(v)}>{text}</button>)}
      </div>}

      {view === 'cleanup' && mount && <UsageCleanup mount={mount} token={token} now={now} scannedAt={scannedAt} version={version} setupCommand={setupCommand} onShow={show} onChanged={() => setVersion(v => v + 1)} />}

      {view === 'map' && !node && !loading && !running && <Empty icon={FolderSearch} title="Not scanned yet">
        Scanning reads every folder on <span className="mono">{mount}</span> at low priority. It never changes anything and stays on this filesystem. Large drives can take a few minutes, and a spun-down hard drive will wake up.
      </Empty>}

      {view === 'map' && node && <>
        <div className="usage-toolbar">
          <nav className="usage-crumbs" aria-label="Folder">
            <button onClick={() => go([])} className={parts.length ? '' : 'here'}>{mount}</button>
            {parts.map((p, i) => <span key={i}><ChevronRight size={12} /><button className={i === parts.length - 1 ? 'here' : ''} onClick={() => go(parts.slice(0, i + 1))}>{p}</button></span>)}
          </nav>
          <div className="segmented" role="group" aria-label="Colour by">
            {MODES.map(([m, text]) => <button key={m} className={mode === m ? 'selected' : ''} onClick={() => setMode(m)}>{text}</button>)}
          </div>
        </div>
        <div className="usage-summary">
          <strong>{bytes(node.d)}</strong><span className="dim">{node.f.toLocaleString()} files{node.m ? ` · newest change ${age(node.m, now)}` : ''}{current?.used && parts.length ? ` · ${(node.d / current.used * 100).toFixed(1)}% of used space` : ''}</span>
          {node.g != null && tree?.meta?.previous && <span className={`usage-growth ${node.g > 1024 ** 2 ? 'up' : node.g < -(1024 ** 2) ? 'down' : ''}`} title={`Compared with the scan of ${new Date(tree.meta.previous.scannedAt).toLocaleString()}`}>
            {node.nw ? 'new' : Math.abs(node.g) < 1024 ** 2 ? 'unchanged' : signed(node.g)} since the scan {ago(now - tree.meta.previous.scannedAt)}</span>}
          {node.p && <span className="dim usage-warn">Some folders could not be read{scan?.partial ? ' or the scan stopped early' : ''}, so totals are lower than the real size.</span>}
        </div>
        <div className="usage-main">
          <div className={`usage-map${loading ? ' loading' : ''}`} aria-busy={loading}>
            {node.ch?.length ? <Treemap node={node} mode={mode} now={now} cats={cats} selected={pickedSet} select={select} open={open} menu={openMenu} /> : <Empty compact icon={FolderSearch} title="Nothing large inside">{node.k === 'locked' ? 'This folder could not be read.' : 'Everything here is under 1 MB.'}</Empty>}
            <div className="usage-legend">
              {mode === 'age' ? <><span className="dim">Newest change:</span>{AGES.map(([, text, pct]) => <span key={text}><i style={{background: `color-mix(in srgb, var(--amber) ${pct}, var(--surface-2, #1b1c20))`}} />{text}</span>)}</>
                : mode === 'growth' ? (tree?.meta?.previous ? GROWTH.slice(0, 5).map(([text, color]) => <span key={text}><i style={{background: color}} />{text}</span>) : <span className="dim">Rescan later to compare: growth is measured against the previous scan.</span>)
                : mode === 'category' ? Object.entries(VERDICTS).map(([k, [text, color]]) => <span key={k}><i style={{background: color}} />{text}</span>)
                : ['dir', 'file', 'files', 'locked', 'mount'].map(k => <span key={k}><i style={{background: TYPES[k][1]}} />{TYPES[k][0]}</span>)}
              <span className="dim usage-hint">Area is space on disk. Select for details; double-click a folder, or use →, to open it.</span>
            </div>
          </div>
          {mount && (picked.length > 1
            ? <SelectionSummary node={node} items={picked} bytes={pickedBytes} remove={k => select(k.split('/'), {add: true})} clear={clear} del={token ? () => setBatch(picked.map(fromMount)) : undefined} />
            : <UsageDetail mount={mount} path={'/' + [...parts, ...rel].join('/')} parentSize={rel.length ? node.d : null} now={now} scannedAt={scannedAt}
              onOpen={rel.length && findRel(node, rel)?.k === 'dir' ? () => open(rel) : undefined} onClose={rel.length ? clear : undefined}
              token={token} user={user} onDeleted={() => { clear(); setVersion(v => v + 1); }} />)}
        </div>
        <div className="usage-listbar">
          {selectMode
            ? <><button className="button small" onClick={() => setSelectMode(false)}><Check size={12} />Done</button><button className="button small" onClick={selectAll}>Select all</button>
              <span className="dim">Tap items to add or remove them.</span></>
            : <><button className="button small" onClick={() => setSelectMode(true)}><ListChecks size={12} />Select</button>
              <span className="dim usage-keys">Ctrl-click to add, Shift-click for a range, Ctrl+A for all, Esc to clear.</span></>}
        </div>
        <UsageList node={node} now={now} cats={cats} selected={pickedSet} select={select} open={open} checks={selectMode || picked.length > 1}
          longPress={k => { setSelectMode(true); select([k], {add: true}); }} menu={openMenu} />
        {menu && <ItemMenu at={menu} count={menu.keys.length} close={() => { const f = menu.from; setMenu(null); f?.focus?.(); }} items={[
          ...(menu.keys.length === 1 && findRel(node, menu.keys[0].split('/'))?.k === 'dir' ? [{icon: FolderOpen, label: 'Open', run: () => open(menu.keys[0].split('/'))}] : []),
          {icon: Copy, label: menu.keys.length === 1 ? 'Copy path' : `Copy ${menu.keys.length} paths`, run: () => navigator.clipboard.writeText(menu.keys.map(absolute).join('\n'))
            .then(() => toast.success(menu.keys.length === 1 ? 'Path copied' : 'Paths copied')).catch(() => toast.error('Could not copy'))},
          {icon: CheckCheck, label: 'Select all', run: selectAll},
          ...(token ? [{icon: Trash2, label: menu.keys.length === 1 ? 'Delete…' : `Delete ${menu.keys.length} items…`, danger: true, run: () => setBatch(menu.keys.map(fromMount))}] : []),
        ]} />}
        {(picked.length > 1 || selectMode) && <div className="selection-bar" role="region" aria-label="Selection">
          <strong>{picked.length} selected</strong><span className="dim">{bytes(pickedBytes)}</span>
          <span className="spacer" />
          <button className="button small" onClick={clear}><X size={12} />Clear</button>
          <button className="button small danger-outline" disabled={!picked.length || !token} onClick={() => setBatch(picked.map(fromMount))}><Trash2 size={12} />Delete…</button>
        </div>}
        {batch && token && mount && <DeleteDialog mount={mount} paths={batch} token={token} user={user} now={now} onClose={() => setBatch(null)}
          onDone={r => { setBatch(null); announceDelete(r, batch.length === 1 ? batch[0].split('/').pop()! : `${batch.length} items`); clear(); setVersion(v => v + 1); }} />}
      </>}
    </div>
  </Panel>;
}

/** "Full in ~23 days", "Growing 1.2 GB/day", or how much history the forecast still needs. */
function forecastText(s?: Space | null) {
  if (!s) return '';
  const f = s.forecast;
  if (!f) return 'Forecast after a few days of data';
  if (f.daysLeft != null) return `Full in ~${Math.max(1, Math.round(f.daysLeft))} days`;
  return Math.abs(f.perDay) < 10 * 1024 ** 2 ? 'Steady' : f.perDay > 0 ? `Growing ${bytes(f.perDay)}/day` : `Shrinking ${bytes(-f.perDay)}/day`;
}

const findRel = (node: UNode, rel: string[]) => rel.reduce<UNode | undefined>((n, p) => n?.ch?.find(c => c.n === p), node);

/** The same data as a list: readable on phones, keyboard friendly, and shows the numbers the treemap only implies. */
function UsageList({node, now, cats, selected, select, open, checks, longPress, menu}: {node: UNode; now: number; cats?: Categories; selected: Set<string>; select: Pick; open: Pick;
  checks: boolean; longPress: (name: string) => void; menu: Menu}) {
  const rows = (node.ch || []).slice(0, 60);
  const max = rows[0]?.d || 1;
  // Long-press (touch) starts selecting several; the click that follows the press must not also toggle.
  const press = useRef<{timer?: ReturnType<typeof setTimeout>; fired?: boolean}>({});
  const startPress = (e: React.PointerEvent, name: string) => {
    if (e.pointerType !== 'touch') return;
    press.current.fired = false;
    press.current.timer = setTimeout(() => { press.current.fired = true; navigator.vibrate?.(15); longPress(name); }, 500);
  };
  const endPress = () => clearTimeout(press.current.timer);
  return <div className={`usage-list${checks ? ' checking' : ''}`} role="table" aria-label="Largest items" aria-multiselectable="true">
    <div className="usage-row head" role="row"><span>Name</span><span>Size</span><span>Share</span><span>Files</span><span>Newest change</span><span /></div>
    {rows.map((c, i) => {
      const drill = c.k === 'dir', pickable = !!c.n, cat = c.t ? cats?.[c.t] : undefined, on = pickable && selected.has(c.n);
      return <div key={c.k + c.n + i} role="row" aria-selected={pickable ? on : undefined} className={`usage-row kind-${c.k}${pickable ? ' pick' : ''}${on ? ' selected' : ''}`} tabIndex={pickable ? 0 : undefined} title={tip(c, node.d, now, cats)}
        onClick={pickable ? e => { if (press.current.fired) { press.current.fired = false; return; } select([c.n], howOf(e)); } : undefined} onDoubleClick={drill ? () => open([c.n]) : undefined}
        onPointerDown={pickable ? e => startPress(e, c.n) : undefined} onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress} onContextMenu={pickable ? e => menu(e, c.n) : undefined}
        onKeyDown={pickable ? e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) menu(e, c.n); else if (e.key === 'Enter' && drill && !e.shiftKey && !e.ctrlKey && !e.metaKey) open([c.n]); else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); select([c.n], howOf(e)); } } : undefined}>
        <span className="name">{checks && <span className={`row-check${on ? ' on' : ''}`} aria-hidden="true">{on && <Check size={11} />}</span>}<i style={{background: TYPES[c.k]?.[1]}} />{c.k === 'locked' && <Lock size={11} />}<span className={c.n ? 'mono' : 'dim'}>{label(c)}{drill ? '/' : ''}</span>
          {cat && <small className="usage-cat" style={{color: VERDICTS[cat.verdict][1]}}>{cat.label}</small>}{c.h && <small className="dim">hardlink</small>}</span>
        <span>{bytes(c.d)}</span>
        <span className="share"><span className="meter small"><span style={{width: `${Math.max(1, c.d / max * 100)}%`}} /></span>{node.d ? `${(c.d / node.d * 100).toFixed(1)}%` : ''}</span>
        <span>{c.f ? c.f.toLocaleString() : '—'}</span>
        <span title={c.m ? new Date(c.m).toLocaleString() : undefined}>{age(c.m, now)}</span>
        <span className="open">{drill && <button className="icon-button" aria-label={`Open ${c.n}`} onClick={e => { e.stopPropagation(); open([c.n]); }}><ArrowRight size={13} /></button>}</span>
      </div>;
    })}
    {(node.c ?? 0) > rows.length && <div className="usage-row more dim" role="row"><span>Showing the largest {rows.length} of {node.c?.toLocaleString()} items</span></div>}
  </div>;
}

/** In place of the detail panel when several items are selected: what is in the selection, and the way to delete it. */
function SelectionSummary({node, items, bytes: total, remove, clear, del}: {node: UNode; items: string[]; bytes: number; remove: (key: string) => void; clear: () => void; del?: () => void}) {
  const rows = items.map(k => ({k, n: findRel(node, k.split('/'))})).sort((a, b) => (b.n?.d ?? 0) - (a.n?.d ?? 0));
  const files = rows.reduce((a, r) => a + (r.n?.f ?? 0), 0);
  return <aside className="usage-detail selection-summary">
    <div className="ud-head"><div><small className="dim">Selected</small><strong>{items.length} items</strong></div>
      <div className="ud-head-actions"><button className="icon-button" aria-label="Clear selection" onClick={clear}><X size={14} /></button></div></div>
    <p className="ss-total"><strong>{bytes(total)}</strong> <span className="dim">· {files.toLocaleString()} files</span></p>
    <ul className="ss-list">{rows.map(({k, n}) => <li key={k}>
      <i style={{background: n ? TYPES[n.k]?.[1] : undefined}} /><span className="mono" title={k}>{k}{n?.k === 'dir' ? '/' : ''}</span><span className="dim">{n ? bytes(n.d) : '—'}</span>
      <button className="icon-button" aria-label={`Remove ${k} from the selection`} onClick={() => remove(k)}><X size={12} /></button>
    </li>)}</ul>
    {del && <button className="button small danger-outline ud-delete" onClick={del}><Trash2 size={12} />Delete {items.length} items…</button>}
    <p className="dim ud-small">Each item is checked again before anything is deleted; any that can’t go are listed and left alone.</p>
  </aside>;
}

/**
 * The right-click menu: positioned at the pointer and kept inside the window, focus on the first entry, arrow keys
 * move, Enter runs, Esc / a click elsewhere / scrolling closes it and focus goes back to the item.
 */
function ItemMenu({at, count, items, close}: {at: {x: number; y: number}; count: number; close: () => void;
  items: {icon: React.ElementType; label: string; run: () => void; danger?: boolean}[]}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({left: at.x, top: at.y});
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const {width, height} = el.getBoundingClientRect(), pad = 8;
    setPos({left: Math.max(pad, Math.min(at.x, window.innerWidth - width - pad)), top: Math.max(pad, Math.min(at.y, window.innerHeight - height - pad))});
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [at.x, at.y]);
  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const shut = () => close();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    window.addEventListener('blur', shut);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('scroll', shut, true); window.removeEventListener('resize', shut); window.removeEventListener('blur', shut); };
  }, [close]);
  const onKey = (e: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); buttons.at(-1)?.focus(); }
  };
  return <div ref={ref} className="item-menu" role="menu" aria-label={count > 1 ? `${count} selected items` : 'Item'} style={pos} onKeyDown={onKey} onContextMenu={e => e.preventDefault()}>
    {count > 1 && <div className="item-menu-head">{count} selected</div>}
    {items.map(({icon: Icon, label, run, danger}) => <button key={label} role="menuitem" className={danger ? 'danger' : ''} onClick={() => { close(); run(); }}>
      <Icon size={13} />{label}
    </button>)}
  </div>;
}
