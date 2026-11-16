// Details for one file or folder from a usage scan: what you need to judge whether it can go.
// Read-only. Paths reaching this module were taken from the cached scan tree, never straight from a request.
// Deliberately does not run `git`: a repository's own config (core.fsmonitor, clean filters) can execute
// commands, and any folder on disk may hold a hostile repository. Git facts are read from .git files instead.
import {execFile} from 'node:child_process';
import {access, constants, lstat, readFile, readdir, readlink} from 'node:fs/promises';
import {basename, dirname, extname, join} from 'node:path';
import {CATEGORIES, categorize} from './categories.mjs';

const SELF_UID = typeof process.getuid === 'function' ? process.getuid() : -1;

/** /etc/passwd or /etc/group → Map(id → name). */
export function parseIds(raw) {
  const out = new Map();
  for (const line of raw.split('\n')) { const f = line.split(':'); if (f.length > 2 && /^\d+$/.test(f[2])) out.set(Number(f[2]), f[0]); }
  return out;
}

/** "drwxr-x---" style mode string, with setuid/setgid/sticky. */
export function modeString(mode, kind) {
  const t = kind === 'dir' || kind === 'locked' ? 'd' : kind === 'link' ? 'l' : '-';
  const bits = 'rwxrwxrwx'.split('').map((c, i) => (mode & (1 << (8 - i)) ? c : '-'));
  if (mode & 0o4000) bits[2] = bits[2] === 'x' ? 's' : 'S';
  if (mode & 0o2000) bits[5] = bits[5] === 'x' ? 's' : 'S';
  if (mode & 0o1000) bits[8] = bits[8] === 'x' ? 't' : 'T';
  return t + bits.join('');
}

/** Atime is only trustworthy with strictatime; relatime updates it at most daily, noatime never. */
export function atimeQuality(opts = '') {
  const o = opts.split(',');
  return o.includes('noatime') ? 'none' : o.includes('strictatime') ? 'exact' : 'approximate';
}

/**
 * Processes with the path open (as a file under it, or as their working directory). Without root only the dashboard
 * user's own processes can be inspected; the others are counted as `hidden`.
 */
export async function openBy(target, {proc = '/proc'} = {}) {
  const under = p => p === target || p.startsWith(target.endsWith('/') ? target : target + '/');
  const pids = (await readdir(proc).catch(() => [])).filter(p => /^\d+$/.test(p));
  const items = [];
  let hidden = 0;
  await Promise.all(pids.map(async pid => {
    let fds;
    try { fds = await readdir(join(proc, pid, 'fd')); } catch (e) { if (e.code === 'EACCES') hidden++; return; }
    let files = 0, deleted = 0;
    for (const fd of fds) {
      const link = await readlink(join(proc, pid, 'fd', fd)).catch(() => null);
      if (!link || !link.startsWith('/')) continue;
      const gone = link.endsWith(' (deleted)'), p = gone ? link.slice(0, -10) : link;
      if (under(p)) { files++; if (gone) deleted++; }
    }
    const cwd = await readlink(join(proc, pid, 'cwd')).catch(() => null);
    const inside = !!cwd && under(cwd);
    if (!files && !inside) return;
    let name = (await readFile(join(proc, pid, 'comm'), 'utf8').catch(() => '?')).trim();
    // Runtimes all look alike by comm ("MainThread", "node"): name them by the script they run.
    if (/^(MainThread|node|python3?|bun|deno|java|ruby|perl)$/.test(name)) {
      const argv = (await readFile(join(proc, pid, 'cmdline'), 'utf8').catch(() => '')).split('\0').filter(Boolean);
      const script = argv.slice(1).find(a => !a.startsWith('-'));
      if (argv.length) name = `${basename(argv[0])}${script ? ' ' + basename(script) : ''}`.slice(0, 48);
    }
    items.push({pid: Number(pid), name, files, deleted, cwd: inside});
  }));
  items.sort((a, b) => b.files - a.files || a.pid - b.pid);
  return {items: items.slice(0, 20), more: Math.max(0, items.length - 20), hidden};
}

/** dpkg-query -S output → packages that own exactly `target` (directories are often shared by many). */
export function parseDpkgOwners(raw, target) {
  const out = new Set();
  for (const line of raw.split('\n')) {
    const i = line.lastIndexOf(': ');
    if (i < 0 || line.slice(i + 2) !== target || line.startsWith('diversion by')) continue;
    for (const p of line.slice(0, i).split(',')) out.add(p.trim());
  }
  return [...out].sort();
}

const dpkgCache = new Map();
export async function packageOwners(target) {
  if (!target.startsWith('/usr') && !target.startsWith('/etc') && !target.startsWith('/opt') && !target.startsWith('/var') && !target.startsWith('/boot') && !/^\/(s?bin|lib\w*)(\/|$)/.test(target)) return [];
  if (dpkgCache.has(target)) return dpkgCache.get(target);
  const owners = await new Promise(resolve => execFile('dpkg-query', ['-S', '--', target], {timeout: 5000, maxBuffer: 4 * 1024 * 1024},
    (err, stdout) => resolve(err && !stdout ? null : parseDpkgOwners(stdout, target))));
  if (owners) { dpkgCache.set(target, owners); if (dpkgCache.size > 500) dpkgCache.delete(dpkgCache.keys().next().value); }
  return owners ?? [];
}

