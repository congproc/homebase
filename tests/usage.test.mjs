import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync, chmodSync, truncateSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {scanTree, aggregate} from '../server/usage-scan.mjs';
import {parseMountinfo, scanTargets, segments, view, find, createUsage} from '../server/usage.mjs';

const MiB = 1024 * 1024;
const big = n => Buffer.alloc(n, 1);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hb-usage-'));
  mkdirSync(join(root, 'a/b'), {recursive: true});
  writeFileSync(join(root, 'a/large.bin'), big(3 * MiB));
  writeFileSync(join(root, 'a/b/deep.bin'), big(2 * MiB));
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `a/small${i}.txt`), 'x'.repeat(1000));
  writeFileSync(join(root, 'once.bin'), big(2 * MiB));
  linkSync(join(root, 'once.bin'), join(root, 'a/twice.bin'));
  writeFileSync(join(root, 'sparse.img'), '');
  truncateSync(join(root, 'sparse.img'), 512 * MiB);
  symlinkSync(root, join(root, 'loop'));
  mkdirSync(join(root, 'mnt'));
  writeFileSync(join(root, 'mnt/hidden.bin'), big(4 * MiB));
  return root;
}

test('scanTree: hardlinks once, sparse by allocation, no symlink follow, mount boundaries, small files folded', async () => {
  const root = fixture();
  try {
    const {tree, stats} = await scanTree(root, {mountpoints: new Set([join(root, 'mnt')])});
    const names = tree.ch.map(c => c.n);
    assert.ok(!names.includes('sparse.img'), 'a sparse file with no allocated data is folded, not a large tile');
    assert.equal(find(tree, ['mnt']).k, 'mount');
    assert.equal(find(tree, ['mnt']).d, 0, 'a mountpoint below the root is not entered');
    const a = find(tree, ['a']);
    const linked = [find(tree, ['once.bin']), find(a, ['twice.bin'])];
    assert.equal(linked.filter(n => n.d > 0).length, 1, 'hardlinked data counted at one name');
    assert.ok(linked.some(n => n.h === 1));
    const small = a.ch.find(c => c.k === 'files');
    assert.equal(small.x, 5);
    // 3 + 2 + 2 MiB of file data, plus directory blocks and the small files.
    assert.ok(tree.d >= 7 * MiB && tree.d < 8 * MiB, `total ${tree.d}`);
    assert.ok(tree.s > 512 * MiB, 'apparent size still includes the sparse file');
    assert.ok(a.d > find(a, ['b']).d && a.ch[0].d >= a.ch[1].d, 'children sorted by allocated size');
    assert.equal(stats.partial, false);
    assert.ok(tree.m >= find(a, ['b', 'deep.bin']).m, 'newest mtime propagates up');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('scanTree: unreadable directories are recorded, not zero', {skip: process.getuid?.() === 0}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hb-usage-'));
  try {
    mkdirSync(join(root, 'secret'));
    writeFileSync(join(root, 'secret/x'), big(2 * MiB));
    chmodSync(join(root, 'secret'), 0o000);
    const {tree, stats} = await scanTree(root);
    const s = find(tree, ['secret']);
    assert.equal(s.k, 'locked');
    assert.equal(s.e, 'EACCES');
    assert.equal(tree.p, 1, 'the parent is marked as partial');
    assert.equal(stats.errors, 1);
    chmodSync(join(root, 'secret'), 0o755);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('scanTree: an unreadable root makes the whole scan partial', {skip: process.getuid?.() === 0}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hb-usage-'));
  try {
    chmodSync(root, 0o000);
    const {tree} = await scanTree(root);
    assert.equal(tree.k, 'locked');
    assert.equal(tree.p, 1);
  } finally { chmodSync(root, 0o755); rmSync(root, {recursive: true, force: true}); }
});

test('scanTree: a deadline marks unread directories as partial', async () => {
  const root = fixture();
  try {
    const {tree, stats} = await scanTree(root, {deadline: 0});
    assert.equal(stats.partial, true);
    assert.equal(tree.p, 1);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('aggregate: deep trees do not overflow the stack', () => {
  const root = {n: '/', k: 'dir', d: 0, s: 0, f: 0, m: 0, ch: []};
  let n = root;
  for (let i = 0; i < 20000; i++) { const c = {n: 'd' + i, k: 'dir', d: 1, s: 1, f: 0, m: i, ch: []}; n.ch.push(c); n = c; }
  n.ch.push({n: 'f', k: 'file', d: 10, s: 10, f: 1, m: 99999});
  aggregate(root);
  assert.equal(root.d, 20010);
  assert.equal(root.f, 1);
  assert.equal(root.m, 99999);
});

test('view: keeps the largest children and folds the rest into "more"', () => {
  const ch = Array.from({length: 10}, (_, i) => ({n: 'c' + i, k: 'dir', d: 100 - i, s: 100 - i, f: 1, m: i, ch: [{n: 'g', k: 'file', d: 1, s: 1, f: 1, m: 0}]}));
  const v = view({n: '/', k: 'dir', d: 955, s: 955, f: 10, m: 9, ch}, 1, {top: 3, nested: 2});
  assert.equal(v.ch.length, 4);
  assert.equal(v.c, 10);
  const more = v.ch.at(-1);
  assert.deepEqual([more.k, more.x, more.d, more.m], ['more', 7, 97 + 96 + 95 + 94 + 93 + 92 + 91, 9]);
  assert.equal(v.ch[0].ch, undefined, 'depth 1 stops at the children');
  assert.equal(v.ch[0].c, 1);
});

test('segments: plain names only', () => {
  assert.deepEqual(segments('/var//lib/'), ['var', 'lib']);
  assert.deepEqual(segments('/'), []);
  for (const bad of ['/var/../etc', '/./x', 'a\0b', 5]) assert.throws(() => segments(bad));
});

test('mountinfo: escapes, bind mounts, duplicates and pseudo filesystems', () => {
  const raw = [
    '29 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
    '30 29 0:5 / /proc rw - proc proc rw',
    '31 29 259:2 / /mnt/my\\040data rw - btrfs /dev/nvme0n1p2 rw',
    '32 29 259:2 / /srv/again rw - btrfs /dev/nvme0n1p2 rw',
    '33 29 8:1 /home/x /srv/bind rw - ext4 /dev/sda1 rw',
    '34 29 7:3 / /snap/core/1 ro - squashfs /dev/loop3 ro',
    '35 29 0:40 / /var/lib/docker/overlay2/a/merged rw - overlay overlay rw',
  ].join('\n');
  const all = parseMountinfo(raw);
  assert.equal(all[2].mount, '/mnt/my data');
  assert.deepEqual(scanTargets(all).map(m => m.mount), ['/', '/mnt/my data']);
  // btrfs subvolumes share a device but have sibling roots: each is its own target; a bind inside one is not.
  const btrfs = parseMountinfo([
    '40 1 0:30 /@ / rw - btrfs /dev/nvme0n1p2 rw',
    '41 40 0:30 /@home /home rw - btrfs /dev/nvme0n1p2 rw',
    '42 40 0:30 /@home/me/data /srv/data rw - btrfs /dev/nvme0n1p2 rw',
    '43 40 0:30 /@ /mnt/again rw - btrfs /dev/nvme0n1p2 rw',
  ].join('\n'));
  assert.deepEqual(scanTargets(btrfs).map(m => m.mount), ['/', '/home']);
});

test('createUsage: scans in a child process, caches, and serves tree views by path', async () => {
  const root = fixture(), cache = mkdtempSync(join(tmpdir(), 'hb-usage-cache-'));
  const events = [];
  try {
    const u = createUsage({mountinfo: async () => `29 1 8:1 / ${root} rw - ext4 /dev/x rw\n40 29 8:2 / ${join(root, 'mnt')} rw - ext4 /dev/y rw`, cacheOf: m => join(cache, 'c.json.gz'), record: m => events.push(m)});
    assert.deepEqual((await u.tree(root)).node, null, 'no scan yet');
    await assert.rejects(u.tree('/etc'), /Unknown filesystem/);
    await assert.rejects(u.start('/nope'), /Unknown filesystem/);
    await u.start(root);
    await assert.rejects(u.start(root), /already running/);
    for (let i = 0; i < 200 && !events.some(e => e.includes('finished')); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(existsSync(join(cache, 'c.json.gz')));
    const data = JSON.parse(gunzipSync(readFileSync(join(cache, 'c.json.gz'))).toString());
    assert.equal(data.meta.partial, false);
    assert.equal(find(data.tree, ['mnt']).k, 'mount', 'other mountpoints are passed to the scanner as boundaries');
    const listed = (await u.list()).mounts[0];
    assert.equal(listed.running, null);
    assert.ok(listed.scan.files >= 9);
    const t = await u.tree(root, '/a', 2);
    assert.equal(t.path, '/a');
    assert.equal(t.node.ch[0].n, 'large.bin');
    await assert.rejects(u.tree(root, '/a/../..'), /Invalid path/);
    await assert.rejects(u.tree(root, '/missing'), /Not found/);
  } finally { rmSync(root, {recursive: true, force: true}); rmSync(cache, {recursive: true, force: true}); }
});

test('summary sidecar: list, cleanup and growth work without the tree; deletes keep it in step', async () => {
  const {createTrashLog} = await import('../server/delete.mjs');
  const {summaryPath} = await import('../server/usage-scan-run.mjs');
  const root = mkdtempSync(join(tmpdir(), 'hb-sum-')), cache = mkdtempSync(join(tmpdir(), 'hb-sum-cache-'));
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, '.local/share'), {recursive: true});
    mkdirSync(join(home, '.cache'), {recursive: true});
    writeFileSync(join(home, '.cache/blob.bin'), big(60 * MiB));
    const events = [];
    const file = join(cache, 'c.json.gz');
    const u = createUsage({mountinfo: async () => `29 1 8:1 / ${root} rw - ext4 /dev/x rw`, cacheOf: () => file, record: e => events.push(e), home, protect: [],
      dpkg: async () => [], proc: join(root, 'noproc'), trashLog: createTrashLog({file: join(root, 't.json'), home, mountpoints: async () => [root]}), trashDays: 0, verifyPassword: async () => {}});
    await u.start(root);
    for (let i = 0; i < 200 && !events.some(e => e.includes('finished')); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(existsSync(summaryPath(file)));
    // (Under /tmp most paths are also "Temporary files"; the cache rule ranks above that one.)
    const has = async us => (await us.candidates(root)).items.some(i => i.path === join(home, '.cache') && i.category === 'cache');
    assert.ok(await has(u));
    // Delete the item through the dashboard: the summary drops it without a rescan.
    const p = await u.prepareDelete(root, '/home/.cache');
    await u.remove(p.id, 'permanent', 'x');
    assert.equal(await has(u), false);
    const fresh = createUsage({mountinfo: async () => `29 1 8:1 / ${root} rw - ext4 /dev/x rw`, cacheOf: () => file});
    assert.equal(await has(fresh), false, 'the updated summary was saved');
    // Without the tree cache, the list and suggestions still come from the summary alone.
    rmSync(file);
    assert.equal((await fresh.list()).mounts[0].scan.adjusted, true);
    assert.equal((await fresh.candidates(root)).scanned, true);
  } finally { rmSync(root, {recursive: true, force: true}); rmSync(cache, {recursive: true, force: true}); }
});

test('scannerNodeFlags: small young generation, heap scaled to the filesystem', async () => {
  const {scannerNodeFlags} = await import('../server/usage-scan.mjs');
  assert.deepEqual(scannerNodeFlags(0), ['--max-semi-space-size=4', '--max-old-space-size=512']);
  assert.deepEqual(scannerNodeFlags(1.44e6), ['--max-semi-space-size=4', '--max-old-space-size=512']);
  assert.equal(scannerNodeFlags(5e6)[1], '--max-old-space-size=1600');
  assert.equal(scannerNodeFlags(1e9)[1], '--max-old-space-size=4096');
});
