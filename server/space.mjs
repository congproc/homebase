// Free space over time, per filesystem: hourly statfs samples (one point kept per day), a fill forecast from them,
// low-space levels for the dashboard, and the deleted-but-still-open files that hold space nobody can see.
// Samples are taken in the background whether or not a dashboard is open; statfs costs nothing.
import {mkdir, readFile, readdir, readlink, rename, stat, statfs, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DAY = 86400000, MB = 1024 ** 2;
const KEEP_DAYS = 120, FIT_DAYS = 30;
export const LEVELS = {warnPercent: 85, criticalPercent: 95, warnDays: 14, criticalDays: 3};

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Adds a sample, keeping one point per local day (the latest) and KEEP_DAYS of history. */
export function addSample(points = [], sample) {
  const key = dayKey(sample.at);
  const rest = points.filter(p => dayKey(p.at) !== key && sample.at - p.at < KEEP_DAYS * DAY);
  return [...rest, sample].sort((a, b) => a.at - b.at);
}

/**
 * Bytes per day from a least-squares line through the last FIT_DAYS of daily points. Needs at least 4 points over
 * 3+ days, otherwise null. With `available`, also the days until full when the trend is up (≥ 10 MB/day).
 */
export function forecast(points, {available, now = Date.now()} = {}) {
  const recent = points.filter(p => now - p.at <= FIT_DAYS * DAY);
  if (recent.length < 4 || recent.at(-1).at - recent[0].at < 3 * DAY) return null;
  const xs = recent.map(p => (p.at - recent[0].at) / DAY), ys = recent.map(p => p.used);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const perDay = den ? num / den : 0;
  const daysLeft = available != null && perDay >= 10 * MB ? available / perDay : null;
  return {perDay, daysLeft, days: Math.round(xs.at(-1)), points: recent.length};
}

/** ok / warn / critical, from how full the filesystem is and how soon it fills up. */
export function levelOf({percent, daysLeft}) {
  if (percent >= LEVELS.criticalPercent || (daysLeft != null && daysLeft <= LEVELS.criticalDays)) return 'critical';
  if (percent >= LEVELS.warnPercent || (daysLeft != null && daysLeft <= LEVELS.warnDays)) return 'warn';
  return 'ok';
}

/**
 * Files that were deleted while a process still had them open: their space stays used until the process closes them
 * (a classic "df says full, du doesn't" cause, e.g. a rotated log a daemon still writes to). Only the dashboard
 * user's own processes can be inspected without root; others are counted in `hidden`. `devs` limits the result to
 * files on those filesystems (memfd and tmpfs files are not disk space).
 */
export async function deletedOpen({proc = '/proc', devs} = {}) {
  const items = [];
  let hidden = 0;
  for (const pid of (await readdir(proc).catch(() => [])).filter(p => /^\d+$/.test(p))) {
    let fds;
    try { fds = await readdir(path.join(proc, pid, 'fd')); } catch (e) { if (e.code === 'EACCES') hidden++; continue; }
    for (const fd of fds) {
      const link = await readlink(path.join(proc, pid, 'fd', fd)).catch(() => null);
      if (!link?.endsWith(' (deleted)') || !link.startsWith('/') || link.startsWith('/memfd:')) continue;
      const st = await stat(path.join(proc, pid, 'fd', fd)).catch(() => null);
      if (!st?.isFile() || (devs && !devs.has(st.dev))) continue;
      const bytes = st.blocks * 512;
      if (!bytes) continue;
      const comm = (await readFile(path.join(proc, pid, 'comm'), 'utf8').catch(() => '?')).trim();
      // The same file open on several descriptors is one file.
      if (!items.some(i => i.pid === Number(pid) && i.ino === st.ino && i.dev === st.dev))
        items.push({pid: Number(pid), name: comm, path: link.slice(0, -10), bytes, dev: st.dev, ino: st.ino});
    }
  }
  // Several processes can hold the same file (a forked daemon): its space counts once.
  const unique = new Map();
  for (const i of items) unique.set(`${i.dev}:${i.ino}`, Math.max(unique.get(`${i.dev}:${i.ino}`) || 0, i.bytes));
  items.sort((a, b) => b.bytes - a.bytes);
  return {items: items.slice(0, 30).map(({dev: _dev, ino: _ino, ...i}) => i), total: [...unique.values()].reduce((a, b) => a + b, 0), hidden};
}

export function createSpace({targets, file = path.join(os.homedir(), '.local/state/homebase/storage/space-history.json'), every = 3600000, proc = '/proc'} = {}) {
  let history = null, current = new Map();
  const load = async () => history ??= await readFile(file, 'utf8').then(JSON.parse, () => ({}));
  const save = async () => {
    await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
    await writeFile(file + '.tmp', JSON.stringify(history), {mode: 0o600});
    await rename(file + '.tmp', file);
  };

  async function sample(now = Date.now()) {
    await load();
    const mounts = await targets();
    for (const m of mounts) {
      const fs = await statfs(m.mount).catch(() => null);
      if (!fs) continue;
      const total = fs.blocks * fs.bsize, used = (fs.blocks - fs.bfree) * fs.bsize, available = fs.bavail * fs.bsize;
      // Percent as df shows it: used / (used + what non-root users can still write).
      const percent = used + available ? Math.round(used / (used + available) * 100) : 0;
      history[m.mount] = addSample(history[m.mount], {at: now, used, total});
      const fc = forecast(history[m.mount], {available, now});
      current.set(m.mount, {mount: m.mount, used, total, available, percent, forecast: fc, level: levelOf({percent, daysLeft: fc?.daysLeft ?? null}), at: now});
    }
    for (const k of current.keys()) if (!mounts.some(m => m.mount === k)) current.delete(k);
    await save().catch(() => {});
    return [...current.values()];
  }

  let timer = null;
  return {
    sample,
    /** Latest levels and forecasts (cheap: no I/O). */
    status: () => [...current.values()],
    start() { if (!timer) { sample().catch(() => {}); timer = setInterval(() => sample().catch(() => {}), every); timer.unref(); } },
    async history(mount) { await load(); return history[mount] || []; },
    async deletedOpen(mount) {
      const st = await stat(mount).catch(() => null);
      return deletedOpen({proc, devs: st ? new Set([st.dev]) : undefined});
    },
  };
}
