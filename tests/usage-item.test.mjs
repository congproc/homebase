import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {categorize, parseSwaps, CATEGORIES} from '../server/categories.mjs';
import {parseIds, modeString, atimeQuality, parseDpkgOwners, openBy, gitInfo, extensions, describe} from '../server/usage-item.mjs';
import {view} from '../server/usage.mjs';

test('categorize: protective rules win over cleanup rules', () => {
  const cases = {
    '/home/u/.ssh/id_ed25519': 'credentials',
    '/var/lib/postgresql/16/main': 'database',
    '/home/u/app/data.sqlite': 'database',
    '/var/lib/docker/overlay2/abc': 'containers',
    '/var/lib/dpkg/status': 'packages-db',
    '/usr/share/icons/x.png': 'system',
    '/home/u/proj/.git/objects/pack/a.pack': 'vcs',
    '/var/cache/apt/archives/x.deb': 'apt-cache',
    '/var/log/journal/abc/system.journal': 'journal',
    '/var/log/syslog.2.gz': 'old-logs',
    '/var/log/syslog': 'logs',
    '/home/u/.local/share/Trash/files/x': 'trash',
    '/home/u/.ollama/models/blobs/sha256-1': 'models',
    '/data/llama.gguf': 'models',
    '/home/u/.cache/pip/http': 'pkg-cache',
    '/home/u/.npm/_cacache/content-v2': 'pkg-cache',
    '/home/u/proj/node_modules': 'build',
    '/home/u/.cache/thumbnails': 'cache',
    '/srv/vm/disk.qcow2': 'disk-images',
    '/home/u/backups': 'archives',
    '/home/u/Videos/a.mkv': 'media',
    '/home/u/notes.txt': null,
    '/home/u/projects/server-manager/dist': null,
  };
  for (const [p, want] of Object.entries(cases)) assert.equal(categorize(p), want, p);
  assert.equal(categorize('/swap.img', new Set(['/swap.img'])), 'swap', 'active swap beats disk-image');
  assert.equal(categorize('/swap.img'), 'disk-images');
  for (const c of Object.values(CATEGORIES)) assert.ok(['safe', 'review', 'keep'].includes(c.verdict));
});

test('parseSwaps: files only, escaped spaces', () => {
  const s = parseSwaps('Filename\tType\tSize\tUsed\tPriority\n/swap.img                               file\t\t4194300\t\t0\t\t-1\n/dev/sda3 partition 100 0 -2\n/my\\040swap file 1 0 -3\n');
  assert.deepEqual([...s], ['/swap.img', '/my swap']);
});

test('ids, modes and atime quality', () => {
  assert.equal(parseIds('root:x:0:0::/root:/bin/bash\nme:x:1000:1000::/home/me:/bin/bash\n').get(1000), 'me');
  assert.equal(modeString(0o40755, 'dir'), 'drwxr-xr-x');
  assert.equal(modeString(0o41777, 'dir'), 'drwxrwxrwt');
  assert.equal(modeString(0o104755, 'file'), '-rwsr-xr-x');
  assert.equal(atimeQuality('rw,relatime'), 'approximate');
  assert.equal(atimeQuality('rw,noatime'), 'none');
  assert.equal(atimeQuality('rw,strictatime'), 'exact');
});

test('parseDpkgOwners: exact path only, diversions ignored', () => {
  const raw = 'coreutils, util-linux: /usr/bin\ndiversion by dash from: /usr/bin/sh\nbash: /usr/bin/bash\nlibc6: /usr/bin\n';
  assert.deepEqual(parseDpkgOwners(raw, '/usr/bin'), ['coreutils', 'libc6', 'util-linux']);
  assert.deepEqual(parseDpkgOwners(raw, '/usr/bin/bash'), ['bash']);
  assert.deepEqual(parseDpkgOwners('', '/x'), []);
});

test('openBy: open files under a path, deleted files and working directories', async () => {
  const proc = mkdtempSync(join(tmpdir(), 'hb-proc-'));
  const mk = (pid, comm, fds, cwd) => {
    mkdirSync(join(proc, pid, 'fd'), {recursive: true});
    writeFileSync(join(proc, pid, 'comm'), comm + '\n');
    fds.forEach((t, i) => symlinkSync(t, join(proc, pid, 'fd', String(i))));
    symlinkSync(cwd, join(proc, pid, 'cwd'));
  };
  try {
    mk('10', 'postgres', ['/data/db/base/1', '/data/db/pg_wal/2 (deleted)', 'socket:[123]', '/dev/null'], '/');
    mk('11', 'bash', ['/dev/pts/1'], '/data/db');
    mk('12', 'other', ['/data/dbx/file'], '/home');
    const r = await openBy('/data/db', {proc});
    assert.deepEqual(r.items.map(i => [i.pid, i.name, i.files, i.deleted, i.cwd]), [[10, 'postgres', 2, 1, false], [11, 'bash', 0, 0, true]]);
  } finally { rmSync(proc, {recursive: true, force: true}); }
});

