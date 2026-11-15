// Power profiles: eco / balanced / performance, set through the root helper (`homebase-power profile <name>`),
// plus an Auto mode that stays on a frugal profile and boosts to performance only while the machine is busy.
// Settings: ~/.config/homebase/power-profile.json. Time and measured energy per profile, for the savings report:
// ~/.local/state/homebase/power-profile-stats.json. Reading the current state needs no root.
import {execFile} from 'node:child_process';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from './config.mjs';
import {readEnergy} from './energy.mjs';
import {recentNvidia} from './gpu.mjs';

const exec = (bin, args, timeout = 15000) => new Promise(resolve => {
  execFile(bin, args, {timeout, maxBuffer: 1024 * 1024}, (error, stdout, stderr) =>
    resolve({ok: !error, output: stdout.trim(), error: error ? (error.code === 'ENOENT' ? 'Not installed' : stderr.trim() || error.message) : undefined}));
});

export const PROFILES = ['eco', 'balanced', 'performance'];
export const MODES = ['off', 'auto', ...PROFILES];
export const DEFAULTS = Object.freeze({mode: 'off', idleProfile: 'eco', cpuBusy: 60, gpuBusy: 25, ollamaBoost: true, calmMinutes: 3});

const SETTINGS_FILE = path.join(path.dirname(config.configPath.replace(/^~/, os.homedir())), 'power-profile.json');
const STATS_FILE = path.join(os.homedir(), '.local/state/homebase/power-profile-stats.json');
const TICK = 10000, WATTS_EVERY = 30000, CONTROL_TTL = 60000, MAX_SWITCHES = 30;

/** Settings from untrusted JSON: unknown keys dropped, numbers clamped, anything invalid falls back to the default. */
export function parseSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const num = (x, lo, hi, d) => Number.isFinite(Number(x)) && x !== null && x !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(x)))) : d;
  return {
    mode: MODES.includes(v.mode) ? v.mode : DEFAULTS.mode,
    idleProfile: ['eco', 'balanced'].includes(v.idleProfile) ? v.idleProfile : DEFAULTS.idleProfile,
    cpuBusy: num(v.cpuBusy, 20, 95, DEFAULTS.cpuBusy),
    gpuBusy: num(v.gpuBusy, 5, 95, DEFAULTS.gpuBusy),
    ollamaBoost: typeof v.ollamaBoost === 'boolean' ? v.ollamaBoost : DEFAULTS.ollamaBoost,
    calmMinutes: num(v.calmMinutes, 1, 30, DEFAULTS.calmMinutes),
  };
}

/** Why the machine counts as busy right now (empty when it is not). `cpu` is a short average, `gpu` the peak. */
export function busyReasons({cpu, gpu, models}, s) {
  const reasons = [];
  if (cpu >= s.cpuBusy) reasons.push(`CPU ${Math.round(cpu)}%`);
  if (gpu != null && gpu >= s.gpuBusy) reasons.push(`GPU ${Math.round(gpu)}%`);
  if (s.ollamaBoost && models > 0) reasons.push(`${models} Ollama model${models === 1 ? '' : 's'} loaded`);
  return reasons;
}

/** Auto mode: boost at once when busy; fall back only after `calmMinutes` without load (no flapping). */
export function autoTarget({reasons, current, lastBusyAt, now, settings}) {
  if (reasons.length) return {profile: 'performance', reason: `Busy: ${reasons.join(', ')}`};
  if (current === 'performance' && lastBusyAt && now - lastBusyAt < settings.calmMinutes * 60000)
    return {profile: 'performance', reason: 'Cooling down before saving power again'};
  return {profile: settings.idleProfile, reason: 'Idle'};
}

// ---------- state ----------

let settings = {...DEFAULTS}, loaded = false;
let current = null, since = null, reason = '', lastBusyAt = 0, applying = false, lastError = '';
let switches = [];
let control = {at: 0, ok: false};
let window_ = []; // recent samples {at, cpu, gpu, models}
let prevCpu = null, lastWattsAt = 0, lastStatAt = 0, statsSavedAt = 0;
let stats = {version: 1, months: {}};

async function loadAll() {
  if (loaded) return;
  loaded = true;
  try { settings = parseSettings(JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))); } catch { /* defaults */ }
  try { const v = JSON.parse(await readFile(STATS_FILE, 'utf8')); if (v?.version === 1 && v.months) stats = v; } catch { /* first run */ }
}

async function saveJson(file, data) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  await writeFile(file + '.tmp', JSON.stringify(data, null, 1), {mode: 0o600});
  await rename(file + '.tmp', file);
}

async function hasControl() {
  if (Date.now() - control.at < CONTROL_TTL) return control.ok;
  const r = await exec('sudo', ['-n', '-l']); // lists rules only; runs nothing
  control = {at: Date.now(), ok: r.output.includes(`${config.powerHelper} profile`)};
  return control.ok;
}

