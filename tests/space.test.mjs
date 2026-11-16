import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, openSync, closeSync, unlinkSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addSample, forecast, levelOf, deletedOpen, createSpace} from '../server/space.mjs';
import {annotateGrowth, aggregate} from '../server/usage-scan.mjs';
import {growthHotspots} from '../server/usage.mjs';

const DAY = 86400000, GB = 1024 ** 3, MB = 1024 ** 2, T0 = Date.UTC(2026, 9, 1, 12);

test('addSample keeps one point per day and drops old history', () => {
  let pts = [];
  pts = addSample(pts, {at: T0, used: 1});
  pts = addSample(pts, {at: T0 + 3600000, used: 2});
  pts = addSample(pts, {at: T0 + DAY, used: 3});
  assert.deepEqual(pts.map(p => p.used), [2, 3]);
  pts = addSample(pts, {at: T0 + 200 * DAY, used: 4});
  assert.deepEqual(pts.map(p => p.used), [4]);
});

test('forecast: needs a few days, fits a line, days until full only when growing', () => {
  const grow = Array.from({length: 10}, (_, i) => ({at: T0 + i * DAY, used: 100 * GB + i * 2 * GB + (i % 2 ? 0.1 * GB : 0)}));
  const f = forecast(grow, {available: 20 * GB, now: grow.at(-1).at});
  assert.ok(Math.abs(f.perDay - 2 * GB) < 0.05 * GB, `perDay ${f.perDay / GB}`);
  assert.ok(f.daysLeft > 9 && f.daysLeft < 11);
  assert.equal(forecast(grow.slice(0, 3), {now: grow[2].at}), null, 'too few points');
  const flat = grow.map(p => ({...p, used: 100 * GB}));
  assert.equal(forecast(flat, {available: 20 * GB, now: flat.at(-1).at}).daysLeft, null);
  const old = forecast(grow, {available: 1, now: grow.at(-1).at + 60 * DAY});
  assert.equal(old, null, 'only the last 30 days count');
});

test('levelOf: percent full or days until full', () => {
  assert.equal(levelOf({percent: 60, daysLeft: null}), 'ok');
  assert.equal(levelOf({percent: 86, daysLeft: null}), 'warn');
  assert.equal(levelOf({percent: 60, daysLeft: 10}), 'warn');
  assert.equal(levelOf({percent: 96, daysLeft: null}), 'critical');
  assert.equal(levelOf({percent: 70, daysLeft: 2}), 'critical');
});

test('deletedOpen: real deleted-but-open file of this process, memfd ignored', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hb-space-'));
  const f = join(root, 'held.log');
  writeFileSync(f, Buffer.alloc(64 * 1024, 1));
  const fd = openSync(f, 'r');
  unlinkSync(f);
  try {
    const r = await deletedOpen();
    const mine = r.items.find(i => i.pid === process.pid && i.path === f);
    assert.ok(mine, 'the deleted file this test holds open is found');
    assert.ok(mine.bytes >= 64 * 1024);
    assert.ok(r.total >= mine.bytes);
    // A fake /proc: memfd and non-deleted links are skipped.
    const proc = join(root, 'proc');
    mkdirSync(join(proc, '7/fd'), {recursive: true});
    writeFileSync(join(proc, '7/comm'), 'x\n');
    symlinkSync('/memfd:jit (deleted)', join(proc, '7/fd/1'));
    symlinkSync('/etc/hostname', join(proc, '7/fd/2'));
    assert.deepEqual((await deletedOpen({proc})).items, []);
  } finally { closeSync(fd); rmSync(root, {recursive: true, force: true}); }
});

test('createSpace: samples targets, keeps history on disk, reports levels', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hb-space-'));
  try {
    const file = join(root, 'h.json');
    const s = createSpace({targets: async () => [{mount: root}], file});
    const [m] = await s.sample(T0);
    assert.equal(m.mount, root);
    assert.ok(m.total > 0 && m.percent >= 0 && m.percent <= 100);
    assert.equal(m.forecast, null);
    assert.ok(['ok', 'warn', 'critical'].includes(m.level));
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[root].length, 1);
    assert.deepEqual(s.status().map(x => x.mount), [root]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

const dir = (n, ch) => ({n, k: 'dir', d: 0, s: 0, f: 0, m: 0, ch});
const file = (n, d) => ({n, k: 'file', d, s: d, f: 1, m: 1});

test('annotateGrowth and growthHotspots: growth per folder, follow the folder that explains it', () => {
  const before = aggregate(dir('/', [dir('home', [dir('u', [dir('proj', [file('a', 1 * GB)]), dir('vids', [file('v1', 2 * GB)])])]), dir('var', [file('log', 100 * MB)])]));
  const after = aggregate(dir('/', [
    dir('home', [dir('u', [dir('proj', [file('a', 1 * GB), dir('build', [file('o', 3 * GB)])]), dir('vids', [file('v1', 2 * GB), file('v2', 1 * GB)]), dir('new-dl', [file('iso', 2 * GB)])])]),
    dir('var', [file('log', 50 * MB)]),
  ]));
  annotateGrowth(after, before);
  assert.equal(after.g, 6 * GB - 50 * MB);
  const u = after.ch.find(c => c.n === 'home').ch[0];
  assert.equal(u.ch.find(c => c.n === 'new-dl').nw, 1);
  assert.equal(after.ch.find(c => c.n === 'var').g, -50 * MB);
  const spots = growthHotspots(after, '/');
  assert.deepEqual(spots.map(s => [s.path, s.growth / GB, s.isNew]), [
    ['/home/u/proj/build', 3, true], ['/home/u/new-dl', 2, true], ['/home/u/vids/v2', 1, true],
  ]);
  assert.deepEqual(growthHotspots(before, '/'), [], 'no previous scan, no growth');
});
