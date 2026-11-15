import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

// Load only the collection helpers: importing index.mjs would start the server
// and the system monitoring timers.
const source = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('let dockerCache=null;'), source.indexOf('async function collectSnapshot(){'));
function setup(run, collectSnapshot = async () => {}) {
  let now = 100000;
  const api = runInNewContext(`let collecting=null; ${helpers}\n({diskFromStatfs,readDocker,collect})`, {
    run, collectSnapshot, Date: {now: () => now},
  });
  return {...api, advance: ms => { now += ms; }};
}

test('statfs disk conversion excludes reserved blocks from the percentage denominator', () => {
  const {diskFromStatfs} = setup();
  const disk = diskFromStatfs({blocks: 100, bfree: 40, bavail: 30, bsize: 4096});
  assert.equal(disk.total, 409600);
  assert.equal(disk.used, 245760);
  assert.equal(disk.percent, 67);
  assert.equal(diskFromStatfs({blocks: 0, bfree: 0, bavail: 0, bsize: 4096}).percent, 0);
});

test('Docker skips missing binaries and caches results, including errors, for 15 seconds', async () => {
  let calls = 0;
  const result = {ok: false, output: '', error: 'daemon unavailable'};
  const api = setup(async () => { calls++; return result; });
  assert.equal((await api.readDocker(null)).error, 'Not installed');
  assert.equal(calls, 0);
  assert.equal(await api.readDocker('/bin/docker'), result);
  api.advance(14999);
  await api.readDocker('/bin/docker');
  assert.equal(calls, 1);
  api.advance(1);
  await api.readDocker('/bin/docker');
  assert.equal(calls, 2);
});

test('Docker action waits for an active collection then bypasses its cache', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const api = setup(async () => ({ok: true, output: String(++calls)}), async () => {
    await api.readDocker('/bin/docker');
    await gate;
  });
  const poll = api.collect();
  const action = api.collect({refreshDocker: true});
  release();
  await Promise.all([poll, action]);
  assert.equal(calls, 2);
});
