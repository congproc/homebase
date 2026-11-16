import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync, readdirSync, lstatSync, appendFileSync, utimesSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkTarget, encodeTrashPath, moveToTrash, trashFor, createTrashLog, fingerprint, sameFile, protectedPaths, exceedsLimits, isTrashRoot} from '../server/delete.mjs';
import {createUsage} from '../server/usage.mjs';
import {verifyOwnPassword} from '../server/machine.mjs';

const MiB = 1024 * 1024;
const noDpkg = async () => [];
const tmp = p => mkdtempSync(join(tmpdir(), p));

test('checkTarget: what can never be deleted', async () => {
  const root = tmp('hb-del-');
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, 'proj/app'), {recursive: true});
    mkdirSync(join(home, '.ssh'), {recursive: true});
    mkdirSync(join(home, 'data/mnt'), {recursive: true});
    mkdirSync(join(home, 'real'), {recursive: true});
    writeFileSync(join(home, 'real/f.bin'), 'x');
    symlinkSync(join(home, 'real'), join(home, 'link'));
    writeFileSync(join(home, 'ok.bin'), 'x');
    const base = {mountRoot: root, home, protect: protectedPaths({home, root: join(home, 'proj/app')}), mountpoints: [root, join(home, 'data/mnt')], dpkg: noDpkg, proc: join(root, 'noproc')};
    const why = async full => (await checkTarget({...base, full})).blocked.join(' | ');
    assert.match(await why(root), /root of a filesystem/);
    assert.match(await why(home), /home folder/);
    assert.match(await why(join(home, 'data')), /mounted inside it/);
    assert.match(await why(join(home, 'data/mnt')), /mounted here/);
    assert.match(await why(join(home, 'proj')), /contains .*proj\/app, which Homebase needs/);
    assert.match(await why(join(home, 'proj/app/x')), /Homebase needs this|no longer exists/);
    assert.match(await why(join(home, '.ssh')), /Keys and credentials/);
    assert.match(await why(join(home, 'link/f.bin')), /symbolic link/);
    assert.match(await why(join(home, 'nope')), /no longer exists/);
    assert.match(await why(home + '/a/../ok.bin'), /Invalid path/);
    assert.match((await checkTarget({...base, full: join(home, 'ok.bin'), dpkg: async () => ['coreutils']})).blocked.join(), /Installed by the package coreutils/);
    const ok = await checkTarget({...base, full: join(home, 'ok.bin')});
    assert.deepEqual(ok.blocked, []);
    assert.ok(ok.st.isFile());
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('checkTarget: refuses files open in a running program', async () => {
  const root = tmp('hb-del-');
  try {
    writeFileSync(join(root, 'busy.log'), 'x');
    const proc = join(root, 'proc');
    mkdirSync(join(proc, '42/fd'), {recursive: true});
    writeFileSync(join(proc, '42/comm'), 'writer\n');
    symlinkSync(join(root, 'busy.log'), join(proc, '42/fd/3'));
    symlinkSync('/', join(proc, '42/cwd'));
    const r = await checkTarget({full: join(root, 'busy.log'), mountRoot: '/', home: '/nonexistent-home', mountpoints: ['/'], dpkg: noDpkg, proc});
    assert.match(r.blocked.join(), /Open in writer \(PID 42\)/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('fingerprint: same inode and content time, or it is a different file', () => {
  const root = tmp('hb-del-');
  try {
    writeFileSync(join(root, 'f'), 'a');
    const a = fingerprint(lstatSync(join(root, 'f')));
    utimesSync(join(root, 'f'), new Date(2020, 1, 1), new Date(2020, 1, 1));
    assert.equal(sameFile(a, fingerprint(lstatSync(join(root, 'f')))), false);
    rmSync(join(root, 'f')); mkdirSync(join(root, 'f'));
    assert.equal(sameFile(a, fingerprint(lstatSync(join(root, 'f')))), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('trash: freedesktop layout, exclusive names, encoded paths', async () => {
  const root = tmp('hb-trash-');
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, '.local/share'), {recursive: true});
    for (const n of ['a b.tar.gz', 'dir']) n === 'dir' ? mkdirSync(join(home, n)) : writeFileSync(join(home, n), 'x');
    const st = lstatSync(join(home, 'a b.tar.gz'));
    const t = await trashFor(st, root, {home});
    assert.equal(t.dir, join(home, '.local/share/Trash'));
    assert.equal(t.topdir, null);
    assert.equal((await moveToTrash(join(home, 'a b.tar.gz'), t, new Date(2026, 10, 16, 9, 5, 7))).name, 'a b.tar.gz');
    writeFileSync(join(home, 'a b.tar.gz'), 'again');
    assert.equal((await moveToTrash(join(home, 'a b.tar.gz'), t)).name, 'a b.tar.2.gz', 'a second item with the same name gets its own');
    const info = readFileSync(join(t.dir, 'info/a b.tar.gz.trashinfo'), 'utf8');
    assert.equal(info, `[Trash Info]\nPath=${encodeTrashPath(join(home, 'a b.tar.gz'))}\nDeletionDate=2026-11-16T09:05:07\n`);
    assert.ok(info.includes('a%20b.tar.gz'));
    assert.ok(!existsSync(join(home, 'a b.tar.gz')));
    // Another filesystem: <mount>/.Trash-<uid> with a path relative to the mount.
    const other = await trashFor({...st, dev: -1}, join(root, 'mnt-x'), {home, create: false});
    assert.match(other.error, /no trash/);
    mkdirSync(join(root, 'mnt'));
    const top = await trashFor({...st, dev: -1}, join(root, 'mnt'), {home});
    assert.equal(top.dir, join(root, 'mnt', `.Trash-${process.getuid()}`));
    mkdirSync(join(root, 'mnt/sub'));
    writeFileSync(join(root, 'mnt/sub/x'), 'x');
    await moveToTrash(join(root, 'mnt/sub/x'), top);
    assert.match(readFileSync(join(top.dir, 'info/x.trashinfo'), 'utf8'), /^Path=sub\/x$/m);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('trash log: restore refuses to overwrite, purge by id and by age', async () => {
  const root = tmp('hb-trash-');
  try {
    const dir = join(root, `.Trash-${process.getuid()}`);
    const log = createTrashLog({file: join(root, 'state/trash.json'), home: join(root, 'nohome'), mountpoints: async () => [root]});
    const put = async (name, at) => {
      writeFileSync(join(root, name), name);
      const m = await moveToTrash(join(root, name), {dir, topdir: root});
      return log.add({id: name, original: join(root, name), dir, name: m.name, dev: m.dev, ino: m.ino, at, bytes: 1, files: 1, mount: root});
    };
    await put('old', Date.now() - 10 * 86400000);
    await put('new', Date.now());
    await put('clash', Date.now());
    assert.deepEqual((await log.list()).map(e => e.id), ['old', 'new', 'clash']);
    await log.restore('new');
    assert.equal(readFileSync(join(root, 'new'), 'utf8'), 'new');
    writeFileSync(join(root, 'clash'), 'someone else');
    await assert.rejects(log.restore('clash'), /already exists/);
    assert.deepEqual((await log.purge({days: 7})).map(e => e.id), ['old']);
    assert.ok(!existsSync(join(dir, 'files/old')) && !existsSync(join(dir, 'info/old.trashinfo')));
    await log.purge({id: 'clash'});
    assert.deepEqual(await log.list(), []);
    await assert.rejects(log.purge({id: 'clash'}), /Not in the trash/);
    // An item removed from the trash by hand drops out of the list.
    await put('gone', Date.now());
    rmSync(join(dir, 'files/gone'));
    assert.deepEqual(await log.list(), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('trash log: tampered or replaced entries are dropped, never acted on', async () => {
  const root = tmp('hb-trash-');
  try {
    const dir = join(root, `.Trash-${process.getuid()}`), file = join(root, 'state/trash.json');
    mkdirSync(join(root, 'Documents'));
    writeFileSync(join(root, 'Documents/precious'), 'x');
    writeFileSync(join(root, 'item'), 'x');
    const m = await moveToTrash(join(root, 'item'), {dir, topdir: root});
    const docs = lstatSync(join(root, 'Documents'));
    mkdirSync(join(root, 'state'));
    writeFileSync(file, JSON.stringify([
      {id: 'escape', original: '/x', dir, name: '../Documents', dev: String(docs.dev), ino: String(docs.ino), at: 0},
      {id: 'elsewhere', original: '/x', dir: root, name: 'Documents', dev: String(docs.dev), ino: String(docs.ino), at: 0},
      {id: 'replaced', original: join(root, 'item'), dir, name: m.name, dev: m.dev, ino: '1', at: 0},
    ]));
    const log = createTrashLog({file, home: join(root, 'nohome'), mountpoints: async () => [root]});
    assert.deepEqual(await log.purge({days: 1}), []);
    assert.ok(existsSync(join(root, 'Documents/precious')), 'nothing outside the trash is touched');
    assert.ok(existsSync(join(dir, 'files/item')), 'an item whose inode no longer matches is left alone');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [], 'invalid entries are dropped from the log');
    assert.equal(isTrashRoot(join(root, 'x/../Trash'), {home: root, mountpoints: [root]}), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('trash folders that are symlinks are refused; restore will not follow a symlinked ancestor', async () => {
  const root = tmp('hb-trash-');
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, '.local/share/Trash'), {recursive: true});
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(home, '.local/share/Trash/files'));
    writeFileSync(join(home, 'f'), 'x');
    const t = await trashFor(lstatSync(join(home, 'f')), root, {home});
    await assert.rejects(moveToTrash(join(home, 'f'), t), /not a trash folder Homebase can trust/);
    assert.ok(existsSync(join(home, 'f')));

    rmSync(join(home, '.local/share/Trash/files'));
    mkdirSync(join(home, 'work/sub'), {recursive: true});
    writeFileSync(join(home, 'work/sub/g'), 'x');
    const log = createTrashLog({file: join(root, 'trash.json'), home, mountpoints: async () => []});
    const m = await moveToTrash(join(home, 'work/sub/g'), t);
    await log.add({id: 'g', original: join(home, 'work/sub/g'), dir: t.dir, name: m.name, dev: m.dev, ino: m.ino, at: Date.now()});
    rmSync(join(home, 'work'), {recursive: true});
    mkdirSync(join(root, 'other/sub'), {recursive: true});
    symlinkSync(join(root, 'other'), join(home, 'work'));
    await assert.rejects(log.restore('g'), /gone or now a link/);
    assert.ok(!existsSync(join(root, 'other/sub/g')));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('exceedsLimits: stops early, counts unreadable as big', async () => {
  const root = tmp('hb-big-');
  try {
    mkdirSync(join(root, 'd/e'), {recursive: true});
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `d/e/${i}`), 'x');
    assert.equal(await exceedsLimits(join(root, 'd')), false);
    assert.equal(await exceedsLimits(join(root, 'd'), {files: 5}), true);
    assert.equal(await exceedsLimits(join(root, 'd'), {bytes: 4096}), true);
    if (process.getuid() !== 0) { chmodSync(join(root, 'd/e'), 0); assert.equal(await exceedsLimits(join(root, 'd')), true); chmodSync(join(root, 'd/e'), 0o755); }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('createUsage: prepare → delete, with password rules, the change guard and tree updates', async () => {
  const root = tmp('hb-usage-del-'), cache = tmp('hb-usage-cache-');
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, '.local/share'), {recursive: true});
    mkdirSync(join(home, 'a'), {recursive: true});
    writeFileSync(join(home, 'a/big.bin'), Buffer.alloc(3 * MiB, 1));
    writeFileSync(join(home, 'a/other.bin'), Buffer.alloc(2 * MiB, 1));
    writeFileSync(join(home, 'a/edit.bin'), Buffer.alloc(2 * MiB, 1));
    const passwords = [];
    const events = [];
    const u = createUsage({mountinfo: async () => `29 1 8:1 / ${root} rw - ext4 /dev/x rw`, cacheOf: () => join(cache, 'c.json.gz'), record: e => events.push(e),
      home, protect: [], dpkg: noDpkg, proc: join(root, 'noproc'), trashLog: createTrashLog({file: join(root, 'trash.json'), home, mountpoints: async () => [root]}), trashDays: 0,
      verifyPassword: async p => { passwords.push(p); if (p !== 'right') throw Error('Incorrect password'); }});
    await u.start(root);
    for (let i = 0; i < 200 && !events.some(e => e.includes('finished')); i++) await new Promise(r => setTimeout(r, 50));
    const before = (await u.tree(root, '/home/a', 1)).node.d;

    const p = await u.prepareDelete(root, '/home/a/big.bin');
    assert.deepEqual(p.blocked, []);
    assert.equal(p.trash.available, true);
    assert.deepEqual(p.needsPassword, {trash: false, permanent: true});
    await assert.rejects(u.remove(p.id, 'permanent'), /Password required/);
    await assert.rejects(u.remove(p.id, 'permanent', 'wrong'), /Incorrect password/);
    const t = await u.remove(p.id, 'trash');
    assert.equal(t.mode, 'trash');
    assert.ok(existsSync(join(home, '.local/share/Trash/files/big.bin')));
    await assert.rejects(u.remove(p.id, 'trash'), /expired/, 'a confirmation is single use');
    const after = (await u.tree(root, '/home/a', 1)).node;
    assert.ok(!after.ch.some(c => c.n === 'big.bin'));
    assert.equal(after.d, before - 3 * MiB, 'sizes are taken off the cached tree');
    assert.equal((await u.tree(root, '/', 1)).meta.adjusted, true);

    const listed = (await u.trash.list()).items;
    assert.equal(listed[0].original, join(home, 'a/big.bin'));
    await assert.rejects(u.trash.purge(listed[0].id, 'wrong'), /Incorrect password/, 'emptying from the trash needs the password');
    await u.trash.restore(listed[0].id);
    assert.ok(existsSync(join(home, 'a/big.bin')));

    const q = await u.prepareDelete(root, '/home/a/edit.bin');
    appendFileSync(join(home, 'a/edit.bin'), 'changed after confirming');
    utimesSync(join(home, 'a/edit.bin'), new Date(2001, 1, 1), new Date(2001, 1, 1));
    await assert.rejects(u.remove(q.id, 'trash'), /changed since you opened it/);

    const r = await u.prepareDelete(root, '/home/a/other.bin');
    const gone = await u.remove(r.id, 'permanent', 'right');
    assert.equal(gone.mode, 'permanent');
    assert.ok(!existsSync(join(home, 'a/other.bin')));
    assert.deepEqual(passwords, ['wrong', 'wrong', 'right']);

    assert.match((await u.prepareDelete(root, '/home')).blocked.join(), /home folder/);
    assert.equal((await u.prepareDelete(root, '/home')).id, null, 'blocked items get no confirmation id');
    await assert.rejects(u.remove('made-up', 'trash'), /expired/);
    await assert.rejects(u.remove(r.id, 'shred'), /Unsupported delete mode/);
    assert.ok(readdirSync(join(home, '.local/share/Trash/files')).length === 0);
  } finally { rmSync(root, {recursive: true, force: true}); rmSync(cache, {recursive: true, force: true}); }
});

test('verifyOwnPassword: input on stdin, limiter shared and reset on success', async () => {
  const root = tmp('hb-pw-');
  try {
    // Accepts only "right\0" on stdin, like unix_chkpwd's protocol.
    writeFileSync(join(root, 'bash-chkpwd'), '#!/bin/bash\nIFS= read -r -d "" p; [ "$p" = right ]\n', {mode: 0o755});
    const chkpwd = join(root, 'bash-chkpwd');
    await assert.rejects(verifyOwnPassword('', {chkpwd}), /Enter the server account password/);
    await assert.rejects(verifyOwnPassword('bad', {chkpwd, delay: 0}), /Incorrect password \(4 attempts left\)/);
    await verifyOwnPassword('right', {chkpwd, delay: 0});
    await assert.rejects(verifyOwnPassword('bad', {chkpwd, delay: 0}), /4 attempts left/, 'success resets the count');
    await verifyOwnPassword('right', {chkpwd, delay: 0});
    // Parallel guesses are checked one at a time, so the fifth failure locks the rest out.
    const results = await Promise.allSettled(Array.from({length: 8}, () => verifyOwnPassword('bad', {chkpwd, delay: 0})));
    const messages = results.map(r => r.reason.message);
    assert.equal(messages.filter(m => /Incorrect password/.test(m)).length, 5);
    assert.equal(messages.filter(m => /Too many wrong passwords/.test(m)).length, 3);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
