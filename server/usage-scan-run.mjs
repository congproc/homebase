// Scanner process entry: `node usage-scan-run.mjs <root> <cache.json.gz> <mountpoints.json>`, progress over IPC.
// Started by usage.mjs at idle CPU and I/O priority. Besides the tree cache it writes a small summary next to it
// (<cache>.meta.json: scan facts, cleanup candidates, growth hotspots), so the dashboard can list filesystems and
// suggest cleanups without ever loading a whole tree; only browsing the map does that.
import {readFile, rename, statfs, writeFile} from 'node:fs/promises';
import {scanTree, annotateGrowth, writeCache, readCache} from './usage-scan.mjs';
import {findCandidates, growthHotspots} from './candidates.mjs';
import {parseSwaps} from './categories.mjs';

export const summaryPath = cache => cache.replace(/\.json\.gz$/, '') + '.meta.json';

/** Summary sidecar: written atomically, small (a few KB). */
export async function writeSummary(cache, summary) {
  const file = summaryPath(cache);
  await writeFile(file + '.tmp', JSON.stringify(summary), {mode: 0o600});
  await rename(file + '.tmp', file);
}

/** What the server needs without the tree: meta, candidates and hotspots, computed from the tree once. */
export function summarize(meta, tree, root, swaps) {
  return {version: 1, meta, candidates: findCandidates(tree, root, {swaps}), hotspots: meta.previous && tree.g != null ? growthHotspots(tree, root) : null};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [root, out, mountsJson] = process.argv.slice(2);
  const started = Date.now();
  const send = msg => { if (process.send) process.send(msg); };
  try {
    const {tree, stats} = await scanTree(root, {mountpoints: new Set(JSON.parse(mountsJson || '[]')), onProgress: p => send({type: 'progress', ...p}), deadline: started + 60 * 60 * 1000});
    send({type: 'progress', ...stats, phase: 'saving'});
    // The previous scan (the cache this one replaces) gives growth per folder. Loaded only now, after the walk, and
    // dropped right after, so the two trees are never both alive during the scan itself.
    let previous = await readCache(out);
    const prevMeta = previous?.meta?.root === root ? {scannedAt: previous.meta.scannedAt, bytes: previous.tree?.d ?? previous.meta.bytes} : null;
    if (prevMeta && previous.tree) annotateGrowth(tree, previous.tree);
    previous = null;
    // What the filesystem itself reports as used: the gap to the scanned total is space the map cannot see.
    const fs = await statfs(root).catch(() => null);
    const meta = {root, scannedAt: Date.now(), durationMs: Date.now() - started, files: stats.files, dirs: stats.dirs, bytes: tree.d, errors: stats.errors, vanished: stats.vanished,
      partial: stats.partial || !!tree.p, stoppedEarly: !!stats.partial, fsUsed: fs ? (fs.blocks - fs.bfree) * fs.bsize : null, previous: prevMeta};
    const swaps = parseSwaps(await readFile('/proc/swaps', 'utf8').catch(() => ''));
    const summary = summarize(meta, tree, root, swaps);
    await writeCache(out, {version: 1, meta, tree});
    await writeSummary(out, summary);
    send({type: 'done', meta});
    process.exit(0);
  } catch (e) {
    send({type: 'error', error: e.message});
    process.exit(1);
  }
}
