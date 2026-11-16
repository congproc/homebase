// Getting space back the safe way: (1) each package tool's own cleanup, measured first, and (2) a ranked list of
// things worth reviewing, from the last usage scan. Nothing here deletes a path chosen by the client: every action is
// a fixed command (or the Ollama API for one model the server itself listed). Root-only ones go through the
// fixed-purpose helper (`homebase-power cleanup apt|snaps|journal <size>`), or are offered as a command to copy.
import {execFile} from 'node:child_process';
import {lstat, readdir, readlink, statfs} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {findOnPath} from './agents.mjs';

const HELPER = '/usr/local/sbin/homebase-power';
const HOME = os.homedir();
const MB = 1024 ** 2;
export const JOURNAL_KEEP = '500M';
const JOURNAL_KEEP_BYTES = 500 * MB;

const exec = (bin, args, {timeout = 15000, input} = {}) => new Promise(resolve => {
  const child = execFile(bin, args, {timeout, maxBuffer: 8 * 1024 * 1024}, (error, stdout, stderr) =>
    resolve({ok: !error, stdout: stdout || '', stderr: (stderr || '').trim(), code: error?.code}));
  if (input != null) child.stdin.end(input); else child.stdin?.end();
});

/** "1000.3M", "1.2G", "189.2MB", "512kB" → bytes. Binary for journalctl's single letters, decimal for docker's "MB". */
export function parseSize(text) {
  const m = /([\d.]+)\s*([KMGTP]?)(i?B)?/i.exec(String(text).trim());
  if (!m) return 0;
  const n = Number(m[1]), unit = m[2].toUpperCase(), suffix = m[3];
  const pow = {'': 0, K: 1, M: 2, G: 3, T: 4, P: 5}[unit];
  const base = suffix && suffix.toUpperCase() === 'B' ? 1000 : 1024;
  return Math.round(n * base ** pow);
}

/** `snap list --all` → disabled revisions (same rule as the helper's). */
export function disabledSnaps(listing) {
  return listing.split('\n').slice(1).map(l => l.trim().split(/\s+/))
    .filter(f => f.length >= 6 && f.at(-1).split(',').includes('disabled') && /^[a-z0-9][a-z0-9-]{0,39}$/.test(f[0]) && /^x?\d{1,10}$/.test(f[2]))
    .map(f => ({name: f[0], rev: f[2]}));
}

const allocated = p => lstat(p).then(s => s.blocks * 512, () => 0);
async function du(p) {
  const r = await exec('du', ['-sx', '-B1', '--', p], {timeout: 20000});
  return r.stdout ? Number(r.stdout.split(/\s/)[0]) || 0 : 0;
}

// sudo -n -l lists what the sudoers rule allows; a refused sudo would be logged as an auth failure, so ask first.
let rootCheck = {at: 0, ok: false};
async function rootCleanupAllowed() {
  if (Date.now() - rootCheck.at < 60000) return rootCheck.ok;
  const r = await exec('sudo', ['-n', '-l'], {timeout: 6000});
  rootCheck = {at: Date.now(), ok: r.ok && r.stdout.includes(`${HELPER} cleanup`)};
  return rootCheck.ok;
}

/**
 * The tool cleanups. Each: id, label, what it does, `command` (what a person would type), `root`, `measure()` →
 * {bytes, detail} or null when it does not apply here, and `run(arg)`.
 */
