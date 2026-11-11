import test from 'node:test';
import assert from 'node:assert/strict';
import {detectFeatures, parseOverrides, resolveFeatures} from '../server/features.mjs';

const bare = {which: {claude: false, codex: false, ollama: false, docker: false, tmux: false}, containers: {available: false, error: 'Not installed'},
  ollamaOnline: false, gpu: {available: false, items: []}, sites: 0, plugHost: undefined};

test('a bare machine hides every optional feature, with a reason for each', () => {
  const f = resolveFeatures(detectFeatures(bare));
  for (const id of ['docker', 'tmux', 'ai', 'traffic', 'energy', 'gpu']) {
    assert.equal(f[id].on, false, id);
    assert.ok(f[id].reason.length > 0);
  }
  assert.equal(f.docker.reason, 'Docker is not installed');
});

test('installed tools and configuration turn features on', () => {
  const f = resolveFeatures(detectFeatures({...bare, which: {...bare.which, claude: true, docker: true, tmux: true},
    containers: {available: true}, gpu: {available: true, items: [{name: 'Arc A380'}]}, sites: 2, plugHost: '192.168.1.50'}));
  assert.deepEqual(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.on])), {docker: true, tmux: true, ai: true, traffic: true, energy: true, gpu: true});
  assert.equal(f.ai.reason, 'Claude Code found');
  assert.equal(f.traffic.reason, '2 sites configured');
});

test('Docker installed but unusable stays shown so the error is visible', () => {
  const f = resolveFeatures(detectFeatures({...bare, which: {...bare.which, docker: true}, containers: {available: false, error: 'permission denied'}}));
  assert.equal(f.docker.on, true);
  assert.match(f.docker.reason, /permission denied/);
});

test('a running Ollama counts as AI even when the binary is not on PATH', () => {
  assert.equal(resolveFeatures(detectFeatures({...bare, ollamaOnline: true})).ai.on, true);
});

test('config overrides force features on or off; unknown ids and non-booleans are ignored', () => {
  const overrides = parseOverrides({docker: false, gpu: true, ai: 'no', bogus: true});
  assert.deepEqual(overrides, {docker: false, gpu: true});
  const f = resolveFeatures(detectFeatures({...bare, which: {...bare.which, docker: true}}), overrides);
  assert.deepEqual([f.docker.on, f.docker.detected, f.docker.forced], [false, true, true]);
  assert.deepEqual([f.gpu.on, f.gpu.detected, f.gpu.forced], [true, false, true]);
  assert.equal(f.ai.forced, false);
  assert.deepEqual(parseOverrides(null), {});
});
