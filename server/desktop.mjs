// Graphical desktop (display manager) status and on/off. Reading needs no root; switching goes through the
// root helper's `desktop on|off`, which also sets the boot target so the choice survives a reboot.
import {execFile} from 'node:child_process';
import os from 'node:os';
import {config} from './config.mjs';

const exec = (bin, args, timeout = 10000) => new Promise(resolve => {
  execFile(bin, args, {timeout, maxBuffer: 1024 * 1024}, (error, stdout, stderr) =>
    resolve({ok: !error, output: stdout.trim(), error: error ? (error.code === 'ENOENT' ? 'Not installed' : stderr.trim() || error.message) : undefined}));
});
const GRAPHICAL = new Set(['wayland', 'x11', 'mir']);
const bytes = v => /^\d+$/.test(v || '') ? Number(v) : 0;

export function props(text = '') {
  return Object.fromEntries(text.split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
}

/** Desktop apps are scopes in the user manager; tmux sessions started by Homebase keep running without a desktop. */
export const desktopScope = unit => /\.scope$/.test(unit) && !unit.startsWith('homebase-tmux-') && !unit.startsWith('init.scope');

/** Sum memory of the display manager, graphical login sessions and (for our own account) desktop session + apps. */
export async function getDesktop() {
  const [dm, def, sessions, sudo] = await Promise.all([
    exec('systemctl', ['show', 'display-manager.service', '--property=Id', '--property=LoadState', '--property=ActiveState', '--property=MemoryCurrent']),
    exec('systemctl', ['get-default']),
    exec('loginctl', ['list-sessions', '--no-legend']),
    exec('sudo', ['-n', '-l']), // lists rules only; runs nothing
  ]);
  const p = props(dm.output);
  const installed = p.LoadState === 'loaded';
  const ids = sessions.output.split('\n').map(l => l.trim().split(/\s+/)[0]).filter(id => /^[A-Za-z0-9]+$/.test(id || ''));
  const info = await Promise.all(ids.map(id => exec('loginctl', ['show-session', id, '--property=Type', '--property=Scope', '--property=Name', '--property=Active']).then(r => props(r.output))));
  const graphical = info.filter(s => GRAPHICAL.has(s.Type));
  let memory = bytes(p.MemoryCurrent);
  const scopes = await Promise.all(graphical.filter(s => s.Scope).map(s => exec('systemctl', ['show', s.Scope, '--property=MemoryCurrent', '--value'])));
  memory += scopes.reduce((a, r) => a + bytes(r.output), 0);
  const me = os.userInfo().username;
  if (graphical.some(s => s.Name === me)) {
    const session = await exec('systemctl', ['--user', 'show', 'session.slice', '--property=MemoryCurrent', '--value']);
    memory += bytes(session.output);
    const apps = (await exec('systemctl', ['--user', 'list-units', '--type=scope', '--state=running', '--no-legend', '--plain'])).output
      .split('\n').map(l => l.trim().split(/\s+/)[0]).filter(desktopScope);
    const used = await Promise.all(apps.map(u => exec('systemctl', ['--user', 'show', u, '--property=MemoryCurrent', '--value'])));
    memory += used.reduce((a, r) => a + bytes(r.output), 0);
  }
  return {
    installed, manager: p.Id || null, running: p.ActiveState === 'active', state: p.ActiveState || 'unknown',
    bootDefault: def.output || 'unknown', bootsToDesktop: def.output === 'graphical.target',
    sessions: graphical.map(s => ({user: s.Name, type: s.Type, active: s.Active === 'yes'})),
    memory: p.ActiveState === 'active' ? memory : null,
    control: sudo.output.includes(`${config.powerHelper} desktop`), setupCommand: config.setupCommand,
  };
}

export async function desktopAction(action) {
  if (!['on', 'off'].includes(action)) throw Error('Unsupported desktop action');
  const state = await getDesktop();
  if (!state.installed) throw Error('No desktop (display manager) is installed on this machine');
  if (!state.control) throw Error('Turning the desktop on or off needs the updated admin setup. Run: ' + config.setupCommand);
  const result = await exec('sudo', ['-n', config.powerHelper, 'desktop', action], 120000);
  if (!result.ok) throw Error(result.error || `Could not turn the desktop ${action}`);
  return {output: action === 'off' ? 'Desktop turned off; the server boots without it from now on' : 'Desktop is starting; the server boots to it from now on', desktop: await getDesktop()};
}
