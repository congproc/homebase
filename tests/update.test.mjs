import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions, VERSION, REPO} from '../server/update.mjs';

test('compareVersions orders numerically, ignores a leading v', () => {
  assert.equal(compareVersions('1.3.1', '1.3.0'), 1);
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.3.1', 'v1.3.1'), 0);
  assert.equal(compareVersions('1.2.9', '1.3.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('version comes from package.json and the update source is fixed', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(REPO, 'congproc/homebase');
});
