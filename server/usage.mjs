// Disk usage explorer (read-only): which folders and files take the space on each mounted filesystem.
// Scans run on request only, one per filesystem, in a child process at idle CPU and I/O priority (usage-scan.mjs).
// Results are cached gzipped under ~/.local/state/homebase/storage and kept in memory only while being browsed.
// Clients name a filesystem by its mountpoint and a folder by its path; both are resolved against the mount table
// and the cached tree, so no client-supplied path ever reaches the filesystem.
import {spawn, execFileSync} from 'node:child_process';
import {readFile, rm, statfs} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {CATEGORIES, categorize, parseSwaps} from './categories.mjs';
import {describe} from './usage-item.mjs';
import {openPaths, usedOn} from './cleanup.mjs';
import {growthHotspots} from './candidates.mjs';
import {readCache, scannerNodeFlags, writeCache} from './usage-scan.mjs';
import {summarize, summaryPath, writeSummary} from './usage-scan-run.mjs';
export {growthHotspots};
import {BIG, checkTarget, createTrashLog, exceedsLimits, fingerprint, moveToTrash, newId, protectedPaths, sameFile, trashFor} from './delete.mjs';

const SCANNER = fileURLToPath(new URL('./usage-scan-run.mjs', import.meta.url));
const CACHE_DIR = path.join(os.homedir(), '.local/state/homebase/storage');
// A loaded tree is ~70 MB of heap for 1.4 M files: keep it only while someone is browsing the map.
const KEEP_IN_MEMORY = 3 * 60 * 1000;
// Filesystems that hold user data; pseudo, overlay (Docker), squashfs (snaps) and tmpfs are left out.
const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'bcachefs', 'jfs', 'reiserfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'nfs', 'nfs4', 'cifs', 'smb3']);
export const LIMITS = {top: 200, nested: 40, depth: 3};

/** "\040" style escapes in /proc/self/mountinfo → characters. */
const unescape = s => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

/** /proc/self/mountinfo → [{mount, root, fstype, source, device, opts}]. */
export function parseMountinfo(raw) {
  return raw.split('\n').filter(Boolean).map(line => {
    const [left, right = ''] = line.split(' - ');
    const f = left.split(' '), r = right.split(' ');
    return {device: f[2], root: unescape(f[3] || ''), mount: unescape(f[4] || ''), opts: f[5] || '', fstype: r[0], source: unescape(r[1] || '')};
  }).filter(m => m.mount.startsWith('/'));
}

const within = (root, base) => base === '/' || root === base || root.startsWith(base + '/');

/**
 * Filesystems worth scanning: real fstypes, each (device, root) once. A mount whose root lies inside another kept
 * mount's root on the same device is a bind mount of data already counted there, so it is left out; sibling roots
 * such as btrfs subvolumes (/@, /@home) are kept as separate targets. The result keeps mount-table order.
 * Every mountpoint, of any type, is a boundary the scanner stops at.
 */
export function scanTargets(entries) {
  const candidates = entries.filter(m => REAL_FS.has(m.fstype) && !m.mount.startsWith('/snap/') && !m.mount.startsWith('/var/lib/docker/'));
  const kept = [];
  // Shortest roots first, so a parent is kept before the binds inside it.
  for (const m of [...candidates].sort((a, b) => a.root.length - b.root.length)) {
    if (kept.some(k => k.device === m.device && within(m.root, k.root))) continue;
    kept.push(m);
  }
  return candidates.filter(m => kept.includes(m));
}

/** Child names along `rel` ("/var/lib" → ["var","lib"]), refusing anything that is not a plain path. */
export function segments(rel) {
  if (typeof rel !== 'string' || rel.length > 4096 || rel.includes('\0')) throw Error('Invalid path');
  const parts = rel.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) throw Error('Invalid path');
  return parts;
}

const strip = ({ch: _ch, ...rest}) => rest;

/**
 * The part of a cached tree the treemap needs: `depth` levels below `node`, the largest `top` children at the first
 * level and `nested` below that, the rest folded into one "more" entry with their totals. With `at` (the node's
 * absolute path), each named entry is tagged `t` with its category id.
 */