async function apply(profile, why) {
  if (applying || profile === current) return;
  if (!(await hasControl())) { lastError = 'Needs the updated admin setup'; return; }
  applying = true;
  try {
    const r = await exec('sudo', ['-n', config.powerHelper, 'profile', profile], 30000);
    if (!r.ok) throw Error(r.error || `Could not switch to ${profile}`);
    let detail = {};
    try { detail = JSON.parse(r.output); } catch { /* older helper */ }
    current = profile; since = Date.now(); reason = why; lastError = detail.skipped?.length ? `Not applied: ${detail.skipped.join('; ')}` : '';
    switches.unshift({at: since, profile, reason: why});
    switches = switches.slice(0, MAX_SWITCHES);
  } catch (e) {
    lastError = e.message;
  } finally {
    applying = false;
  }
}

// ---------- sampling ----------

async function cpuPercent() {
  const line = (await readFile('/proc/stat', 'utf8').catch(() => '')).split('\n')[0];
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  if (v.length < 4) return 0;
  const idle = v[3] + (v[4] || 0), total = v.reduce((a, b) => a + b, 0);
  const prev = prevCpu; prevCpu = {idle, total};
  if (!prev || total <= prev.total) return 0;
  return Math.max(0, Math.min(100, (1 - (idle - prev.idle) / (total - prev.total)) * 100));
}

const parseNum = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
/** NVIDIA GPUs with their power numbers; empty when there is no NVIDIA driver. */
export function parseSmi(out) {
  return out.split('\n').filter(Boolean).map(l => {
    const [index, name, util, draw, limit, min, def, pstate] = l.split(',').map(x => x.trim());
    return {index: Number(index), name, utilization: parseNum(util), draw: parseNum(draw), limit: parseNum(limit), min: parseNum(min), default: parseNum(def), pstate};
  }).filter(g => Number.isInteger(g.index));
}
// Machines without the NVIDIA driver skip the spawn entirely (checked once a minute, so a later install is noticed).
let nvidiaCheck = {at: 0, present: false};
async function nvidiaPresent() {
  if (Date.now() - nvidiaCheck.at > 60000) nvidiaCheck = {at: Date.now(), present: await readFile('/proc/driver/nvidia/version', 'utf8').then(() => true, () => false)};
  return nvidiaCheck.present;
}
/** GPU utilisation for the Auto rules: reuses the dashboard's own nvidia-smi reading when it is fresh. */
async function nvidiaUtilization() {
  const shared = recentNvidia(TICK);
  return shared ? shared.map(g => ({utilization: g.utilization})) : readNvidia();
}
async function readNvidia() {
  if (!(await nvidiaPresent())) return [];
  const r = await exec('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,power.draw,power.limit,power.min_limit,power.default_limit,pstate', '--format=csv,noheader,nounits'], 5000);
  return r.ok ? parseSmi(r.output) : [];
}

async function ollamaModels() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/ps', {signal: AbortSignal.timeout(2000)});
    return r.ok ? ((await r.json()).models || []).length : 0;
  } catch { return 0; }
}

const monthKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

/** Adds the time since the last tick (and the measured energy, when a plug reading exists) to the active profile. */
export function account(state, profile, seconds, watts, now) {
  if (!profile || !(seconds > 0) || seconds > 120) return state; // a gap (suspend, stall) is not time spent in the profile
  const month = (state.months[monthKey(now)] ??= {});
  const p = (month[profile] ??= {seconds: 0, measuredSeconds: 0, wattSeconds: 0});
  p.seconds += seconds;
  if (watts != null) { p.measuredSeconds += seconds; p.wattSeconds += watts * seconds; }
  for (const k of Object.keys(state.months).sort().slice(0, -3)) delete state.months[k];
  return state;
}

let lastWatts = null, ticking = null;
/** One controller step. Never overlaps: a slow plug or helper call must not start a second step with a stale
 * clock and CPU baseline; callers that arrive meanwhile wait for the running step instead. */
