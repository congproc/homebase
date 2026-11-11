// Power consumption of the whole server, read from the Tapo smart plug it is plugged into (config: energy.tapo).
// Live readings ride along with the 5 s status poll; history (5-minute power, hourly/daily/monthly energy) is
// recorded by the plug itself, so it also covers time when no dashboard was open and while the server slept.
// A once-a-minute heartbeat logs when the machine is awake (Homebase only runs while it is), so after a few
// days the cost estimate can switch from "running 24/7" to the server's real on-time and daily energy.
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from './config.mjs';
import {TapoClient} from './tapo.mjs';
import {serverCost} from './tariff.mjs';

const {tapo, tariff, householdKwh} = config.energy;
const client = tapo ? new TapoClient(tapo) : null;
const RETRY_AFTER = 30000; // after a failure, don't stall every status poll on an unreachable plug
const INFO_EVERY = 60000;
const HISTORY_EVERY = 60000;
const DAY = 86400, STEP = 300; // the plug keeps power samples on a fixed 5-minute grid

let live = null, failedAt = 0, lastError = '', info = null, infoAt = 0, history = null, historyAt = 0;

const decode = b64 => { try { return Buffer.from(b64 || '', 'base64').toString('utf8'); } catch { return ''; } };

/** The device fields worth showing; location, Wi-Fi name and MAC stay on the server. */
export function deviceInfo(raw) {
  return {
    name: decode(raw.nickname) || null, model: raw.model || null, firmware: raw.fw_ver || null, hardware: raw.hw_ver || null,
    on: raw.device_on !== false, onFor: Number.isFinite(raw.on_time) ? raw.on_time : null,
    signal: Number.isFinite(raw.signal_level) ? raw.signal_level : null, rssi: Number.isFinite(raw.rssi) ? raw.rssi : null,
    overheated: raw.overheated === true || (raw.overheat_status && raw.overheat_status !== 'normal') || false,
    protection: [raw.power_protection_status, raw.overcurrent_status].filter(s => s && s !== 'normal'),
    timeDiff: Number.isFinite(raw.time_diff) ? raw.time_diff : null, region: raw.region || null,
  };
}

/** One live reading from get_energy_usage (current_power is in milliwatts; energy totals in Wh; runtimes in minutes). */
export function usage(raw) {
  return {
    watts: Number.isFinite(raw.current_power) ? Math.round(raw.current_power / 100) / 10 : null,
    today: raw.today_energy ?? null, month: raw.month_energy ?? null,
    todayRuntime: raw.today_runtime ?? null, monthRuntime: raw.month_runtime ?? null,
  };
}

function base() {
  // Effective price of the server's kWh (incl. VAT) from the latest estimate, so the dashboard can price today/month.
  const lead = estimate && (estimate.basis === 'predicted' ? estimate.predicted : estimate.alwaysOn);
  return {configured: !!client, host: tapo?.host || null, pricePerKwh: estimate?.perKwh ?? null, currency: tariff?.currency || '',
    monthlyCost: lead?.cost ?? null, costBasis: estimate?.basis ?? null};
}

/** Live power for the status snapshot. Never throws; a failing plug is retried at most every 30 s. */
export async function readEnergy() {
  if (!client) return {configured: false};
  const now = Date.now();
  if (live && now - live.at < 4000) return {...base(), available: true, ...live, device: info}; // status poll and heartbeat share readings
  if (failedAt && now - failedAt < RETRY_AFTER) return {...base(), available: false, error: lastError, device: info};
  try {
    const reading = usage(await client.request('get_energy_usage'));
    if (now - infoAt > INFO_EVERY) { info = deviceInfo(await client.request('get_device_info')); infoAt = now; }
    live = {...reading, at: now};
    failedAt = 0; lastError = '';
    return {...base(), available: true, ...live, device: info};
  } catch (e) {
    failedAt = now; lastError = e.message;
    return {...base(), available: false, error: e.message, device: info};
  }
}

// ---------- history (calendar math happens in the plug's own time zone, from its time_diff in minutes) ----------

