// In-app updates from the project's GitHub releases.
// Check: GitHub "latest release" API (startup + every 12 h unless config "updates.check" is false, or on demand).
// Apply: download the release tarball + .sha256 from that fixed repository, verify, extract, then run the release's
// install.sh in a transient systemd user unit — outside homebase.service's cgroup, so the restart it performs does not
// kill the installer. Source checkouts (installed with --in-place) are never touched: they update with git.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {ROOT, config} from './config.mjs';
const exec = promisify(execFile);

export const REPO = 'congproc/homebase';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY = 12 * 60 * 60 * 1000;
const STATE_DIR = path.join(os.homedir(), '.local/state/homebase');
const LOG = path.join(STATE_DIR, 'update.log');
const WORK = path.join(os.homedir(), '.cache/homebase-update');
// Files system/install-power.py copies verbatim into place (source in system/ → installed path).
const ROOT_FILES = [
  ['homebase-power', '/usr/local/sbin/homebase-power'],
  ['server-smart-sleep', '/usr/local/sbin/server-smart-sleep'],
  ['server-night-sleep', '/usr/local/sbin/server-night-sleep'],
  ['server-night-sleep.service', '/etc/systemd/system/server-night-sleep.service'],
  ['server-night-sleep.timer', '/etc/systemd/system/server-night-sleep.timer'],
];

export const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Same rule uninstall.sh uses: a copied install has no sources or lockfile next to it.
export const SOURCE_CHECKOUT = existsSync(path.join(ROOT, 'src')) || existsSync(path.join(ROOT, 'package-lock.json'));