export function view(node, depth = 2, {top = LIMITS.top, nested = LIMITS.nested, at = null, swaps} = {}, level = 0) {
  const out = strip(node);
  if (at && node.n !== '') { const t = categorize(at, swaps); if (t) out.t = t; }
  if (!node.ch) return out;
  out.c = node.ch.length;
  if (depth <= 0) return out;
  const limit = level === 0 ? top : nested;
  const kept = node.ch.slice(0, limit), rest = node.ch.slice(limit);
  out.ch = kept.map(c => view(c, depth - 1, {top, nested, swaps, at: at && c.n ? path.posix.join(at, c.n) : null}, level + 1));
  if (rest.length) out.ch.push(rest.reduce((a, c) => ({...a, d: a.d + c.d, s: a.s + c.s, f: a.f + c.f, m: Math.max(a.m, c.m), x: a.x + 1}), {n: '', k: 'more', d: 0, s: 0, f: 0, m: 0, x: 0}));
  return out;
}

/** Walks a cached tree by names. */
export function find(tree, parts) {
  let node = tree;
  for (const p of parts) {
    // Synthetic entries ("files", "more") have an empty name, which no real path segment can match.
    node = node.ch?.find(c => c.n === p);
    if (!node) return null;
  }
  return node;
}

const cacheFile = mount => path.join(CACHE_DIR, createHash('sha256').update(mount).digest('hex').slice(0, 16) + '.json.gz');
// ionice/nice exec the scanner, so the IPC channel is inherited; fall back to plain node when they are missing.
const has = bin => { try { execFileSync('sh', ['-c', `command -v ${bin}`], {stdio: 'ignore'}); return true; } catch { return false; } };
const PRIORITY = [...(has('ionice') ? ['ionice', '-c3'] : []), ...(has('nice') ? ['nice', '-n', '19'] : [])];