function tick() {
  ticking ??= step().finally(() => { ticking = null; });
  return ticking;
}
async function step() {
  await loadAll();
  const now = Date.now();
  if (current) {
    if (now - lastWattsAt >= WATTS_EVERY) {
      lastWattsAt = now;
      const e = await readEnergy().catch(() => null);
      lastWatts = e?.available ? e.watts : null;
    }
    account(stats, current, lastStatAt ? (now - lastStatAt) / 1000 : 0, lastWatts, now);
    if (now - statsSavedAt > 5 * 60000) { statsSavedAt = now; saveJson(STATS_FILE, stats).catch(() => {}); }
  }
  lastStatAt = now;
  if (settings.mode === 'off') return;
  if (settings.mode !== 'auto') return apply(settings.mode, 'Fixed profile');
  const [cpu, gpus, models] = await Promise.all([cpuPercent(), nvidiaUtilization(), settings.ollamaBoost ? ollamaModels() : 0]);
  const gpu = gpus.length ? Math.max(...gpus.map(g => g.utilization ?? 0)) : null;
  window_.push({at: now, cpu, gpu, models});
  window_ = window_.filter(s => now - s.at <= 35000);
  // Smooth the CPU over ~30 s so a single spike doesn't boost; GPU and models react at once.
  const avg = window_.reduce((a, s) => a + s.cpu, 0) / window_.length;
  const reasons = busyReasons({cpu: avg, gpu, models}, settings);
  const at = Date.now(); // decision time: the plug read above can take seconds
  if (reasons.length) lastBusyAt = at;
  const target = autoTarget({reasons, current, lastBusyAt, now: at, settings});
  if (process.env.HOMEBASE_DEBUG_PROFILE) console.log(`profile ${new Date(at).toTimeString().slice(0, 8)} avg=${avg.toFixed(0)} n=${window_.length} reasons=${reasons.join('/') || '-'} lastBusy=${lastBusyAt ? Math.round((at - lastBusyAt) / 1000) + 's ago' : 'never'} current=${current} -> ${target.profile}`);
  if (target.profile !== current) await apply(target.profile, target.reason);
  else if (target.reason !== reason && current === target.profile) reason = target.reason;
}

/** Runs the controller every 10 s for the life of the process (cheap: /proc/stat, one nvidia-smi, one local fetch). */
export function startPowerProfiles() {
  const run = () => tick().catch(e => { lastError = e.message; });
  run();
  setInterval(run, TICK).unref();
}

// ---------- API ----------

const readText = p => readFile(p, 'utf8').then(s => s.trim()).catch(() => null);
const uwToW = v => (v && /^\d+$/.test(v) ? Math.round(Number(v) / 1e6) : null);

async function systemState() {
  const rapl = '/sys/class/powercap/intel-rapl:0';
  const names = await Promise.all([0, 1, 2].map(i => readText(`${rapl}/constraint_${i}_name`)));
  const limit = async name => { const i = names.indexOf(name); return i < 0 ? null : uwToW(await readText(`${rapl}/constraint_${i}_power_limit_uw`)); };
  const [ppd, epp, governor, cpuLimit, cpuBurst, gpus] = await Promise.all([
    exec('powerprofilesctl', ['get'], 5000).then(r => (r.ok ? r.output : null)),
    readText('/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference'),
    readText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
    limit('long_term'), limit('short_term'), readNvidia(),
  ]);
  return {ppd, epp, governor, cpuLimit, cpuBurst, gpus};
}

/** Per-profile time and measured average power, this month and last. */
export function report(state, now = Date.now()) {
  const keys = Object.keys(state.months).sort().reverse();
  const thisMonth = monthKey(now);
  return keys.filter(k => k <= thisMonth).slice(0, 2).map(k => ({
    month: k,
    profiles: Object.fromEntries(Object.entries(state.months[k]).map(([p, v]) => [p, {
      hours: v.seconds / 3600, measuredHours: v.measuredSeconds / 3600, avgWatts: v.measuredSeconds > 600 ? v.wattSeconds / v.measuredSeconds : null,
    }])),
  }));
}

export async function getPowerProfile() {
  await loadAll();
  const [system, ok, energy] = await Promise.all([systemState(), hasControl(), readEnergy().catch(() => null)]);
  const latest = window_.at(-1);
  return {
    settings, defaults: DEFAULTS, profiles: PROFILES, current, since, reason, error: lastError || null, switches,
    control: ok, setupCommand: config.setupCommand, system, report: report(stats),
    watts: energy?.available ? energy.watts : null, pricePerKwh: energy?.pricePerKwh ?? null, currency: energy?.currency || '',
    signals: latest ? {cpu: window_.reduce((a, s) => a + s.cpu, 0) / window_.length, gpu: latest.gpu, models: latest.models, at: latest.at} : null,
  };
}

/** Saves new settings and applies them now. Leaving "off" keeps whatever profile was last set. */
export async function savePowerProfile(input) {
  await loadAll();
  if (!input || typeof input !== 'object') throw Error('Invalid settings');
  const next = parseSettings({...settings, ...input});
  if (next.mode !== 'off' && !(await hasControl())) throw Error('Power profiles need the updated admin setup. Run: ' + config.setupCommand);
  settings = next;
  await saveJson(SETTINGS_FILE, settings);
  if (settings.mode === 'off') { current = null; reason = ''; }
  else if (settings.mode === 'auto') { window_ = []; await tick(); }
  else await apply(settings.mode, 'Fixed profile');
  return getPowerProfile();
}
