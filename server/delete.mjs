// Deleting from the disk usage view, carefully. Runs as the dashboard user, never as root.
//  - Every target is re-checked on the server right before acting: no symlinks on the way, not a mountpoint and
//    nothing mounted inside, not a protected category, not owned by a package, not open by your programs, not
//    Homebase itself or a folder containing it.
//  - Default is the freedesktop trash (the same trash the desktop uses), so it can be restored. Items Homebase
//    moved there are emptied for good after `trashDays`; the rest of the trash is left alone.
//  - A permanent delete uses fs.rm, which removes symlinks themselves and never follows them.
// A path can still be swapped between the last check and the rename/rm (no openat2-style confinement in Node);
// the checks narrow that window to milliseconds and the dashboard user can only touch what it already could.
import {access, constants, lstat, mkdir, open, opendir, readFile, realpath, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {CATEGORIES, categorize} from './categories.mjs';
import {deletable, openBy, packageOwners} from './usage-item.mjs';

const UID = typeof process.getuid === 'function' ? process.getuid() : -1;
export const BIG = {bytes: 1024 ** 3, files: 1000};

/** Paths that may not be deleted, nor any folder containing them. */
export function protectedPaths({home = os.homedir(), root, extra = []} = {}) {
  return [root, path.join(home, '.config/homebase'), path.join(home, '.local/state/homebase'), path.join(home, '.local/share/Trash'), ...extra].filter(Boolean);
}
const within = (p, base) => p === base || p.startsWith(base.endsWith('/') ? base : base + '/');

/**
 * Whether `full` may be deleted. Returns {blocked: [reasons], warnings: [..], st}. Pure checks first, then the
 * filesystem: lstat, realpath, permissions, package ownership, open files.
 */
export async function checkTarget({full, mountRoot, mountpoints = [], swaps = new Set(), protect = [], home = os.homedir(), proc = '/proc', dpkg = packageOwners}) {
  const blocked = [], warnings = [];
  if (!path.isAbsolute(full) || path.normalize(full) !== full || full === '/') return {blocked: ['Invalid path'], warnings};
  if (full === mountRoot) blocked.push('This is the root of a filesystem');
  if (full === home || within(home, full)) blocked.push('This is your home folder or contains it');
  const inside = mountpoints.find(m => m !== mountRoot && within(m, full));
  if (inside) blocked.push(inside === full ? 'Another filesystem is mounted here' : `Another filesystem is mounted inside it (${inside})`);
  const guarded = protect.find(p => within(full, p) || within(p, full));
  if (guarded) blocked.push(within(full, guarded) ? 'Homebase needs this to run' : `It contains ${guarded}, which Homebase needs`);
  const cat = categorize(full, swaps);
  if (cat && CATEGORIES[cat].verdict === 'keep') blocked.push(`${CATEGORIES[cat].label}: ${CATEGORIES[cat].hint}`);

  const st = await lstat(full).catch(e => e);
  if (st instanceof Error) return {blocked: [...blocked, st.code === 'ENOENT' ? 'It no longer exists' : `Cannot read it (${st.code})`], warnings};
  // Every component must be what it says: a symlinked parent could point the delete somewhere else.
  const real = await realpath(full).catch(() => null);
  if (real !== full) blocked.push('The path goes through a symbolic link');
  const perm = await deletable(full, st, full === mountRoot);
  if (!perm.ok) blocked.push(perm.reason);
  const owners = await dpkg(full);
  if (owners.length) blocked.push(`Installed by ${owners.length === 1 ? 'the package' : 'packages'} ${owners.slice(0, 3).join(', ')}${owners.length > 3 ? '…' : ''}. Remove it with apt instead.`);
  const open = await openBy(full, {proc});
  const holding = open.items.filter(i => i.files > 0);
  if (holding.length) blocked.push(`Open in ${holding.slice(0, 3).map(i => `${i.name} (PID ${i.pid})`).join(', ')}. Close ${holding.length === 1 ? 'it' : 'them'} first.`);
  const cwd = open.items.filter(i => i.cwd && !i.files);
  if (cwd.length) warnings.push(`${cwd.slice(0, 3).map(i => i.name).join(', ')} ${cwd.length === 1 ? 'is' : 'are'} working inside this folder.`);
  if (st.uid !== UID) warnings.push('It belongs to another user.');
  if (cat && CATEGORIES[cat].verdict === 'review') warnings.push(`${CATEGORIES[cat].label}: ${CATEGORIES[cat].hint}`);
  return {blocked, warnings, st};
}

/** The identity a delete must still match: same inode on the same device, same type, unchanged content time for files. */
export const fingerprint = st => ({dev: String(st.dev), ino: String(st.ino), dir: st.isDirectory(), mtime: st.isDirectory() ? null : st.mtimeMs});
export const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.dir === b.dir && a.mtime === b.mtime;

// ---------- trash (freedesktop.org Trash specification) ----------

/** Percent-encodes a path for a .trashinfo "Path=" line (RFC 2396 style, "/" kept). */
export const encodeTrashPath = p => p.split('/').map(s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
const stamp = d => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };

/** The home trash. */
export const homeTrash = home => path.join(home, '.local/share/Trash');
/** A single path component, as a trash entry name must be. */
export const plainName = n => typeof n === 'string' && n.length > 0 && n.length <= 255 && !n.includes('/') && !n.includes('\0') && n !== '.' && n !== '..';

/**
 * A folder Homebase may move things into and later delete from: a real directory owned by this account with no
 * symbolic link anywhere in its path. Created (0700) when `create` and missing. Returns false when missing.
 */
async function ownedDir(p, create = false) {
  let st = await lstat(p).catch(() => null);
  if (!st && create) { await mkdir(p, {mode: 0o700}).catch(() => {}); st = await lstat(p).catch(() => null); }
  if (!st) return false;
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== UID) throw Error(`${p} is not a trash folder Homebase can trust`);
  if ((await realpath(p).catch(() => null)) !== p) throw Error(`${p} goes through a symbolic link`);
  return true;
}

