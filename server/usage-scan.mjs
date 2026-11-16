// Directory-usage scanner. Runs in its own low-priority process (see usage.mjs) so a scan of millions of files never
// blocks the dashboard and its memory is returned when it ends. Read-only: it only opens directories and lstat()s.
//
// Rules: stay on the starting filesystem (st_dev) and stop at every other mountpoint, including same-device bind
// mounts; never follow symlinks; count a hardlinked inode once; size by allocated blocks (st_blocks * 512) and keep
// apparent size beside it; record unreadable or vanished entries instead of reporting them as zero.
import {lstat, mkdir, readFile, rename} from 'node:fs/promises';
import {opendirSync, lstatSync, createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip, createGzip} from 'node:zlib';
import {dirname, join} from 'node:path';

/** Files smaller than this are folded into one "(n smaller files)" entry per directory. */
export const SMALL_FILE = 1024 * 1024;
// All scan I/O is synchronous in this dedicated child: at most one filesystem operation is in flight.
const CONCURRENCY = 4, STAT_BATCH = 32;

/**
 * Node flags for the scanner process. A small young generation (semi-space) is most of the saving; the old-space
 * limit makes the GC work harder instead of growing, and scales with the expected file count so a large filesystem
 * is not cut short. Measured on 1.44 M files (repeat scan, which also loads the previous tree): 444 MiB peak RSS
 * without flags, 289 MiB with these.
 */
export function scannerNodeFlags(expectedFiles = 0) {
  const heapMb = Math.min(4096, Math.max(512, Math.ceil(expectedFiles / 1e6 * 320 / 64) * 64));
  return ['--max-semi-space-size=4', `--max-old-space-size=${heapMb}`];
}

/**
 * Tree node, kept compact because a home server easily has millions of inodes:
 *   n name · k kind (dir | file | link | other | files | mount | locked) · d allocated bytes · s apparent bytes
 *   f files below · m newest mtime below (ms) · ch children · e error code · p partial subtree
 *   h hardlink (data counted at another name) · x number of small files folded into a "files" node
 *   o oldest file mtime below (ms; a file's own is its m)
 *   g growth in allocated bytes since the previous scan (absent when that scan has no such entry) · nw new since then
 */
