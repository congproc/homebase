// Fixed-purpose control actions for tmux sessions, hosted services, and AI agents.
// Every action is validated against current inventory; arguments are passed as arrays (no shell).
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import {getPowerState} from './services.mjs';
import {config} from './config.mjs';

const exec = (bin, args, timeout = 30000) => new Promise(resolve => {
  execFile(bin, args, {timeout, maxBuffer: 1024 * 1024}, (error, stdout, stderr) =>
    resolve({ok: !error, output: stdout.trim(), error: error ? (error.code === 'ENOENT' ? 'Not installed' : stderr.trim() || error.message) : undefined}));
});

export const SESSION_NAME = /^[a-zA-Z0-9_-]{1,40}$/;
const HELPER = config.powerHelper;
const SELF = 'user:homebase.service';
const AGENT_COMMANDS = {claude: 'claude', codex: 'codex'};

/**
 * Start a detached tmux session in its own systemd scope so it survives
 * Homebase restarts (otherwise the tmux server shares the dashboard's cgroup).
 */
export async function tmuxNew(name, command) {
  const args = ['new-session', '-d', '-s', name, '-c', os.homedir(), ...(command ? [command] : [])];
  const scoped = await exec('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit', `homebase-tmux-${name}-${Date.now()}`, 'tmux', ...args]);
  if (scoped.ok) return scoped;
  if (/duplicate session/i.test(scoped.error || '')) return scoped;
  return exec('tmux', args);
}

export const tmuxKill = name => exec('tmux', ['kill-session', '-t', `=${name}`]);

export async function serviceAction(id, action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw Error('Unsupported service action');
  const power = await getPowerState(true);
  const service = power.services.find(s => s.id === id);
  if (!service) throw Error('Unknown hosted service');
  if (service.manual) throw Error('This service is not managed by systemd');
  if (id === SELF && action === 'stop') throw Error('Stopping Homebase would shut down this dashboard. Use restart instead.');
  let result;
  if (service.scope === 'user') {
    // Restarting ourselves must not wait for the job, or the request dies with the process.
    // Don't wait on ourselves (the request would die) or on oneshot jobs (they block until finished).
    const noBlock = id === SELF || service.type === 'oneshot';
    result = await exec('systemctl', ['--user', ...(noBlock ? ['--no-block'] : []), action, service.unit]);
  } else {
    result = await exec('sudo', ['-n', HELPER, 'service', action, service.unit], 45000);
    if (!result.ok && /password|authentication|not allowed|may not run/i.test(result.error || '')) {
      throw Error('System services need the admin setup. Run: ' + config.setupCommand);
    }
  }
  if (!result.ok) throw Error(result.error || `Could not ${action} ${service.unit}`);
  await getPowerState(true); // refresh cache so the UI sees the new state
  return {output: service.type === 'oneshot' && action === 'start' ? `${service.name}: run started` : `${service.name}: ${action} requested`};
}

const commOf = pid => readFile(`/proc/${pid}/comm`, 'utf8').then(s => s.trim()).catch(() => null);

/** Terminate agent processes (SIGTERM). `pid` limits it to one process of that agent. */
export async function stopAgent(snapshot, name, pid) {
  const agent = snapshot.agents.find(a => a.name === name);
  if (!agent || !AGENT_COMMANDS[name]) throw Error('Unknown agent');
  const targets = pid === undefined ? agent.processes : agent.processes.filter(p => p.pid === pid);
  if (!targets.length) throw Error('No matching running process');
  let stopped = 0;
  for (const p of targets) {
    const comm = await commOf(p.pid);
    if (!comm || !comm.toLowerCase().includes(name)) continue; // exited or PID reused
    try { process.kill(p.pid, 'SIGTERM'); stopped++; } catch { /* already gone or not ours */ }
  }
  if (!stopped) throw Error('Process already exited');
  return {output: `Sent stop signal to ${stopped} ${name} process${stopped === 1 ? '' : 'es'}`};
}

/** Launch an agent inside a new tmux session named after it (claude, claude-2, …). */
export async function startAgent(snapshot, name) {
  const command = AGENT_COMMANDS[name];
  if (!command) throw Error('Unknown agent');
  const which = await exec('which', [command]);
  if (!which.ok || !which.output.startsWith('/')) throw Error(`${name} is not installed`);
  const taken = new Set(snapshot.sessions.items.map(s => s.name));
  let session = name;
  for (let i = 2; taken.has(session); i++) session = `${name}-${i}`;
  const result = await tmuxNew(session, which.output);
  if (!result.ok) throw Error(result.error || `Could not start ${name}`);
  return {output: session, session};
}