/** Whether `dir` is one of the trash folders Homebase itself uses: the home trash or `<mountpoint>/.Trash-<uid>`. */
export function isTrashRoot(dir, {home, mountpoints}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.normalize(dir) !== dir) return false;
  if (dir === homeTrash(home)) return true;
  return path.basename(dir) === `.Trash-${UID}` && mountpoints.includes(path.dirname(dir));
}

/**
 * Where `st` (on the filesystem mounted at mountRoot) can be trashed without copying: the home trash when it is on
 * the same filesystem (and ~/.local/share is a real folder, not a link elsewhere), else `<mount>/.Trash-<uid>`.
 * Returns {dir, topdir} or {error}.
 */
export async function trashFor(st, mountRoot, {home = os.homedir(), create = true} = {}) {
  const share = path.join(home, '.local/share');
  const shareSt = await lstat(share).catch(() => null);
  const shareReal = shareSt && !shareSt.isSymbolicLink() && (await realpath(share).catch(() => null)) === share;
  try {
    if (shareReal && shareSt.dev === st.dev) { await ownedDir(homeTrash(home)); return {dir: homeTrash(home), topdir: null}; }
    const dir = path.join(mountRoot, `.Trash-${UID}`);
    const exists = await ownedDir(dir);
    const noTrash = {error: `This filesystem has no trash Homebase can write to (${mountRoot})`};
    if (!exists && !create) return (await access(mountRoot, constants.W_OK).then(() => true, () => false)) ? {dir, topdir: mountRoot} : noTrash;
    if (!exists && !(await ownedDir(dir, true))) return noTrash;
    return {dir, topdir: mountRoot};
  } catch (e) { return {error: e.message}; }
}

/**
 * Moves `full` into the trash folder `dir`; returns {name, dev, ino} of what is now in the trash, so later steps can
 * insist on that exact item. The .trashinfo is created first, exclusively, claiming the name.
 */
export async function moveToTrash(full, {dir, topdir}, now = new Date()) {
  await ownedDir(dir, true);
  for (const sub of ['files', 'info']) if (!(await ownedDir(path.join(dir, sub), true))) throw Error(`Cannot create ${path.join(dir, sub)}`);
  const base = path.basename(full), ext = path.extname(base), stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? base : `${stem}.${i}${ext && ext !== base ? ext : ''}`;
    const info = path.join(dir, 'info', name + '.trashinfo');
    let fh;
    try { fh = await open(info, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try {
      if (await lstat(path.join(dir, 'files', name)).then(() => true, () => false)) { await fh.close(); await unlink(info); continue; }
      const shown = topdir ? path.relative(topdir, full) : full;
      await fh.writeFile(`[Trash Info]\nPath=${encodeTrashPath(shown)}\nDeletionDate=${stamp(now)}\n`);
      await fh.close(); fh = null;
      await rename(full, path.join(dir, 'files', name));
      const st = await lstat(path.join(dir, 'files', name));
      return {name, dev: String(st.dev), ino: String(st.ino)};
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await unlink(info).catch(() => {});
      throw e;
    }
  }
  throw Error('Too many items with this name in the trash');
}

/** Mountpoints from /proc/self/mountinfo (field 5, octal escapes decoded). */
export async function mountpointsFrom(file = '/proc/self/mountinfo') {
  const raw = await readFile(file, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map(l => l.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))).filter(Boolean);
}

