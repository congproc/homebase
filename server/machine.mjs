// Reboot / power off the whole machine. The root helper checks the account's login password itself (the sudo
// rule needs none), so Homebase only forwards it on stdin: it is never logged, stored or put on a command line.
// Repeated wrong passwords lock the buttons for a while, on top of the helper's own delay per failure.
import {execFile} from 'node:child_process';
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
const limiter = createLimiter();

export async function getMachine() {
  const sudo = await exec('sudo', ['-n', '-l']); // lists rules only; runs nothing
  return {control: sudo.output.includes(`${config.powerHelper} machine`), setupCommand: config.setupCommand, retryAfter: limiter.retryAfter()};
}

export async function machineAction(action, password) {
  if (!MACHINE_ACTIONS.includes(action)) throw Error('Unsupported action');
  if (typeof password !== 'string' || !password || password.length > 512 || password.includes('\0')) throw Error('Enter the server account password');
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