export function createTools({ollama = 'http://127.0.0.1:11434', home = HOME} = {}) {
  const viaHelper = (...args) => async () => {
    const r = await exec('sudo', ['-n', HELPER, 'cleanup', ...args], {timeout: 600000});
    if (!r.ok) throw Error(r.stderr.split('\n').pop() || 'Cleanup failed');
    return JSON.parse(r.stdout).done.join('\n');
  };
  const userTool = (bin, args) => async () => {
    const binary = await findOnPath(bin, `${process.env.PATH || ''}:${path.join(home, '.local/bin')}`);
    if (!binary) throw Error(`${bin} is not installed`);
    const r = await exec(binary, args, {timeout: 600000});
    if (!r.ok) throw Error(r.stderr.split('\n').pop() || `${bin} failed`);
    return (r.stdout.trim() || r.stderr).split('\n').slice(-3).join('\n');
  };
  const dockerDf = async () => {
    const r = await exec('docker', ['system', 'df', '--format', '{{json .}}'], {timeout: 20000});
    if (!r.ok) return null;
    return Object.fromEntries(r.stdout.trim().split('\n').filter(Boolean).map(l => { const j = JSON.parse(l); return [j.Type, {reclaimable: parseSize(j.Reclaimable), count: Number(j.TotalCount) || 0}]; }));
  };

  return [
    {id: 'apt', label: 'Clean the APT package cache', category: 'apt-cache', root: true, command: 'sudo apt clean',
      about: 'Deletes downloaded .deb files. apt downloads them again if they are ever needed.',
      measure: async () => {
        const dir = '/var/cache/apt/archives';
        const names = (await readdir(dir).catch(() => null));
        if (!names) return null;
        const debs = names.filter(n => n.endsWith('.deb'));
        const bytes = (await Promise.all(debs.map(n => allocated(path.join(dir, n))))).reduce((a, b) => a + b, 0)
          + (await Promise.all(['pkgcache.bin', 'srcpkgcache.bin'].map(n => allocated(path.join('/var/cache/apt', n))))).reduce((a, b) => a + b, 0);
        return {bytes, detail: debs.length ? `${debs.length} downloaded package${debs.length === 1 ? '' : 's'} and apt’s index cache` : 'apt’s package index cache'};
      }, run: viaHelper('apt')},
    {id: 'journal', label: `Shrink the system journal to ${JOURNAL_KEEP}`, category: 'journal', root: true, command: `sudo journalctl --vacuum-size=${JOURNAL_KEEP}`,
      about: 'Deletes the oldest archived log entries. Recent logs are kept.',
      measure: async () => {
        const r = await exec('journalctl', ['--disk-usage']);
        const m = /take up ([\d.]+\s*[KMGTP]?)/i.exec(r.stdout + r.stderr);
        if (!m) return null;
        const used = parseSize(m[1]);
        return {bytes: Math.max(0, used - JOURNAL_KEEP_BYTES), detail: `Journal uses ${(used / MB).toFixed(0)} MB`};
      }, run: viaHelper('journal', JOURNAL_KEEP)},
    {id: 'snaps', label: 'Remove disabled snap revisions', category: 'snaps', root: true, command: 'sudo snap remove <name> --revision <rev>  # for each disabled revision in `snap list --all`',
      about: 'Snap keeps the previous version of each app for rollback. Removing it gives up that rollback.',
      measure: async () => {
        const r = await exec('snap', ['list', '--all']);
        if (!r.ok) return null;
        const list = disabledSnaps(r.stdout);
        const bytes = (await Promise.all(list.map(s => allocated(`/var/lib/snapd/snaps/${s.name}_${s.rev}.snap`)))).reduce((a, b) => a + b, 0);
        return {bytes, detail: list.length ? list.map(s => `${s.name} ${s.rev}`).join(', ') : 'No disabled revisions'};
      }, run: viaHelper('snaps')},
    {id: 'docker-build', label: 'Remove Docker build cache', category: 'containers', root: false, command: 'docker builder prune -af',
      about: 'Deletes cached build layers. The next image build is slower.',
      measure: async () => { const df = await dockerDf(); return df?.['Build Cache'] ? {bytes: df['Build Cache'].reclaimable, detail: `${df['Build Cache'].count} cache entries`} : null; },
      run: userTool('docker', ['builder', 'prune', '-af'])},
    {id: 'docker-images', label: 'Remove unused Docker images', category: 'containers', root: false, command: 'docker image prune -af',
      about: 'Deletes images no container uses, including stopped containers’ images being kept around. They are pulled again when needed.',
      measure: async () => { const df = await dockerDf(); return df?.Images ? {bytes: df.Images.reclaimable, detail: `${df.Images.count} images`} : null; },
      run: userTool('docker', ['image', 'prune', '-af'])},
    {id: 'pip', label: 'Clear the pip download cache', category: 'pkg-cache', root: false, command: 'pip cache purge',
      about: 'Deletes cached Python packages. pip downloads them again when needed.',
      measure: async () => { const p = path.join(home, '.cache/pip'); return (await lstat(p).catch(() => null)) ? {bytes: await du(p), detail: p} : null; },
      run: userTool('pip3', ['cache', 'purge'])},
    {id: 'npm', label: 'Clear the npm cache', category: 'pkg-cache', root: false, command: 'npm cache clean --force',
      about: 'Deletes cached npm packages. npm downloads them again when needed.',
      measure: async () => { const p = path.join(home, '.npm/_cacache'); return (await lstat(p).catch(() => null)) ? {bytes: await du(p), detail: p} : null; },
      run: userTool('npm', ['cache', 'clean', '--force'])},
    {id: 'trash', label: 'Empty the trash', category: 'trash', root: false, command: 'gio trash --empty',
      about: 'Permanently deletes what is already in your trash.',
      measure: async () => { const p = path.join(home, '.local/share/Trash'); return (await lstat(p).catch(() => null)) ? {bytes: await du(p), detail: p} : null; },
      run: userTool('gio', ['trash', '--empty'])},
    {id: 'ollama', label: 'Remove an Ollama model', category: 'models', root: false, command: 'ollama rm <model>', perItem: true,
      about: 'Deletes a downloaded model. Layers shared with other models stay. `ollama pull` gets it back.',
      measure: async () => {
        const r = await fetch(`${ollama}/api/tags`, {signal: AbortSignal.timeout(3000)}).then(x => x.ok ? x.json() : null).catch(() => null);
        if (!r) return null;
        const models = (r.models || []).map(m => ({name: String(m.name), bytes: Number(m.size) || 0, modified: Date.parse(m.modified_at) || null}));
        return {bytes: models.reduce((a, m) => a + m.bytes, 0), detail: `${models.length} model${models.length === 1 ? '' : 's'}`, items: models};
      },
      run: async model => {
        // Only a model the server itself just listed: the name is never trusted from the request alone.
        const r = await fetch(`${ollama}/api/tags`, {signal: AbortSignal.timeout(3000)}).then(x => x.json());
        if (!(r.models || []).some(m => m.name === model)) throw Error('Unknown model');
        const del = await fetch(`${ollama}/api/delete`, {method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model}), signal: AbortSignal.timeout(60000)});
        if (!del.ok) throw Error(`Ollama refused: ${(await del.text()).slice(0, 200)}`);
        return `Removed ${model}`;
      }},
  ];
}