export async function scanTree(root, {mountpoints = new Set(), onProgress, deadline = Infinity, smallFile = SMALL_FILE} = {}) {
  const top = await lstat(root);
  if (!top.isDirectory()) throw Error(`${root} is not a directory`);
  const dev = top.dev, seen = new Set();
  const stats = {files: 0, dirs: 0, bytes: 0, errors: 0, vanished: 0, path: root};
  const tree = {n: root, k: 'dir', d: Number(top.blocks) * 512, s: Number(top.size), f: 0, m: Math.trunc(top.mtimeMs), ch: []};
  const queue = [[tree, root]];
  let partial = false;
  const waiting = [];
  const notify = () => { while (waiting.length) waiting.pop()(); };

  async function readDir(node, path) {
    let names;
    try {
      names = [];
      const dir = opendirSync(path, {bufferSize: 256});
      try {
        // Avoid an async iterator/promise for each name. The directory's buffered reads are synchronous,
        // like metadata reads below, so they never flood the shared libuv pool.
        let ent;
        while ((ent = dir.readSync()) !== null) names.push(ent.name);
      } finally { dir.closeSync(); }
    } catch (e) {
      // Unreadable (EACCES/EPERM) or gone since its parent was read.
      node.k = 'locked'; node.e = e.code || 'EIO'; stats.errors++; return;
    }
    stats.dirs++; stats.path = path;
    const small = {n: '', k: 'files', d: 0, s: 0, f: 0, m: 0, o: 0, x: 0};
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      // A huge directory can outlast the deadline on its own: stop between batches and mark it partial.
      if (Date.now() > deadline) { node.p = 1; node.e = 'TIMEOUT'; partial = true; break; }
      const end = Math.min(i + STAT_BATCH, names.length);
      for (let j = i; j < end; j++) {
        const name = names[j], full = join(path, name);
        let st, err;
        try {
          st = lstatSync(full);
          // Number inode values can lose precision. Only multiply linked entries need exact identity;
          // use the same snapshot for all their fields, including nlink and allocated size.
          if (!st.isDirectory() && st.nlink > 1) st = lstatSync(full, {bigint: true});
        } catch (e) { err = e; st = null; }
        if (!st) {
          // Gone between readdir and lstat: normal on a live system (temp files), so counted but not "incomplete".
          if (err?.code === 'ENOENT') { stats.vanished++; continue; }
          node.ch.push({n: name, k: 'other', d: 0, s: 0, f: 0, m: 0, e: err?.code || 'EIO'}); stats.errors++;
          continue;
        }
        // Bigint Stats used integer milliseconds; retain that representation with number Stats.
        const mtime = Math.trunc(Number(st.mtimeMs));
        if (st.isDirectory()) {
          if (Number(st.dev) !== dev || mountpoints.has(full)) { node.ch.push({n: name, k: 'mount', d: 0, s: 0, f: 0, m: mtime}); continue; }
          const child = {n: name, k: 'dir', d: Number(st.blocks) * 512, s: Number(st.size), f: 0, m: mtime, ch: []};
          node.ch.push(child); queue.push([child, full]); notify(); continue;
        }
        stats.files++;
        let d = Number(st.blocks) * 512;
        const s = Number(st.size), linked = st.nlink > 1;
        if (linked) { const key = `${st.dev}:${st.ino}`; if (seen.has(key)) d = 0; else seen.add(key); }
        stats.bytes += d;
        const k = st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other';
        if (k === 'file' && d >= smallFile) {
          const child = {n: name, k, d, s, f: 1, m: mtime};
          if (linked && !d) child.h = 1;
          node.ch.push(child);
        }
        else if (linked && !d && s >= smallFile) node.ch.push({n: name, k, d: 0, s, f: 1, m: mtime, h: 1});
        else { small.d += d; small.s += s; small.f++; small.x++; if (mtime > small.m) small.m = mtime; if (!small.o || mtime < small.o) small.o = mtime; }
      }
    }
    if (small.x) node.ch.push(small);
  }

  // Bounded worker pool over a shared queue: at most CONCURRENCY directories are open at once.
  let last = 0, active = 0, completed = 0;
  const workers = Array.from({length: CONCURRENCY}, async () => {
    for (;;) {
      if (Date.now() > deadline) { partial = true; return; }
      const job = queue.pop();
      if (!job) {
        // Others may still be reading directories that will enqueue more work.
        if (active === 0) return;
        await new Promise(resolve => waiting.push(resolve)); continue;
      }
      active++;
      try { await readDir(...job); } finally { active--; notify(); }
      // Give IPC and other event-loop work a turn without a timer or one yield per inode.
      if (++completed % 32 === 0) await new Promise(setImmediate);
      if (onProgress && Date.now() - last > 500) { last = Date.now(); onProgress({...stats}); }
    }
  });
  await Promise.all(workers);
  if (partial) for (const [node] of queue) { node.p = 1; node.k = 'locked'; node.e = 'TIMEOUT'; }
  aggregate(tree);
  return {tree, stats: {...stats, partial}};
}

/** Post-order totals: every directory's d/s/f/m covers its whole subtree. Iterative, so deep trees cannot overflow. */
export function aggregate(root) {
  const order = [], stack = [root];
  while (stack.length) { const n = stack.pop(); order.push(n); for (const c of n.ch || []) if (c.ch) stack.push(c); }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    let d = n.d, s = n.s, f = 0, m = 0, o = 0, p = n.p || (n.e ? 1 : 0);
    for (const c of n.ch) {
      d += c.d; s += c.s; f += c.f; if (c.m > m) m = c.m; if (c.p || c.e) p = 1;
      const co = c.ch || c.k === 'files' ? c.o : c.f ? c.m : 0;
      if (co && (!o || co < o)) o = co;
    }
    n.d = d; n.s = s; n.f = f; n.m = m || n.m;
    if (o) n.o = o;
    if (p) n.p = 1;
    n.ch.sort((a, b) => b.d - a.d || b.s - a.s);
    if (!n.ch.length) delete n.ch;
  }
  return root;
}

