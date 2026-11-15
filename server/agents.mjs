// The AI agents the dashboard knows about, in display order. One registry drives detection, process
// matching, feature detection and the allowlisted start/stop actions.
//   bins     executables to look for on PATH, first match wins (`agy` is the Antigravity CLI, `antigravity` its IDE)
//   comm     matches /proc/<pid>/comm (≤15 chars), i.e. the process name `ps -o comm` prints
//   launch   true when "Start in tmux" makes sense (an interactive terminal agent)
import {access, constants} from 'node:fs/promises';
import {delimiter, join} from 'node:path';

export const AGENTS = [
  {name: 'claude', label: 'Claude Code', bins: ['claude'], comm: /claude/i, launch: true},
  {name: 'codex', label: 'Codex', bins: ['codex'], comm: /codex/i, launch: true},
  {name: 'antigravity', label: 'Antigravity', bins: ['agy', 'antigravity'], comm: /^(agy|antigravity)$/i, launch: true},
  {name: 'ollama', label: 'Ollama', bins: ['ollama'], comm: /ollama/i, launch: false},
];

export const agentByName = name => AGENTS.find(a => a.name === name);
export const LAUNCHABLE = AGENTS.filter(a => a.launch).map(a => a.name);

/** First executable named `bin` on PATH, or null. In-process, so no `which` child per tool per poll. */
export async function findOnPath(bin, path = process.env.PATH || '') {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, bin);
    try { await access(file, constants.X_OK); return file; } catch { /* not here */ }
  }
  return null;
}

// Installs change rarely; re-scan PATH at most once a minute.
const TTL = 60000;
let cache = {at: 0, value: null};
/** {tool: absolutePath|null} for every agent binary plus the extra tools given. */
export async function locateTools(extra = []) {
  if (cache.value && Date.now() - cache.at < TTL) return cache.value;
  const names = [...new Set([...AGENTS.flatMap(a => a.bins), ...extra])];
  const found = await Promise.all(names.map(n => findOnPath(n)));
  cache = {at: Date.now(), value: Object.fromEntries(names.map((n, i) => [n, found[i]]))};
  return cache.value;
}
export const forgetTools = () => { cache = {at: 0, value: null}; };

/** Path of the agent's first installed binary. */
export const agentBinary = (agent, tools) => agent.bins.map(b => tools[b]).find(Boolean) || null;

/** Snapshot entries: installed flag and the processes that belong to each agent. */
export function agentSnapshot(processes, tools) {
  return AGENTS.map(a => ({name: a.name, installed: !!agentBinary(a, tools), processes: processes.filter(p => a.comm.test(p.name))}));
}