const pad = n => String(n).padStart(2, '0');
/** Start of the plug-local day / quarter / year containing unix time `t`, as unix seconds. */
export function plugCalendar(t, diffMinutes) {
  const off = diffMinutes * 60, d = new Date((t + off) * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return {
    day: Date.UTC(y, m, d.getUTCDate()) / 1000 - off,
    quarter: Date.UTC(y, m - (m % 3), 1) / 1000 - off,
    year: Date.UTC(y, 0, 1) / 1000 - off,
  };
}
const localDate = (t, diffMinutes) => { const d = new Date((t + diffMinutes * 60) * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

/** Power samples (W) on the 5-minute grid; the plug reports -1 where it has no reading (unplugged, no power). */
export function samples(reply) {
  return (reply.data || []).map((v, i) => ({at: (reply.start_timestamp + i * STEP) * 1000, watts: v >= 0 ? v : null}));
}

/** Daily energy (Wh) for the `days` days ending on the plug-local day starting at `today`. The plug returns whole quarters starting on the quarter's first day. */
export function lastDays(quarters, today, diffMinutes, days = 30) {
  const byDate = new Map();
  for (const q of quarters) (q.data || []).forEach((wh, i) => byDate.set(localDate(q.start_timestamp + i * DAY + 3600, diffMinutes), Math.max(0, wh)));
  return Array.from({length: days}, (_, i) => {
    const date = localDate(today - (days - 1 - i) * DAY + 3600, diffMinutes);
    return {date, wh: byDate.get(date) ?? 0};
  });
}

async function readHistory() {
  const now = Math.floor(Date.now() / 1000);
  const diff = (await client.request('get_device_time')).time_diff ?? info?.timeDiff ?? 0;
  const cal = plugCalendar(now, diff);
  const end = Math.floor(now / STEP) * STEP;
  // At most 144 samples per request: two 12-hour windows make the last 24 hours.
  const [older, newer] = [await client.request('get_power_data', {start_timestamp: end - DAY, end_timestamp: end - DAY / 2, interval: 5}),
    await client.request('get_power_data', {start_timestamp: end - DAY / 2, end_timestamp: end, interval: 5})];
  const hourly = await client.request('get_energy_data', {start_timestamp: cal.day, end_timestamp: cal.day + DAY, interval: 60});
  const quarters = [await client.request('get_energy_data', {start_timestamp: cal.quarter, end_timestamp: now, interval: 1440})];
  const monthAgo = now - 29 * DAY;
  if (monthAgo < cal.quarter) {
    const prev = plugCalendar(cal.quarter - DAY, diff).quarter;
    quarters.unshift(await client.request('get_energy_data', {start_timestamp: prev, end_timestamp: cal.quarter - 1, interval: 1440}));
  }
  const monthly = await client.request('get_energy_data', {start_timestamp: cal.year, end_timestamp: now, interval: 43200});
  const month = new Date((now + diff * 60) * 1000).getUTCMonth();
  const year = new Date((now + diff * 60) * 1000).getUTCFullYear();
  const power = [...samples(older), ...samples(newer)].filter(s => s.at <= Date.now());
  const known = power.filter(s => s.watts != null);
  return {
    power,
    average: known.length ? Math.round(known.reduce((a, s) => a + s.watts, 0) / known.length * 10) / 10 : null,
    covered: known.length * STEP, // seconds of the last 24 h with readings
    hours: (hourly.data || []).slice(0, 24).map((wh, h) => ({hour: h, wh: Math.max(0, wh)})),
    currentHour: Math.floor((now - cal.day) / 3600),
    days: lastDays(quarters, cal.day, diff),
    months: (monthly.data || []).slice(0, month + 1).map((wh, i) => ({month: `${year}-${pad(i + 1)}`, wh: Math.max(0, wh)})),
    timeDiff: diff, region: info?.region || null,
  };
}

async function refreshHistory(maxAge) {
  if (history && Date.now() - historyAt <= maxAge) return null;
  try { history = await readHistory(); historyAt = Date.now(); analyse(); return null; }
  catch (e) { return e.message; }
}

/** Everything the energy panel shows. History is cached for a minute while a panel is open. */
export async function getEnergy() {
  if (!client) return {configured: false};
  const current = await readEnergy();
  const historyError = current.available ? await refreshHistory(HISTORY_EVERY) : null;
  analyse();
  return {...current, ...base(), history, estimate, ...(historyError ? {historyError} : {})};
}

// ---------- on-time log ----------
// ~/.local/state/homebase/energy-log.json: per plug-local day, seconds awake and the watt-seconds measured then.
// A minute that passes without a heartbeat (suspended, powered off, Homebase stopped) counts as off.

const LOG_FILE = path.join(os.homedir(), '.local/state/homebase/energy-log.json');
const BEAT = 60000, MAX_BEAT_GAP = 150000, KEEP_DAYS = 400;
let log = {version: 1, started: null, days: {}}, lastBeat = 0, logLoaded = false;

const dayOf = (ms, diffMinutes) => localDate(Math.floor(ms / 1000), diffMinutes);
const tzMinutes = () => info?.timeDiff ?? -new Date().getTimezoneOffset();

/** Adds the time since the previous heartbeat to the current day; returns the (mutated) log. Gaps over 150 s are not counted. */
export function beat(state, now, previous, watts, diffMinutes) {
  state.started ??= now;
  if (!previous || now - previous > MAX_BEAT_GAP || now <= previous) return state;
  const s = (now - previous) / 1000, day = (state.days[dayOf(now, diffMinutes)] ??= {awake: 0, measured: 0, wattSeconds: 0});
  day.awake += s;
  if (watts != null) { day.measured += s; day.wattSeconds += watts * s; }
  return state;
}

async function loadLog() {
  try { const v = JSON.parse(await readFile(LOG_FILE, 'utf8')); if (v?.version === 1 && v.days) log = v; } catch { /* first run */ }
  logLoaded = true;
}

async function saveLog() {
  const keys = Object.keys(log.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete log.days[k];
  await mkdir(path.dirname(LOG_FILE), {recursive: true, mode: 0o700});
  await writeFile(LOG_FILE + '.tmp', JSON.stringify(log), {mode: 0o600});
  await rename(LOG_FILE + '.tmp', LOG_FILE);
}

async function heartbeat() {
  if (!logLoaded) await loadLog();
  const reading = await readEnergy();
  const now = Date.now();
  beat(log, now, lastBeat, reading.available ? reading.watts : null, tzMinutes());
  lastBeat = now;
  await saveLog().catch(e => console.error('Homebase: could not save energy log:', e.message));
  if (reading.available) await refreshHistory(10 * 60000); // keeps the estimate current with no dashboard open
  analyse();
}

/** Starts the once-a-minute on-time log (only when a plug is configured). */
export function startEnergyLog() {
  if (!client) return;
  heartbeat().catch(() => {});
  setInterval(() => { heartbeat().catch(() => {}); }, BEAT).unref();
}

// ---------- cost estimate ----------

const MONTH_DAYS = 30, PREDICT_DAYS = 7;
let estimate = null;

/** Split 5-minute plug samples into awake and asleep by a threshold well above standby draw. */
export function splitSamples(power) {
  const known = power.map(p => p.watts).filter(w => w != null);
  if (!known.length) return {threshold: null, awake: null, asleep: null};
  const threshold = Math.max(5, 0.3 * Math.max(...known));
  const avg = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  return {threshold, awake: avg(known.filter(w => w >= threshold)), asleep: avg(known.filter(w => w < threshold))};
}

/** Days fully covered by the on-time log (after the day logging began, before today), newest last. */
export function completeDays(state, today, plugDays = []) {
  if (!state.started) return [];
  const first = dayOf(state.started, tzMinutes());
  const plug = new Map(plugDays.map(d => [d.date, d.wh]));
  return Object.entries(state.days).filter(([date]) => date > first && date < today).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({date, awakeHours: d.awake / 3600, awakeWatts: d.measured > 600 ? d.wattSeconds / d.measured : null, wh: plug.get(date) ?? null}));
}

const priced = kwh => {
  const c = serverCost(kwh, householdKwh, tariff);
  return {kwhMonth: kwh, cost: c.cost, perKwh: c.perKwh, perDay: c.cost / MONTH_DAYS, tiers: c.tiers, household: c.household};
};

/** Recomputes the cost estimate from the plug history and the on-time log. */
export function analyse() {
  if (!client || !tariff) { estimate = null; return null; }
  const diff = tzMinutes(), today = dayOf(Date.now(), diff);
  const split = splitSamples(history?.power || []);
  // Awake power: what the log measured over the last week, else the plug's recent awake samples, else right now.
  const recent = Object.entries(log.days).filter(([date]) => date >= localDate(Math.floor(Date.now() / 1000) - PREDICT_DAYS * DAY, diff));
  const measured = recent.reduce((a, [, d]) => a + d.measured, 0), wattSeconds = recent.reduce((a, [, d]) => a + d.wattSeconds, 0);
  const awakeW = measured >= 3600 ? wattSeconds / measured : split.awake ?? live?.watts ?? null;
  const source = measured >= 3600 ? 'log' : split.awake != null ? 'plug' : 'live';
  if (awakeW == null) { estimate = null; return null; }
  const alwaysOn = priced(awakeW * 24 * MONTH_DAYS / 1000);
  const days = completeDays(log, today, history?.days).slice(-PREDICT_DAYS);
  let predicted = null;
  if (days.length) {
    const sleepW = split.asleep ?? 0;
    // Prefer the plug's own daily energy; fall back to on-time × awake power (+ standby while off).
    const wh = days.map(d => d.wh > 0 ? d.wh : d.awakeHours * (d.awakeWatts ?? awakeW) + (24 - d.awakeHours) * sleepW);
    const avgWh = wh.reduce((a, b) => a + b, 0) / days.length;
    predicted = {...priced(avgWh * MONTH_DAYS / 1000), days: days.length, needed: PREDICT_DAYS, ready: days.length >= PREDICT_DAYS,
      hoursOn: days.reduce((a, d) => a + d.awakeHours, 0) / days.length, dailyWh: avgWh};
  }
  const loggedToday = log.days[today];
  estimate = {
    tariff: tariff && {name: tariff.name, effective: tariff.effective, vat: tariff.vat, currency: tariff.currency, tiers: tariff.tiers, id: tariff.id},
    householdKwh, awakeW, asleepW: split.asleep, source, alwaysOn, predicted,
    // The 24/7 figure leads until a full week of on-time has been logged.
    basis: predicted?.ready ? 'predicted' : 'always-on', perKwh: (predicted?.ready ? predicted : alwaysOn).perKwh,
    log: {started: log.started, today: loggedToday ? {awakeHours: loggedToday.awake / 3600} : null,
      days: completeDays(log, today, history?.days).slice(-14)},
  };
  return estimate;
}