/**
 * Marks each node with its growth since `prev` (the previous scan of the same root): g = d - previous d, matched by
 * name level by level. Entries that did not exist then are marked new (g = d). Iterative, like aggregate().
 */
export function annotateGrowth(tree, prev) {
  if (!prev) return tree;
  const stack = [[tree, prev]];
  while (stack.length) {
    const [n, p] = stack.pop();
    n.g = n.d - p.d;
    if (!n.ch) continue;
    const before = new Map((p.ch || []).map(c => [c.k === 'files' ? '\0files' : c.n, c]));
    for (const c of n.ch) {
      const q = before.get(c.k === 'files' ? '\0files' : c.n);
      if (q) stack.push([c, q]);
      else if (c.d) { c.g = c.d; c.nw = 1; }
    }
  }
  return tree;
}

/** Serialize incrementally, retaining JSON.stringify's property order and escaping without a whole-tree string.
 * Explicit frames also let the cache writer handle the same deep trees as aggregate(). */
function* jsonChunks(value) {
  const stack = [], ancestors = new Set();
  let chunk = '';
  let key = '', parentArray = false;
  const prepare = (v, k) => v && typeof v.toJSON === 'function' ? v.toJSON(k) : v;
  value = prepare(value, key);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new TypeError('Cache payload is not JSON');
  for (;;) {
    if (value && typeof value === 'object') {
      if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
      const array = Array.isArray(value), keys = array ? null : Object.keys(value);
      // Most retained nodes are leaves. Serialize their scalar fields in native code in one call.
      if (!array && keys.every(k => value[k] === null || typeof value[k] !== 'object')) chunk += JSON.stringify(value);
      else {
        ancestors.add(value);
        stack.push({value, keys, index: 0, first: true, array});
        chunk += array ? '[' : '{';
      }
    } else {
      chunk += JSON.stringify(value) ?? (parentArray ? 'null' : '');
    }
    let next = false;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index === (frame.array ? frame.value.length : frame.keys.length)) {
        chunk += frame.array ? ']' : '}';
        ancestors.delete(frame.value);
        stack.pop();
        continue;
      }
      key = frame.array ? String(frame.index++) : frame.keys[frame.index++];
      value = prepare(frame.value[key], key);
      // Undefined, functions and symbols are omitted from objects and null in arrays.
      if (!frame.array && (value === undefined || typeof value === 'function' || typeof value === 'symbol')) continue;
      if (!frame.first) chunk += ',';
      frame.first = false;
      if (!frame.array) chunk += JSON.stringify(key) + ':';
      parentArray = frame.array;
      next = true;
      break;
    }
    if (chunk.length >= 64 * 1024) { yield chunk; chunk = ''; }
    if (!next) break;
  }
  if (chunk) yield chunk;
}

/** Writes a scan cache atomically: gzipped JSON of {version, meta, tree}, with bounded stream buffers. */
export async function writeCache(out, payload) {
  await mkdir(dirname(out), {recursive: true, mode: 0o700});
  await pipeline(Readable.from(jsonChunks(payload), {objectMode: false}), createGzip(), createWriteStream(out + '.tmp', {mode: 0o600}));
  await rename(out + '.tmp', out);
}

/** Reads a scan cache, or null. */
export const readCache = out => readFile(out).then(async b => {
  // Decode in bounded chunks rather than keeping a full decompressed Buffer beside the JSON string and trees.
  let json = '';
  const unzip = createGunzip();
  unzip.setEncoding('utf8');
  await pipeline(Readable.from([b]), unzip, async source => {
    for await (const chunk of source) json += chunk;
  });
  return JSON.parse(json);
}, () => null);