test('gitInfo: finds the repository upwards without running git', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hb-git-'));
  try {
    mkdirSync(join(root, 'repo/.git/logs'), {recursive: true});
    mkdirSync(join(root, 'repo/src/deep'), {recursive: true});
    writeFileSync(join(root, 'repo/.git/HEAD'), 'ref: refs/heads/feature/x\n');
    writeFileSync(join(root, 'repo/.git/logs/HEAD'), '');
    const g = await gitInfo(join(root, 'repo/src/deep'), root, true);
    assert.equal(g.root, join(root, 'repo'));
    assert.equal(g.branch, 'feature/x');
    assert.ok(g.lastActivity > 0);
    assert.equal(await gitInfo(join(root, 'repo'), join(root, 'repo/src'), true) === null, false, 'the repo root itself is found');
    assert.equal(await gitInfo(join(root, 'elsewhere'), root, true), null);
    // A linked worktree: .git is a file pointing at the real git dir.
    mkdirSync(join(root, 'wt'));
    writeFileSync(join(root, 'wt/.git'), `gitdir: ${join(root, 'repo/.git')}\n`);
    assert.equal((await gitInfo(join(root, 'wt'), root, true)).worktree, true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('extensions: largest types by bytes, small files grouped', () => {
  const node = {n: 'x', k: 'dir', d: 0, ch: [
    {n: 'a.MP4', k: 'file', d: 500}, {n: 'b.mp4', k: 'file', d: 300}, {n: 'c.iso', k: 'file', d: 600},
    {n: 'sub', k: 'dir', ch: [{n: 'Makefile', k: 'file', d: 50}, {n: '', k: 'files', d: 40}]},
  ]};
  const e = extensions(node);
  assert.deepEqual(e.top.map(x => [x.ext, x.bytes, x.files]), [['.mp4', 800, 2], ['.iso', 600, 1], ['(none)', 50, 1]]);
  assert.equal(e.small, 40);
  assert.equal(e.complete, true);
});

test('view: tags nodes with their category', () => {
  const tree = {n: '/', k: 'dir', d: 10, s: 10, f: 2, m: 0, ch: [
    {n: 'var', k: 'dir', d: 8, s: 8, f: 1, m: 0, ch: [{n: 'cache', k: 'dir', d: 8, s: 8, f: 1, m: 0, ch: [{n: 'apt', k: 'dir', d: 8, s: 8, f: 1, m: 0}]}]},
    {n: 'swap.img', k: 'file', d: 2, s: 2, f: 1, m: 0},
  ]};
  const v = view(tree, 3, {at: '/', swaps: new Set(['/swap.img'])});
  assert.equal(v.ch[0].t, undefined);
  assert.equal(v.ch[0].ch[0].t, 'cache');
  assert.equal(v.ch[0].ch[0].ch[0].t, 'apt-cache');
  assert.equal(v.ch[1].t, 'swap');
});

test('describe: a real folder, and one deleted since the scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hb-item-'));
  try {
    mkdirSync(join(root, 'node_modules'));
    const node = {n: 'node_modules', k: 'dir', d: 4096, s: 4096, f: 3, m: 1000, o: 500, ch: []};
    const mount = {mount: root, fstype: 'ext4', opts: 'rw,relatime'};
    const d = await describe({mount, full: join(root, 'node_modules'), node, swaps: new Set(), fsUsed: 8192, proc: join(root, 'no-proc')});
    assert.equal(d.category.id, 'build');
    assert.equal(d.stat.mine, true);
    assert.equal(d.canDelete.ok, true);
    assert.equal(d.shareOfUsed, 0.5);
    assert.equal(d.oldest, 500);
    assert.equal(d.stat.atimeQuality, 'approximate');
    assert.equal(d.reclaim.uncertain, false);
    const root2 = await describe({mount, full: root, node: {...node, n: root}, swaps: new Set(), fsUsed: 8192, proc: join(root, 'no-proc')});
    assert.equal(root2.canDelete.ok, false, 'never the filesystem root');
    const gone = await describe({mount, full: join(root, 'vanished'), node, swaps: new Set(), fsUsed: 1});
    assert.equal(gone.gone, true);
    const cow = await describe({mount: {...mount, fstype: 'btrfs'}, full: join(root, 'node_modules'), node, swaps: new Set(), fsUsed: 1, proc: join(root, 'no-proc')});
    assert.equal(cow.reclaim.uncertain, true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