/**
 * Items Homebase put in the trash, kept in ~/.local/state/homebase/trash.json, so restore and auto-empty only ever
 * touch those (the rest of the desktop trash is the user's business). The log is not trusted blindly: an entry is
 * only acted on when its folder is a trash folder Homebase uses, its name is a single component, and the item there
 * is still the same file (device and inode) that was moved. Anything else is dropped from the log, untouched.
 */
export function createTrashLog({file = path.join(os.homedir(), '.local/state/homebase/trash.json'), home = os.homedir(), mountpoints = () => mountpointsFrom()} = {}) {
  const read = async () => { try { const v = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
  const write = async items => { await mkdir(path.dirname(file), {recursive: true, mode: 0o700}); await writeFile(file + '.tmp', JSON.stringify(items), {mode: 0o600}); await rename(file + '.tmp', file); };
  let queue = Promise.resolve();
  // Serialize read-modify-write so two requests cannot drop each other's entries.
  // A failed step must not poison the queue: later calls chain on a promise that always settles.
  const update = fn => {
    const run = queue.then(async () => { const items = await read(); const out = await fn(items); await write(out.items); if (out.error) throw out.error; return out.result; });
    queue = run.catch(() => {});
    return run;
  };
  async function valid(e) {
    try {
      if (!e || typeof e !== 'object' || !plainName(e.name) || !isTrashRoot(e.dir, {home, mountpoints: await mountpoints()})) return false;
      for (const d of [e.dir, path.join(e.dir, 'files'), path.join(e.dir, 'info')]) if (!(await ownedDir(d))) return false;
      const st = await lstat(path.join(e.dir, 'files', e.name)).catch(() => null);
      return !!st && String(st.dev) === e.dev && String(st.ino) === e.ino;
    } catch { return false; }
  }
  const keepValid = async items => { const ok = []; for (const e of items) if (await valid(e)) ok.push(e); return ok; };

  return {
    add: entry => update(items => ({items: [...items, entry], result: entry})),
    list: () => update(async items => { const ok = await keepValid(items); return {items: ok, result: ok}; }),
    restore: id => update(async items => {
      const ok = await keepValid(items);
      const e = ok.find(x => x.id === id);
      if (!e) return {items: ok, error: Error('Not in the trash')};
      const parent = path.dirname(e.original);
      const pst = await lstat(parent).catch(() => null);
      // The whole way back must be real folders: a symlinked ancestor would restore into another tree.
      if (!pst?.isDirectory() || (await realpath(parent).catch(() => null)) !== parent) return {items: ok, error: Error(`The folder it came from is gone or now a link (${parent})`)};
      if (await lstat(e.original).then(() => true, () => false)) return {items: ok, error: Error(`Something already exists at ${e.original}`)};
      // No rename-without-replace in Node: the check above leaves a race of milliseconds against a new file there.
      await rename(path.join(e.dir, 'files', e.name), e.original);
      await unlink(path.join(e.dir, 'info', e.name + '.trashinfo')).catch(() => {});
      return {items: ok.filter(x => x.id !== id), result: e};
    }),
    /** Deletes for good: one id, or every entry older than `days` (0 = never). Only validated entries are touched. */
    purge: ({id, days, now = Date.now()}) => update(async items => {
      const ok = await keepValid(items);
      const doomed = ok.filter(e => id ? e.id === id : days > 0 && now - e.at > days * 86400000);
      if (id && !doomed.length) return {items: ok, error: Error('Not in the trash')};
      for (const e of doomed) {
        await rm(path.join(e.dir, 'files', e.name), {recursive: true, force: true});
        await unlink(path.join(e.dir, 'info', e.name + '.trashinfo')).catch(() => {});
      }
      return {items: ok.filter(e => !doomed.includes(e)), result: doomed};
    }),
  };
}

/**
 * Fresh, bounded check of whether a folder is "big" (BIG files or bytes): walks without following links and stops
 * as soon as either limit is reached. Unreadable parts, other filesystems or very many entries count as big, so the
 * answer errs towards asking for the password.
 */
export async function exceedsLimits(full, {bytes = BIG.bytes, files = BIG.files, visits = 20000} = {}) {
  const top = await lstat(full);
  if (!top.isDirectory()) return top.blocks * 512 >= bytes;
  let n = 0, b = 0, seen = 0;
  const stack = [full];
  while (stack.length) {
    const d = stack.pop();
    let dir;
    try { dir = await opendir(d); } catch { return true; }
    for await (const ent of dir) {
      if (++seen > visits) return true;
      const st = await lstat(path.join(d, ent.name)).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) { if (st.dev !== top.dev) return true; stack.push(path.join(d, ent.name)); continue; }
      n++; b += st.blocks * 512;
      if (n >= files || b >= bytes) return true;
    }
  }
  return false;
}

export const newId = () => randomBytes(12).toString('hex');