export function createUsage({mountinfo = () => readFile('/proc/self/mountinfo', 'utf8'), swapsFile = '/proc/swaps', proc = '/proc', cacheOf = cacheFile, record = () => {},
  protect = protectedPaths(), trashLog, trashDays = 7, verifyPassword = async () => { throw Error('Password check unavailable'); }, home = os.homedir(), dpkg} = {}) {
  const swaps = async () => parseSwaps(await readFile(swapsFile, 'utf8').catch(() => ''));
  const jobs = new Map(), trees = new Map(), failures = new Map(), generation = new Map();
  const gen = mount => generation.get(mount) || 0;

  async function mounts() {
    const all = parseMountinfo(await mountinfo());
    return {all, targets: scanTargets(all)};
  }

  // The small summary written next to each cache (meta, cleanup candidates, growth hotspots): enough for the
  // filesystem list, the Cleanup view and the low-space banner, so the tree itself is only loaded to browse the map.
  const summaries = new Map();
  async function summaryOf(mount) {
    if (summaries.has(mount)) return summaries.get(mount);
    const g = gen(mount);
    let s = await readFile(summaryPath(cacheOf(mount)), 'utf8').then(JSON.parse, () => null);
    if (!s) {
      // A cache from before summaries existed: build its summary once from the tree, then drop the tree again.
      const data = await readCache(cacheOf(mount));
      if (data?.tree) {
        s = summarize(data.meta, data.tree, data.meta?.root ?? mount, await swaps());
        await writeSummary(cacheOf(mount), s).catch(() => {});
      }
    }
    if (g === gen(mount)) summaries.set(mount, s);
    return s;
  }
  const metaOf = async mount => (await summaryOf(mount))?.meta ?? null;

  async function load(mount) {
    const hit = trees.get(mount);
    if (hit) { hit.at = Date.now(); return hit; }
    // A scan finishing while this read is in flight bumps the generation: read again instead of caching the old tree.
    for (;;) {
      const g = gen(mount);
      const data = await readCache(cacheOf(mount));
      if (g !== gen(mount)) continue;
      if (!data) return null;
      const entry = {meta: data.meta, tree: data.tree, at: Date.now()};
      trees.set(mount, entry);
      return entry;
    }
  }
  // Drop trees nobody has browsed for a while; the gzip cache brings them back.
  setInterval(() => { for (const [k, v] of trees) if (Date.now() - v.at > KEEP_IN_MEMORY) trees.delete(k); }, 60000).unref();

  async function list() {
    const {targets} = await mounts();
    return {mounts: await Promise.all(targets.map(async m => {
      const fs = await statfs(m.mount).catch(() => null);
      const job = jobs.get(m.mount);
      return {mount: m.mount, fstype: m.fstype, source: m.source,
        ...(fs ? {total: fs.blocks * fs.bsize, used: (fs.blocks - fs.bfree) * fs.bsize, available: fs.bavail * fs.bsize} : {}),
        scan: await metaOf(m.mount), running: job ? {startedAt: job.startedAt, progress: job.progress} : null, lastError: job ? null : failures.get(m.mount) || null};
    }))};
  }

  async function start(mount, {unlimited = false} = {}) {
    const {all, targets} = await mounts();
    const target = targets.find(m => m.mount === mount);
    if (!target) throw Error('Unknown filesystem');
    if (jobs.has(mount)) throw Error('A scan of this filesystem is already running');
    const boundaries = all.map(m => m.mount).filter(m => m !== mount);
    const [cmd, ...pre] = [...PRIORITY, process.execPath];
    // Heap sized from the last scan of this filesystem; a retry after running out of memory goes without a limit.
    const flags = unlimited ? ['--max-semi-space-size=4'] : scannerNodeFlags((await metaOf(mount))?.files ?? 0);
    const child = spawn(cmd, [...pre, ...flags, SCANNER, mount, cacheOf(mount), JSON.stringify(boundaries)], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    const job = {child, startedAt: Date.now(), progress: {files: 0, dirs: 0, bytes: 0, errors: 0, path: mount}};
    let stderr = '', outcome = null;
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-2000); });
    child.on('message', msg => {
      if (msg?.type === 'progress') job.progress = {files: msg.files, dirs: msg.dirs, bytes: msg.bytes, errors: msg.errors, path: msg.path};
      else if (msg?.type === 'done' || msg?.type === 'error') outcome = msg;
    });
    child.on('exit', (code, signal) => {
      jobs.delete(mount);
      clearTimeout(job.watchdog);
      if (outcome?.type === 'done') { generation.set(mount, gen(mount) + 1); trees.delete(mount); summaries.delete(mount); failures.delete(mount); record(`Storage scan finished: ${mount}`); }
      else if (!job.cancelled && !unlimited && !outcome && (signal === 'SIGABRT' || code === 134) && /heap limit|out of memory/i.test(stderr)) {
        record(`Storage scan of ${mount} needed more memory; retrying without a limit`);
        start(mount, {unlimited: true}).catch(e => failures.set(mount, e.message));
      }
      else if (!job.cancelled) failures.set(mount, outcome?.error || stderr.trim().split('\n').pop() || `Scanner stopped (${signal || code})`);
    });
    child.on('error', e => { clearTimeout(job.watchdog); jobs.delete(mount); failures.set(mount, e.message); });
    // The scanner stops itself after 60 minutes; this catches one stuck in uninterruptible I/O (a dead NFS server).
    job.watchdog = setTimeout(() => { outcome = {type: 'error', error: 'The scan took too long and was stopped'}; child.kill('SIGKILL'); }, 65 * 60 * 1000);
    job.watchdog.unref();
    jobs.set(mount, job);
    failures.delete(mount);
    record(`Storage scan started: ${mount}`);
    return {started: true};
  }

  function cancel(mount) {
    const job = jobs.get(mount);
    if (!job) throw Error('No scan is running for this filesystem');
    job.cancelled = true; job.child.kill('SIGTERM');
    return {cancelled: true};
  }

  /** Cached node at `rel` under a known mount, with its absolute path. */
  async function locate(mount, rel) {
    const target = (await mounts()).targets.find(m => m.mount === mount);
    if (!target) throw Error('Unknown filesystem');
    const parts = segments(rel);
    const entry = await load(mount);
    if (!entry) return {target, entry: null, parts};
    const node = find(entry.tree, parts);
    if (!node) throw Error('Not found in the last scan');
    return {target, entry, parts, node, full: path.posix.join(mount, ...parts)};
  }

  async function tree(mount, rel = '/', depth = 2) {
    const {entry, parts, node, full} = await locate(mount, rel);
    if (!entry) return {mount, meta: null, node: null};
    const d = Math.min(LIMITS.depth, Math.max(1, Number(depth) || 2));
    return {mount, path: '/' + parts.join('/'), meta: entry.meta, node: view(node, d, {at: full, swaps: await swaps()}), categories: CATEGORIES};
  }

  async function item(mount, rel = '/') {
    const {target, entry, node, full} = await locate(mount, rel);
    if (!entry) throw Error('Not scanned yet');
    const fs = await statfs(mount).catch(() => null);
    return describe({mount: target, full, node, swaps: await swaps(), fsUsed: fs ? (fs.blocks - fs.bfree) * fs.bsize : null, proc});
  }

  /** Growth since the previous scan: total and hotspots. Null when there is nothing to compare with. */
  async function growth(mount) {
    await target(mount);
    const s = await summaryOf(mount);
    if (!s?.meta?.previous || !s.hotspots) return null;
    return {since: s.meta.previous.scannedAt, total: s.meta.bytes - s.meta.previous.bytes, items: s.hotspots};
  }

  /** Ranked cleanup candidates for a scanned filesystem, each flagged when one of your processes has files open in it. */
  async function candidates(mount, {checkOpen = true} = {}) {
    await target(mount);
    const s = await summaryOf(mount);
    if (!s) return {items: [], groups: [], more: 0, scanned: false};
    const open = checkOpen ? await openPaths(proc) : [];
    const inUse = p => open.some(o => o === p || o.startsWith(p + '/'));
    return {...s.candidates, items: s.candidates.items.map(i => ({...i, inUse: inUse(i.path)})), scanned: true, scannedAt: s.meta.scannedAt};
  }
  async function target(mount) {
    const t = (await mounts()).targets.find(m => m.mount === mount);
    if (!t) throw Error('Unknown filesystem');
    return t;
  }

  // ---------- deleting ----------
  trashLog ??= createTrashLog({home});
  const pending = new Map();
  const PENDING_MS = 5 * 60 * 1000;

  /** Removes a deleted path from the cached tree and its sizes from every ancestor, then saves the cache. */
  async function forget(mount, parts) {
    const entry = await load(mount);
    if (!entry || !parts.length) return;
    const chain = [entry.tree];
    for (const p of parts.slice(0, -1)) { const n = chain.at(-1).ch?.find(c => c.n === p); if (!n) return; chain.push(n); }
    const parent = chain.at(-1), i = parent.ch?.findIndex(c => c.n === parts.at(-1)) ?? -1;
    if (i < 0) return;
    const [gone] = parent.ch.splice(i, 1);
    for (const n of chain) { n.d -= gone.d; n.s -= gone.s; n.f -= gone.f; if (n.g != null) n.g -= gone.d; }
    entry.meta = {...entry.meta, adjusted: true};
    // Keep the summary in step without recomputing it: drop what was inside the deleted path, shrink what contains it.
    const full = path.posix.join(mount, ...parts), under = p => p === full || p.startsWith(full + '/'), holds = p => full.startsWith(p + '/');
    const s = await summaryOf(mount);
    if (s) {
      const c = s.candidates;
      for (const it of c.items) {
        const g = c.groups.find(x => x.category === it.category);
        if (under(it.path)) { if (g) { g.bytes -= it.bytes; g.count--; } }
        else if (holds(it.path)) { it.bytes -= gone.d; if (g) g.bytes -= gone.d; }
      }
      c.items = c.items.filter(it => !under(it.path));
      c.groups = c.groups.filter(g => g.count > 0);
      if (s.hotspots) s.hotspots = s.hotspots.filter(h => !under(h.path)).map(h => holds(h.path) ? {...h, growth: h.growth - gone.d, bytes: h.bytes - gone.d} : h);
      s.meta = {...entry.meta, bytes: entry.tree.d};
      // The previous scan's total stays as it was, so the overall growth drops by what was deleted (as in the tree).
    }
    if (!jobs.has(mount)) {
      await writeCache(cacheOf(mount), {version: 1, meta: entry.meta, tree: entry.tree}).catch(() => {});
      if (s) await writeSummary(cacheOf(mount), s).catch(() => {});
    }
  }

  /** Step 1: everything the confirm dialog shows, and a short-lived id bound to the exact file that was checked. */
  async function prepareDelete(mount, rel) {
    const {target, entry, parts, node, full} = await locate(mount, rel);
    if (!entry) throw Error('Not scanned yet');
    const all = (await mounts()).all.map(m => m.mount);
    const check = await checkTarget({full, mountRoot: mount, mountpoints: all, swaps: await swaps(), protect, home, proc, ...(dpkg ? {dpkg} : {})});
    const trash = check.st && !check.blocked.length ? await trashFor(check.st, mount, {home, create: false}) : null;
    // The scan may be old: a folder that grew since still needs the password, so look again (bounded) when it was small.
    const big = node.d >= BIG.bytes || node.f >= BIG.files || (check.st && !check.blocked.length ? await exceedsLimits(full).catch(() => true) : false);
    for (const [k, v] of pending) if (Date.now() - v.at > PENDING_MS) pending.delete(k);
    const id = check.blocked.length ? null : newId();
    if (id) pending.set(id, {mount, parts, full, fp: fingerprint(check.st), bytes: node.d, files: node.f, big, at: Date.now(), fstype: target.fstype});
    return {id, path: full, name: parts.at(-1) || full, kind: node.k, bytes: node.d, files: node.f, newest: node.m || null, blocked: check.blocked, warnings: check.warnings,
      trash: trash ? (trash.error ? {available: false, error: trash.error} : {available: true, location: trash.dir}) : null,
      needsPassword: {trash: big, permanent: true}, trashDays, partial: !!node.p};
  }

  /** Step 2: re-check everything, insist on the same file, then trash it or delete it for good. */
  async function remove(id, mode, password) {
    if (mode !== 'trash' && mode !== 'permanent') throw Error('Unsupported delete mode');
    const p = typeof id === 'string' && pending.get(id);
    if (!p || Date.now() - p.at > PENDING_MS) throw Error('This confirmation expired. Open the item and try again.');
    // Decided now, not from the scan or the dialog: the folder may have grown since.
    const big = p.big || await exceedsLimits(p.full).catch(() => true);
    if (mode === 'permanent' || big) {
      if (!password) throw Error('Password required: this is a permanent delete or over 1 GB / 1,000 files');
      await verifyPassword(password);
    }
    pending.delete(id); // single use, and only after the password (a typo should not cost the confirmation)
    const all = (await mounts()).all.map(m => m.mount);
    const check = await checkTarget({full: p.full, mountRoot: p.mount, mountpoints: all, swaps: await swaps(), protect, home, proc, ...(dpkg ? {dpkg} : {})});
    if (check.blocked.length) throw Error(check.blocked[0]);
    if (!sameFile(fingerprint(check.st), p.fp)) throw Error('It changed since you opened it. Rescan or open it again.');
    let result;
    if (mode === 'trash') {
      const t = await trashFor(check.st, p.mount, {home});
      if (t.error) throw Error(t.error);
      const moved = await moveToTrash(p.full, t);
      await trashLog.add({id: newId(), original: p.full, dir: t.dir, name: moved.name, dev: moved.dev, ino: moved.ino, at: Date.now(), bytes: p.bytes, files: p.files, mount: p.mount});
      record(`Moved to trash: ${p.full}`);
      result = {mode, trash: t.dir, name: moved.name};
    } else {
      const before = await usedOn(p.mount);
      await rm(p.full, {recursive: true, force: false});
      const after = await usedOn(p.mount);
      const freed = before != null && after != null ? Math.max(0, before - after) : null;
      record(`Deleted: ${p.full}`);
      result = {mode, freed};
    }
    await forget(p.mount, p.parts);
    return result;
  }

  const trash = {
    list: async () => ({items: await trashLog.list(), days: trashDays}),
    restore: async id => { const e = await trashLog.restore(id); record(`Restored from trash: ${e.original}`); return {restored: e.original}; },
    // Deleting from the trash is a permanent delete, so it needs the password like any other (auto-empty does not).
    purge: async (id, password) => {
      await verifyPassword(password);
      const e = (await trashLog.list()).find(x => x.id === id);
      const before = e ? await usedOn(e.mount) : null;
      const [gone] = await trashLog.purge({id});
      const after = e ? await usedOn(e.mount) : null;
      record(`Emptied from trash: ${gone.original}`);
      return {freed: before != null && after != null ? Math.max(0, before - after) : null};
    },
  };
  // Items Homebase trashed are deleted for good after trashDays (checked hourly).
  if (trashDays > 0) setInterval(() => { trashLog.purge({days: trashDays}).then(g => { for (const e of g) record(`Trash auto-emptied: ${e.original}`); }, () => {}); }, 3600000).unref();

  /** Mounts worth scanning, and the last scan's summary for one (null when never scanned). */
  const targets = async () => (await mounts()).targets;
  const scanMeta = async mount => (await target(mount), await metaOf(mount));

  return {list, targets, scanMeta, start, cancel, tree, item, candidates, growth, prepareDelete, remove, trash, stopAll: () => { for (const j of jobs.values()) j.child.kill('SIGTERM'); }};
}