export {ageFactor, toolFor, findCandidates} from './candidates.mjs';

/** Paths the dashboard user's processes have open (one /proc pass for all candidates). */
export async function openPaths(proc = '/proc') {
  const out = [];
  for (const pid of (await readdir(proc).catch(() => [])).filter(p => /^\d+$/.test(p))) {
    const fds = await readdir(path.join(proc, pid, 'fd')).catch(() => []);
    for (const fd of fds) { const l = await readlink(path.join(proc, pid, 'fd', fd)).catch(() => null); if (l?.startsWith('/')) out.push(l.replace(/ \(deleted\)$/, '')); }
  }
  return out;
}

/** Bytes used on the filesystem holding `p`, for before/after comparisons. */
export const usedOn = p => statfs(p).then(s => (s.blocks - s.bfree) * s.bsize, () => null);

export function createCleanup({tools = createTools(), record = () => {}, rootAllowed = rootCleanupAllowed} = {}) {
  let measured = {at: 0, value: null}, running = null;
  async function measureAll(force = false) {
    // Measuring spawns du, docker, snap and journalctl: reuse it for a few minutes ("Measure again" forces it).
    if (!force && measured.value && Date.now() - measured.at < 5 * 60000) return measured.value;
    const canRoot = await rootAllowed();
    const value = await Promise.all(tools.map(async t => {
      const m = await t.measure().catch(() => null);
      return {id: t.id, label: t.label, about: t.about, command: t.command, root: t.root, category: t.category, perItem: !!t.perItem,
        available: !!m, runnable: !!m && (!t.root || canRoot), bytes: m?.bytes ?? 0, detail: m?.detail ?? null, items: m?.items};
    }));
    measured = {at: Date.now(), value};
    return value;
  }

  async function run(id, arg) {
    const tool = tools.find(t => t.id === id);
    if (!tool) throw Error('Unknown cleanup');
    if (tool.perItem ? typeof arg !== 'string' || !arg || arg.length > 200 : arg !== undefined && arg !== null) throw Error('Invalid cleanup target');
    if (tool.root && !(await rootAllowed())) throw Error('Run the administrator setup again to allow this from the dashboard, or copy the command');
    if (running) throw Error(`Another cleanup is running (${running})`);
    running = tool.label;
    const probe = id === 'apt' || id === 'journal' || id === 'snaps' ? '/var' : id === 'ollama' ? '/usr/share/ollama' : HOME;
    const before = await usedOn(probe);
    try {
      const output = await tool.run(arg ?? undefined);
      const after = await usedOn(probe);
      const freed = before != null && after != null ? Math.max(0, before - after) : null;
      record(`Cleanup: ${tool.label}${arg ? ` (${arg})` : ''}${freed != null ? ` freed ${(freed / MB).toFixed(0)} MB` : ''}`);
      measured = {at: 0, value: null};
      return {output, freed};
    } finally { running = null; }
  }
  return {measureAll, run};
}
