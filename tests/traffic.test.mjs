import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, appendFile, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readLog} from '../server/traffic.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'homebase-traffic-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return path.join(dir, 'access.jsonl');
}
const tstamp = '2026-11-15T00:00:00Z';

test('log reads preserve records across chunks and ignore invalid lines', async t => {
  const file = await fixture(t);
  const records = Array.from({length: 4000}, (_, i) => ({t: tstamp, p: `/page/${i}`, ua: 'Tiếng Việt'}));
  await writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\ninvalid\n{"t":"bad"}\n');
  const expected = records.map(r => ({...r, at: Date.parse(r.t)}));
  assert.deepEqual(await readLog(file), expected);
  assert.deepEqual(await readLog(file), expected);
  await appendFile(file, JSON.stringify({t: tstamp, p: '/new'}) + '\n');
  assert.equal((await readLog(file)).length, 4001);
});

test('unfinished lines and split UTF-8 characters survive incremental reads', async t => {
  const file = await fixture(t);
  const record = {t: tstamp, p: '/ế'};
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  const split = bytes.indexOf(Buffer.from('ế')) + 1;
  await writeFile(file, bytes.subarray(0, split));
  assert.deepEqual(await readLog(file), []);
  await appendFile(file, bytes.subarray(split, -1));
  assert.deepEqual(await readLog(file), []);
  await appendFile(file, '\n');
  assert.deepEqual(await readLog(file), [{...record, at: Date.parse(tstamp)}]);
});

test('truncated, replaced and removed logs reset their incremental cache', async t => {
  const file = await fixture(t);
  await writeFile(file, JSON.stringify({t: tstamp, p: '/long-original'}) + '\n');
  await readLog(file);
  await writeFile(file, JSON.stringify({t: tstamp, p: '/'}) + '\n');
  assert.equal((await readLog(file))[0].p, '/');
  await writeFile(file + '.new', JSON.stringify({t: tstamp, p: '/replacement'}) + '\n');
  await rename(file + '.new', file);
  assert.equal((await readLog(file))[0].p, '/replacement');
  await rm(file);
  assert.deepEqual(await readLog(file), []);
});
