import test from 'node:test';
import assert from 'node:assert/strict';
import {createLimiter, machineAction} from '../server/machine.mjs';

test('wrong passwords lock the buttons after the limit, then unlock', () => {
  const l = createLimiter({max: 3, window: 1000, lockout: 5000});
  assert.equal(l.fail(0), 2);
  assert.equal(l.fail(10), 1);
  assert.equal(l.retryAfter(10), 0);
  assert.equal(l.fail(20), 0);
  assert.equal(l.retryAfter(20), 5);
  assert.equal(l.retryAfter(5020), 0);
});

test('failures outside the window are forgotten', () => {
  const l = createLimiter({max: 2, window: 1000, lockout: 5000});
  l.fail(0);
  assert.equal(l.fail(2000), 1);
  assert.equal(l.retryAfter(2000), 0);
});

test('actions and passwords are validated before anything runs', async () => {
  await assert.rejects(machineAction('halt', 'pw'), /Unsupported/);
  await assert.rejects(machineAction('reboot', ''), /password/);
  await assert.rejects(machineAction('reboot', 42), /password/);
  await assert.rejects(machineAction('reboot', 'a\0b'), /password/);
  await assert.rejects(machineAction('poweroff', 'x'.repeat(513)), /password/);
});
