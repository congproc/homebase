// Reboot / power off the whole machine. The root helper checks the account's login password itself (the sudo
// rule needs none), so Homebase only forwards it on stdin: it is never logged, stored or put on a command line.
// Repeated wrong passwords lock the buttons for a while, on top of the helper's own delay per failure.
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import os from 'node:os';
import {config} from './config.mjs';

export const MACHINE_ACTIONS = ['reboot', 'poweroff'];
const MAX_FAILURES = 5, WINDOW = 10 * 60 * 1000, LOCKOUT = 15 * 60 * 1000;

const exec = (bin, args, {input, timeout = 30000} = {}) => new Promise(resolve => {
  const child = execFile(bin, args, {timeout, maxBuffer: 1024 * 1024}, (error, stdout, stderr) =>
    resolve({ok: !error, output: stdout.trim(), error: error ? (error.code === 'ENOENT' ? 'Not installed' : stderr.trim() || error.message) : undefined}));
  child.stdin?.on('error', () => {});
  child.stdin?.end(input ?? '');
});

/** Failed-attempt bookkeeping; `now` is injectable for tests. */
export function createLimiter({max = MAX_FAILURES, window = WINDOW, lockout = LOCKOUT} = {}) {
  let failures = [], lockedUntil = 0;
  return {
    retryAfter(now = Date.now()) { return lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0; },
    fail(now = Date.now()) {
      failures = [...failures.filter(t => now - t < window), now];
      if (failures.length >= max) { lockedUntil = now + lockout; failures = []; return 0; }
      return max - failures.length;
    },
    reset() { failures = []; lockedUntil = 0; },
  };
}
// One limiter for every password-confirmed action, so guesses cannot be spread across features.
const limiter = createLimiter();
export const passwordRetryAfter = () => limiter.retryAfter();
// Password checks run one at a time: the lockout is checked and a failure counted (after its delay) before the next
// attempt starts, so parallel requests cannot all slip past the limit together.
let gate = Promise.resolve();
const exclusive = fn => { const run = gate.then(fn); gate = run.catch(() => {}); return run; };

const CHKPWD = ['/usr/sbin/unix_chkpwd', '/sbin/unix_chkpwd'];
/**
 * Checks the Homebase account's own login password without root: PAM's unix_chkpwd is setgid shadow and lets an
 * account verify its own password (the same check a screen locker makes). Throws a user-facing error on failure.
 */
export function verifyOwnPassword(password, {chkpwd = CHKPWD.find(p => existsSync(p)), user = os.userInfo().username, delay = 2000} = {}) {
  if (typeof password !== 'string' || !password || password.length > 512 || password.includes('\0')) return Promise.reject(Error('Enter the server account password'));
  return exclusive(() => checkPassword(password, chkpwd, user, delay));
}
async function checkPassword(password, chkpwd, user, delay) {
  const wait = limiter.retryAfter();
  if (wait) throw Error(`Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.`);
  if (!chkpwd) throw Error('Password check is unavailable (unix_chkpwd not found)');
  const result = await exec(chkpwd, [user, 'nonull'], {input: password + '\0', timeout: 20000});
  if (!result.ok) {
    await new Promise(r => setTimeout(r, delay)); // slow down guessing
    const left = limiter.fail();
    throw Error(left > 0 ? `Incorrect password (${left} attempt${left === 1 ? '' : 's'} left)` : 'Incorrect password. Locked for 15 min.');
  }
  limiter.reset();
}

export async function getMachine() {
  const sudo = await exec('sudo', ['-n', '-l']); // lists rules only; runs nothing
  return {control: sudo.output.includes(`${config.powerHelper} machine`), setupCommand: config.setupCommand, retryAfter: limiter.retryAfter()};
}

export async function machineAction(action, password) {
  if (!MACHINE_ACTIONS.includes(action)) throw Error('Unsupported action');
  if (typeof password !== 'string' || !password || password.length > 512 || password.includes('\0')) throw Error('Enter the server account password');
  return exclusive(() => runMachine(action, password));
}
async function runMachine(action, password) {
  const wait = limiter.retryAfter();
  if (wait) throw Error(`Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.`);
  if (!(await getMachine()).control) throw Error('Reboot and power off need the updated admin setup. Run: ' + config.setupCommand);
  const result = await exec('sudo', ['-n', config.powerHelper, 'machine', action], {input: password, timeout: 30000});
  if (!result.ok) {
    if (/incorrect password/i.test(result.error || '')) {
      const left = limiter.fail();
      throw Error(left > 0 ? `Incorrect password (${left} attempt${left === 1 ? '' : 's'} left)` : 'Incorrect password. Locked for 15 min.');
    }
    throw Error(result.error || `Could not ${action}`);
  }
  limiter.reset();
  return {output: action === 'reboot' ? 'Restarting in a few seconds. The dashboard comes back when the server is up.' : 'Powering off in a few seconds.'};
}
