import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENTS, agentBinary, agentByName, agentSnapshot, findOnPath} from '../server/agents.mjs';

test('processes are attributed to the right agent', () => {
  const procs = ['claude', 'codex', 'agy', 'antigravity', 'ollama', 'bash', 'magyar'].map((name, i) => ({pid: i + 1, name}));
  const tools = {claude: '/x/claude', agy: '/x/agy'};
  const snap = Object.fromEntries(agentSnapshot(procs, tools).map(a => [a.name, a]));
  assert.deepEqual(snap.antigravity.processes.map(p => p.name), ['agy', 'antigravity']);
  assert.deepEqual(snap.claude.processes.map(p => p.name), ['claude']);
  assert.equal(snap.antigravity.installed, true);
  assert.equal(snap.codex.installed, false);
  assert.deepEqual(AGENTS.map(a => a.name), ['claude', 'codex', 'antigravity', 'ollama']);
});

test('the terminal binary is preferred for launching', () => {
  assert.equal(agentBinary(agentByName('antigravity'), {agy: '/a/agy', antigravity: '/a/antigravity'}), '/a/agy');
  assert.equal(agentBinary(agentByName('antigravity'), {antigravity: '/a/antigravity'}), '/a/antigravity');
  assert.equal(agentByName('ollama').launch, false);
});

test('findOnPath only returns executables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-path-'));
  await writeFile(join(dir, 'tool'), '#!/bin/sh\n'); await chmod(join(dir, 'tool'), 0o755);
  await writeFile(join(dir, 'plain'), '');
  assert.equal(await findOnPath('tool', `/nonexistent:${dir}`), join(dir, 'tool'));
  assert.equal(await findOnPath('plain', dir), null);
});
