// Machine-specific settings live outside the package so the same build installs on any Linux host.
// File: $HOMEBASE_CONFIG, else $XDG_CONFIG_HOME/homebase/config.json, else ~/.config/homebase/config.json.
// Environment variables HOMEBASE_PORT, HOMEBASE_TAILSCALE_ORIGIN and HOMEBASE_TAILSCALE_LOGIN override the file.
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const expand = p => (typeof p === 'string' && p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
export const CONFIG_PATH = process.env.HOMEBASE_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'homebase', 'config.json');

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error(`Homebase: ignoring unreadable config ${CONFIG_PATH}: ${e.message}`);
    return {};
  }
}

const file = readConfig();
const port = Number(process.env.HOMEBASE_PORT || file.port) || 8787;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid Homebase port: ' + port);

/** Display metadata and health probes for systemd units, keyed "user:<unit>" or "system:<unit>". */
// Order follows the config file (it is the display order); built-in defaults fill in missing fields and entries.
const defaults = {
  'user:homebase.service': {name: 'Homebase', description: 'Your server dashboard'},
  'system:ollama.service': {name: 'Ollama', description: 'Local model server', port: 11434},
};
const services = {};
for (const [id, entry] of Object.entries(file.services && typeof file.services === 'object' ? file.services : {})) {
  if (/^(user|system):[A-Za-z0-9][A-Za-z0-9_.-]*\.service$/.test(id) && entry && typeof entry === 'object') services[id] = {...defaults[id], ...entry};
}
for (const [id, entry] of Object.entries(defaults)) services[id] ??= {...entry};
services['user:homebase.service'].port = port;
for (const s of Object.values(services)) {
  if (s.port && !s.url && s.probe !== 'tcp') s.url = `http://127.0.0.1:${s.port}`;
}

const SITE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/, PREFIX = /^[A-Za-z0-9._-]{1,60}$/;
const sites = (Array.isArray(file.traffic?.sites) ? file.traffic.sites : [])
  .filter(s => s && SITE_ID.test(s.id) && PREFIX.test(s.prefix || ''))
  .map(s => ({id: s.id, name: String(s.name || s.id), unit: s.unit, port: Number(s.port) || null, prefix: s.prefix}));

export const config = Object.freeze({
  port,
  configPath: CONFIG_PATH.startsWith(home + '/') ? '~' + CONFIG_PATH.slice(home.length) : CONFIG_PATH,
  tailscale: {
    origin: process.env.HOMEBASE_TAILSCALE_ORIGIN || file.tailscale?.origin || undefined,
    login: process.env.HOMEBASE_TAILSCALE_LOGIN || file.tailscale?.login || undefined,
  },
  services,
  /** Units hidden from the hosted-services list (prefix match). */
  hiddenUnits: ['server-night-sleep', 'snap.', ...(Array.isArray(file.hiddenUnits) ? file.hiddenUnits : [])],
  traffic: {
    sites,
    logDir: expand(file.traffic?.logDir) || path.join(home, '.local/state/homebase-sites'),
    controlFile: expand(file.traffic?.controlFile) || path.join(home, '.config/homebase/access-control.json'),
  },
  powerHelper: '/usr/local/sbin/homebase-power',
  setupCommand: `sudo python3 ${path.join(ROOT, 'system', 'install-power.py')} --user ${os.userInfo().username}`,
});