/** The git repository containing `target` (searching up to `stop`), read from files only. */
export async function gitInfo(target, stop, isDir) {
  let dir = isDir ? target : dirname(target);
  for (let i = 0; i < 40; i++) {
    const dotgit = join(dir, '.git');
    const st = await lstat(dotgit).catch(() => null);
    if (st) {
      let gitdir = dotgit;
      if (st.isFile()) { const m = /^gitdir: (.+)$/m.exec(await readFile(dotgit, 'utf8').catch(() => '')); if (!m) return null; gitdir = m[1].startsWith('/') ? m[1] : join(dir, m[1]); }
      const head = (await readFile(join(gitdir, 'HEAD'), 'utf8').catch(() => '')).trim();
      const times = await Promise.all(['logs/HEAD', 'index', 'FETCH_HEAD'].map(f => lstat(join(gitdir, f)).then(s => s.mtimeMs, () => 0)));
      return {root: dir, branch: head.startsWith('ref: refs/heads/') ? head.slice(16) : head ? head.slice(0, 12) + ' (detached)' : null, lastActivity: Math.max(...times) || null, worktree: st.isFile()};
    }
    if (dir === stop || dir === '/' || !dir.startsWith(stop)) return null;
    dir = dirname(dir);
  }
  return null;
}

/** Largest file extensions under a cached node, by bytes. Folded small files are reported as one group. */
export function extensions(node, limit = 5, budget = 200000) {
  const by = new Map(), stack = [node];
  let small = 0, seen = 0;
  while (stack.length && seen++ < budget) {
    const n = stack.pop();
    if (n.ch) { stack.push(...n.ch); continue; }
    if (n.k === 'files') { small += n.d; continue; }
    if (n.k !== 'file' || !n.d) continue;
    const ext = extname(n.n).toLowerCase() || '(none)';
    const e = by.get(ext) || {ext, bytes: 0, files: 0};
    e.bytes += n.d; e.files++; by.set(ext, e);
  }
  const top = [...by.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
  return {top, small, complete: !stack.length};
}

/** Whether the dashboard user may remove `target`: write+search on the parent, and the sticky-bit rule. */
export async function deletable(target, st, isMountRoot) {
  if (isMountRoot) return {ok: false, reason: 'This is the root of a filesystem'};
  const parent = dirname(target);
  try { await access(parent, constants.W_OK | constants.X_OK); } catch { return {ok: false, reason: `No write permission on ${parent}`}; }
  const pst = await lstat(parent).catch(() => null);
  if (pst && pst.mode & 0o1000 && st.uid !== SELF_UID && pst.uid !== SELF_UID) return {ok: false, reason: `${parent} is sticky and the item belongs to another user`};
  return {ok: true};
}

let idCache = {at: 0, users: new Map(), groups: new Map()};
async function names() {
  if (Date.now() - idCache.at < 300000) return idCache;
  const [p, g] = await Promise.all([readFile('/etc/passwd', 'utf8').catch(() => ''), readFile('/etc/group', 'utf8').catch(() => '')]);
  idCache = {at: Date.now(), users: parseIds(p), groups: parseIds(g)};
  return idCache;
}

/**
 * Everything the detail panel shows for one scanned node.
 * @param mount  filesystem root ({mount, fstype, opts})   @param full  absolute path   @param node  cached tree node
 */
export async function describe({mount, full, node, swaps, fsUsed, proc}) {
  const category = categorize(full, swaps);
  const isDir = node.k === 'dir' || node.k === 'locked' || node.k === 'mount';
  const base = {path: full, name: basename(full) || full, kind: node.k, size: node.d, apparent: node.s, files: node.f, newest: node.m || null, oldest: node.o ?? (node.k === 'file' ? node.m : null),
    partial: !!node.p, error: node.e || null, hardlink: !!node.h, growth: node.g ?? null, isNew: !!node.nw, shareOfUsed: fsUsed ? node.d / fsUsed : null,
    category: category ? {id: category, ...CATEGORIES[category]} : null, fstype: mount.fstype};
  const st = await lstat(full).catch(e => e);
  if (st instanceof Error) return {...base, gone: st.code === 'ENOENT', statError: st.code === 'ENOENT' ? null : st.code};
  const {users, groups} = await names();
  const [open, owners, git, canDelete] = await Promise.all([
    openBy(full, {proc}), packageOwners(full), gitInfo(full, mount.mount, isDir), node.k === 'mount' ? {ok: false, reason: 'Another filesystem is mounted here'} : deletable(full, st, full === mount.mount),
  ]);
  const cow = ['btrfs', 'zfs', 'bcachefs'].includes(mount.fstype) || (mount.fstype === 'xfs' && st.isFile());
  return {...base,
    changed: st.isDirectory() !== isDir,
    stat: {mtime: st.mtimeMs, ctime: st.ctimeMs, atime: st.atimeMs, birthtime: st.birthtimeMs > 0 ? st.birthtimeMs : null, atimeQuality: atimeQuality(mount.opts),
      uid: st.uid, user: users.get(st.uid) ?? String(st.uid), gid: st.gid, group: groups.get(st.gid) ?? String(st.gid), mode: modeString(st.mode, node.k), nlink: st.nlink, mine: st.uid === SELF_UID},
    reclaim: node.k === 'mount' ? undefined : {bytes: node.h ? 0 : node.d, uncertain: cow || !!node.h || (st.nlink > 1 && !st.isDirectory()) || open.items.some(i => i.files > 0),
      notes: [node.h && 'Hardlink: the data stays until every name for it is deleted', !st.isDirectory() && st.nlink > 1 && !node.h && `This file has ${st.nlink} names (hardlinks); only deleting all of them frees its data`,
        cow && 'Copy-on-write filesystem: snapshots and shared copies can keep the data after deletion', open.items.some(i => i.files) && 'Open files keep their space until the process closes them'].filter(Boolean)},
    openBy: open, packages: owners, git, canDelete,
    extensions: isDir ? extensions(node) : null};
}
