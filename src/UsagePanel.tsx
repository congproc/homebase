import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, ArrowRight, ChevronRight, FolderSearch, Lock, RefreshCw, Square} from 'lucide-react';
import {toast} from 'sonner';
import {Panel, Empty} from './components/panels';
import {ago, bytes, levelColor, levelFor, since} from './lib/format';
import UsageDetail, {VERDICTS, type Categories} from './UsageDetail';
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

type Pick = (rel: string[]) => void;
/** Click selects (details below), double-click opens a folder. */
function Treemap({node, mode, now, cats, selected, select, open}: {node: UNode; mode: ColorMode; now: number; cats?: Categories; selected: string; select: Pick; open: Pick}) {
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
      return <div key={c.k + c.n + i} role="listitem" className={`tm-tile kind-${c.k}${pickable ? ' pick' : ''}${nestable ? ' nested' : ''}${pickable && selected === c.n ? ' selected' : ''}`}
        style={{left: r.x, top: r.y, width: r.w, height: r.h, ...(nestable ? {} : {background: colorOf(c, mode, now, cats), color: ink(c, mode, now)})}}
        title={tip(c, node.d, now, cats)} onClick={pickable ? () => select([c.n]) : undefined} onDoubleClick={drill ? () => open([c.n]) : undefined}>
        {showLabel && <span className="tm-label"><strong>{c.k === 'locked' && <Lock size={10} />}{label(c)}</strong>{r.h > 34 && !nestable && <small>{bytes(c.d)}</small>}{nestable && <small>{bytes(c.d)}</small>}</span>}
        {inner.map((g, j) => { const q = innerRects[j]; const gd = g.k === 'dir', gp = !!g.n;
          return <div key={g.k + g.n + j} className={`tm-tile inner kind-${g.k}${gp ? ' pick' : ''}${gp && selected === c.n + '/' + g.n ? ' selected' : ''}`} style={{left: q.x, top: q.y, width: q.w, height: q.h, background: colorOf(g, mode, now, cats), color: ink(g, mode, now)}}
            title={`${c.n}/${tip(g, c.d, now, cats)}`} onClick={e => { e.stopPropagation(); select(gp ? [c.n, g.n] : [c.n]); }} onDoubleClick={e => { e.stopPropagation(); if (gd) open([c.n, g.n]); else if (drill) open([c.n]); }}>
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
  const [sel, setSel] = useState<{at: string; rel: string[]} | null>(null);
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
  const rel = sel && sel.at === `${mount}:${path}` ? sel.rel : [];
  const select = (r: string[]) => {
    const at = `${mount}:${path}`, same = !!sel && sel.at === at && sel.rel.join('/') === r.join('/');
    setSel(same ? null : {at, rel: r});
    // On touch screens the details sit below the list (see .usage-main in CSS): bring them into view. Not with a mouse,
    // where moving the page between the two clicks of a double-click would open the wrong folder.
    if (!same && window.matchMedia('(max-width: 1180px) and (pointer: coarse)').matches)
      requestAnimationFrame(() => panelRef.current?.querySelector('.usage-detail')?.scrollIntoView({behavior: 'smooth', block: 'start'}));
  };
  const node = tree?.node, cats = tree?.categories;
  /** From the cleanup list: open the item's folder in the map and select the item. */
  const show = (abs: string) => {
    const relParts = (mount === '/' ? abs : abs.slice((mount || '').length)).split('/').filter(Boolean);
    const parent = '/' + relParts.slice(0, -1).join('/');
    setPath(parent); setSel({at: `${mount}:${parent}`, rel: relParts.slice(-1)}); setView('map');
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
            {node.ch?.length ? <Treemap node={node} mode={mode} now={now} cats={cats} selected={rel.join('/')} select={select} open={open} /> : <Empty compact icon={FolderSearch} title="Nothing large inside">{node.k === 'locked' ? 'This folder could not be read.' : 'Everything here is under 1 MB.'}</Empty>}
            <div className="usage-legend">
              {mode === 'age' ? <><span className="dim">Newest change:</span>{AGES.map(([, text, pct]) => <span key={text}><i style={{background: `color-mix(in srgb, var(--amber) ${pct}, var(--surface-2, #1b1c20))`}} />{text}</span>)}</>
                : mode === 'growth' ? (tree?.meta?.previous ? GROWTH.slice(0, 5).map(([text, color]) => <span key={text}><i style={{background: color}} />{text}</span>) : <span className="dim">Rescan later to compare: growth is measured against the previous scan.</span>)
                : mode === 'category' ? Object.entries(VERDICTS).map(([k, [text, color]]) => <span key={k}><i style={{background: color}} />{text}</span>)
                : ['dir', 'file', 'files', 'locked', 'mount'].map(k => <span key={k}><i style={{background: TYPES[k][1]}} />{TYPES[k][0]}</span>)}
              <span className="dim usage-hint">Area is space on disk. Select for details; double-click a folder, or use →, to open it.</span>
            </div>
          </div>
          {mount && <UsageDetail mount={mount} path={'/' + [...parts, ...rel].join('/')} parentSize={rel.length ? node.d : null} now={now} scannedAt={scannedAt}
            onOpen={rel.length && findRel(node, rel)?.k === 'dir' ? () => open(rel) : undefined} onClose={rel.length ? () => setSel(null) : undefined}
            token={token} user={user} onDeleted={() => { setSel(null); setVersion(v => v + 1); }} />}
        </div>
        <UsageList node={node} now={now} cats={cats} selected={rel.join('/')} select={select} open={open} />
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
function UsageList({node, now, cats, selected, select, open}: {node: UNode; now: number; cats?: Categories; selected: string; select: Pick; open: Pick}) {
  const rows = (node.ch || []).slice(0, 60);
  const max = rows[0]?.d || 1;
  return <div className="usage-list" role="table" aria-label="Largest items">
    <div className="usage-row head" role="row"><span>Name</span><span>Size</span><span>Share</span><span>Files</span><span>Newest change</span><span /></div>
    {rows.map((c, i) => {
      const drill = c.k === 'dir', pickable = !!c.n, cat = c.t ? cats?.[c.t] : undefined;
      return <div key={c.k + c.n + i} role="row" className={`usage-row kind-${c.k}${pickable ? ' pick' : ''}${pickable && selected === c.n ? ' selected' : ''}`} tabIndex={pickable ? 0 : undefined} title={tip(c, node.d, now, cats)}
        onClick={pickable ? () => select([c.n]) : undefined} onDoubleClick={drill ? () => open([c.n]) : undefined}
        onKeyDown={pickable ? e => { if (e.key === 'Enter' && drill) open([c.n]); else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); select([c.n]); } } : undefined}>
        <span className="name"><i style={{background: TYPES[c.k]?.[1]}} />{c.k === 'locked' && <Lock size={11} />}<span className={c.n ? 'mono' : 'dim'}>{label(c)}{drill ? '/' : ''}</span>
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
