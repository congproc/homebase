import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {parseSize, disabledSnaps, findCandidates, toolFor, ageFactor, createCleanup, createTools} from '../server/cleanup.mjs';

const DAY = 86400000, GB = 1024 ** 3, MB = 1024 ** 2, NOW = Date.UTC(2026, 10, 16);
const dir = (n, ch, m = NOW - 400 * DAY) => ({n, k: 'dir', d: ch.reduce((a, c) => a + c.d, 0), s: 0, f: ch.reduce((a, c) => a + (c.f || 0), 0), m, ch});
const file = (n, d, m = NOW - 400 * DAY) => ({n, k: 'file', d, s: d, f: 1, m});

test('parseSize: journalctl binary letters, docker decimal units', () => {
  assert.equal(parseSize('1000.3M'), Math.round(1000.3 * MB));
  assert.equal(parseSize('1.5G'), Math.round(1.5 * GB));
  assert.equal(parseSize('189.2MB'), 189200000);
  assert.equal(parseSize('512kB'), 512000);
  assert.equal(parseSize('0B'), 0);
  assert.equal(parseSize('garbage'), 0);
});

test('disabledSnaps matches the helper rule', () => {
  const listing = 'Name Version Rev Tracking Publisher Notes\ncore24 1 609 latest/stable canonical base,disabled\nfirefox 1 4793 latest/stable mozilla -\nbad;x 1 1 l p disabled\n';
  assert.deepEqual(disabledSnaps(listing), [{name: 'core24', rev: '609'}]);
});

test('findCandidates: category roots, exclusive sizes, protected trees, stale folders, ranking', () => {
  const tree = dir('/', [
    dir('home', [dir('u', [
      dir('.cache', [dir('huggingface', [file('w.bin', 3 * GB)]), file('thumbs.db', 2 * GB)]),
      dir('proj', [dir('node_modules', [file('a.js', 600 * MB, NOW - DAY)], NOW - DAY), file('src.ts', 200 * MB, NOW - DAY)], NOW - DAY),
      dir('old-stuff', [file('x.dat', 2 * GB)]),
      dir('miniforge3', [dir('pkgs', [file('p.conda', 700 * MB)]), dir('envs', [file('lib.so', 3 * GB)])]),
      dir('.ssh', [file('id', 900 * MB)]),
      file('tiny.iso', 10 * MB),
    ])]),
    dir('usr', [file('big.so', 5 * GB)]),
    dir('var', [dir('cache', [dir('apt', [file('x.deb', 300 * MB)])])]),
  ]);
  const r = findCandidates(tree, '/', {now: NOW});
  const by = Object.fromEntries(r.items.map(i => [i.path, i]));
  // ~/.cache counts only what is not models: thumbs.db is matched as a database (protected) and the models stand alone.
  assert.equal(by['/home/u/.cache/huggingface'].category, 'models');
  assert.equal(by['/home/u/.cache/huggingface'].tool, null, 'not an Ollama path');
  assert.equal(by['/home/u/.cache'], undefined, 'nothing left in ~/.cache after nested roots');
  assert.equal(by['/home/u/proj/node_modules'].category, 'build');
  assert.match(by['/home/u/proj/node_modules'].reason, /changed 1 day ago/);
  assert.equal(by['/home/u/old-stuff'].category, 'stale');
  assert.match(by['/home/u/old-stuff'].reason, /untouched 13 months/);
  assert.equal(by['/home/u/miniforge3/pkgs'].category, 'conda-pkgs', 'safe part inside protected software is found');
  for (const p of ['/home/u/miniforge3', '/home/u/miniforge3/envs', '/home/u/.ssh', '/usr', '/home/u/.cache/thumbs.db', '/home/u/tiny.iso', '/home', '/home/u'])
    assert.equal(by[p], undefined, p);
  assert.equal(by['/var/cache/apt'].tool, 'apt');
  // Fresh node_modules (×0.1 for age) ranks below an old 300 MB APT cache (safe, ×1).
  const order = r.items.map(i => i.path);
  assert.ok(order.indexOf('/var/cache/apt') < order.indexOf('/home/u/proj/node_modules'));
  assert.ok(r.groups.find(g => g.category === 'models').bytes === 3 * GB);
});

test('toolFor and ageFactor', () => {
  assert.equal(toolFor('models', '/usr/share/ollama/.ollama/models'), 'ollama');
  assert.equal(toolFor('pkg-cache', '/home/u/.cache/pip'), 'pip');
  assert.equal(toolFor('pkg-cache', '/home/u/.npm/_cacache'), 'npm');
  assert.equal(toolFor('pkg-cache', '/home/u/.cache/yarn'), null);
  assert.ok(ageFactor(DAY) < ageFactor(20 * DAY) && ageFactor(20 * DAY) < ageFactor(100 * DAY) && ageFactor(100 * DAY) < ageFactor(400 * DAY));
});

test('createCleanup: validates tool, argument, root permission and one run at a time', async () => {
  let release;
  const tools = [
    {id: 'slow', label: 'Slow', root: false, measure: async () => ({bytes: 5}), run: () => new Promise(r => { release = () => r('ok'); })},
    {id: 'sys', label: 'Sys', root: true, measure: async () => ({bytes: 9}), run: async () => 'done'},
    {id: 'model', label: 'Model', root: false, perItem: true, measure: async () => null, run: async a => a},
  ];
  const events = [];
  const c = createCleanup({tools, record: e => events.push(e), rootAllowed: async () => false});
  const m = await c.measureAll();
  assert.deepEqual(m.map(t => [t.id, t.available, t.runnable]), [['slow', true, true], ['sys', true, false], ['model', false, false]]);
  await assert.rejects(c.run('rm'), /Unknown cleanup/);
  await assert.rejects(c.run('slow', '/etc'), /Invalid cleanup target/);
  await assert.rejects(c.run('model'), /Invalid cleanup target/);
  await assert.rejects(c.run('sys'), /administrator setup/);
  const first = c.run('slow');
  await new Promise(r => setTimeout(r, 20));
  await assert.rejects(c.run('model', 'x'), /Another cleanup is running/);
  release();
  assert.equal((await first).output, 'ok');
  assert.ok(events.some(e => e.startsWith('Cleanup: Slow')));
  assert.equal((await c.run('model', 'qwen')).output, 'qwen');
});

test('ollama tool: lists models and only deletes one the server listed', async () => {
  const deleted = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({models: [{name: 'qwen:9b', size: 6e9, modified_at: '2026-08-01T00:00:00Z'}]})); return; }
    if (req.url === '/api/delete' && req.method === 'DELETE') { let b = ''; req.on('data', c => b += c).on('end', () => { deleted.push(JSON.parse(b).model); res.end('{}'); }); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const tool = createTools({ollama: `http://127.0.0.1:${server.address().port}`}).find(t => t.id === 'ollama');
    const m = await tool.measure();
    assert.equal(m.bytes, 6e9);
    assert.equal(m.items[0].name, 'qwen:9b');
    await assert.rejects(tool.run('../../etc'), /Unknown model/);
    assert.equal(await tool.run('qwen:9b'), 'Removed qwen:9b');
    assert.deepEqual(deleted, ['qwen:9b']);
  } finally { server.close(); }
});