export function compareVersions(a, b) {
  const p = v => String(v).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

let latest = null, checkedAt = 0, checkError = null, checking = null;
let job = null; // {state: 'downloading'|'installing'|'failed', version, at, error?}

async function fetchLatest() {
  const r = await fetch(API, {headers: {Accept: 'application/vnd.github+json', 'User-Agent': `homebase/${VERSION}`}, signal: AbortSignal.timeout(10000)});
  if (r.status === 403 || r.status === 429) throw Error('GitHub rate limit reached; try again later');
  if (!r.ok) throw Error(`GitHub answered ${r.status}`);
  const j = await r.json();
  const version = String(j.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Unexpected release tag ' + j.tag_name);
  const asset = name => (j.assets || []).find(a => a.name === name)?.browser_download_url;
  return {version, tag: j.tag_name, name: j.name || j.tag_name, notes: String(j.body || '').slice(0, 4000), url: j.html_url, publishedAt: j.published_at,
    tarball: asset(`homebase-${version}.tar.gz`), checksum: asset(`homebase-${version}.tar.gz.sha256`)};
}

export function checkForUpdate(force = false) {
  if (!force && Date.now() - checkedAt < CHECK_EVERY) return Promise.resolve();
  checking ??= fetchLatest().then(l => { latest = l; checkError = null; }, e => { checkError = e.name === 'TimeoutError' ? 'GitHub did not answer' : e.message; })
    .finally(() => { checkedAt = Date.now(); checking = null; });
  return checking;
}

async function rootIntegration() {
  if (!existsSync('/usr/local/sbin/homebase-power')) return {installed: false, outdated: []};
  const outdated = [];
  for (const [src, dest] of ROOT_FILES) {
    const [a, b] = await Promise.all([readFile(path.join(ROOT, 'system', src)).catch(() => null), readFile(dest).catch(() => null)]);
    if (a && (!b || !a.equals(b))) outdated.push(src);
  }
  return {installed: true, outdated, command: config.setupCommand};
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'); // colour codes from install.sh
async function logTail() {
  const s = await readFile(LOG, 'utf8').catch(() => '');
  return s.replace(ANSI, '').trim().split('\n').slice(-15).join('\n');
}

export const updateAvailable = () => !!latest && compareVersions(latest.version, VERSION) > 0 && !!latest.tarball && !!latest.checksum;

export async function updateStatus() {
  if (job?.state === 'installing') {
    const log = await logTail();
    const exit = log.match(/^homebase-update-exit=(\d+)$/m);
    if (exit && exit[1] !== '0') job = {...job, state: 'failed', error: 'The installer failed; the previous version is still running.'};
    else if (Date.now() - job.at > 5 * 60 * 1000) job = {...job, state: 'failed', error: 'The update did not finish within 5 minutes.'};
  }
  return {
    current: VERSION, repo: REPO, sourceCheckout: SOURCE_CHECKOUT, autoCheck: config.updates.check,
    latest: latest && {version: latest.version, name: latest.name, notes: latest.notes, url: latest.url, publishedAt: latest.publishedAt},
    available: updateAvailable(),
    checkedAt: checkedAt || null, error: checkError,
    job: job && {...job, log: job.state === 'failed' || job.state === 'installing' ? await logTail() : undefined},
    rootIntegration: await rootIntegration(),
  };
}

async function download(url, file) {
  const r = await fetch(url, {headers: {'User-Agent': `homebase/${VERSION}`}, signal: AbortSignal.timeout(120000)});
  if (!r.ok) throw Error(`Download failed (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 50 * 1024 * 1024) throw Error('Download is unexpectedly large');
  await writeFile(file, buf);
  return buf;
}

export async function applyUpdate() {
  if (SOURCE_CHECKOUT) throw Error('This is a source checkout; update it with git pull && ./install.sh --in-place');
  if (job && job.state !== 'failed') throw Error('An update is already in progress');
  await checkForUpdate(true);
  if (!latest) throw Error(checkError || 'Could not reach GitHub');
  if (compareVersions(latest.version, VERSION) <= 0) throw Error(`Already on the latest version (${VERSION})`);
  if (!latest.tarball || !latest.checksum) throw Error('The release has no installable package');
  const {version} = latest, name = `homebase-${version}`;
  job = {state: 'downloading', version, at: Date.now()};
  try {
    const dir = path.join(WORK, version);
    await rm(dir, {recursive: true, force: true});
    await mkdir(dir, {recursive: true, mode: 0o700});
    await mkdir(STATE_DIR, {recursive: true, mode: 0o700});
    const tar = path.join(dir, `${name}.tar.gz`);
    const [buf, sums] = await Promise.all([download(latest.tarball, tar), download(latest.checksum, tar + '.sha256').then(b => b.toString('utf8'))]);
    const expected = sums.match(/^([0-9a-f]{64})\s/m)?.[1];
    if (!expected || createHash('sha256').update(buf).digest('hex') !== expected) throw Error('Checksum mismatch — the download was not installed');
    await exec('tar', ['xzf', tar, '-C', dir], {timeout: 60000});
    const installer = path.join(dir, name, 'install.sh');
    if (!existsSync(installer)) throw Error('The package has no installer');
    await writeFile(LOG, `Updating Homebase ${VERSION} → ${version} at ${new Date().toISOString()}\n`, {mode: 0o600});
    // Fixed argv, no user input: paths are ours, the script comes from the checksum-verified release.
    const script = 'exec >>"$1" 2>&1; HOMEBASE_NODE="$2" HOMEBASE_PREFIX="$3" bash "$4"; code=$?; echo "homebase-update-exit=$code"; rm -rf "$5"; exit $code';
    // The transient unit starts from the user manager's environment, not ours: carry over where settings live.
    const env = process.env.XDG_CONFIG_HOME ? [`--setenv=XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`] : [];
    await exec('systemd-run', ['--user', '--collect', '--quiet', `--unit=homebase-update-${Date.now()}`, ...env, '/bin/bash', '-c', script, 'homebase-update',
      LOG, process.execPath, ROOT, installer, dir], {timeout: 15000});
    job = {state: 'installing', version, at: Date.now()};
  } catch (e) {
    job = {state: 'failed', version, at: Date.now(), error: e.message};
    throw e;
  }
  return updateStatus();
}

export function startUpdateChecks() {
  if (!config.updates.check) return;
  setTimeout(() => checkForUpdate().catch(() => {}), 15000).unref();
  setInterval(() => checkForUpdate().catch(() => {}), CHECK_EVERY).unref();
}
