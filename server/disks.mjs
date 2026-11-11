// Physical drives without root: inventory and filesystems from lsblk, throughput from /proc/diskstats,
// temperatures from hwmon (nvme, drivetemp). SMART health comes from the optional root helper
// (`homebase-power smart <disk>`, read-only, skips drives in standby) and is refreshed in the background.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
const exec = promisify(execFile);

const HELPER = '/usr/local/sbin/homebase-power';
// Some firmware (e.g. Intel 520 series, firmware 400i) reports a garbage power-on counter; anything above
// ~17 years of continuous use cannot be real, so it is shown as unreliable instead of as a lifetime.
export const MAX_POWER_ON_HOURS = 150000;
const HISTORY_MS = 15 * 60 * 1000, GAP_MS = 30000, SMART_EVERY = 10 * 60 * 1000, SECTOR = 512;
const LSBLK_COLS = 'NAME,PATH,TYPE,SIZE,MODEL,SERIAL,VENDOR,REV,ROTA,TRAN,RM,STATE,FSTYPE,LABEL,MOUNTPOINTS,FSUSED,FSSIZE,FSAVAIL';
// Whole disks worth showing; zram, ram, loop, optical and device-mapper nodes are left out.
const PHYSICAL = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]|xvd[a-z]+|mmcblk\d+)$/;

const num = v => { if (v == null || v === '') return null; const n = Number(String(v).trim()); return Number.isFinite(n) ? n : null; };
const text = p => readFile(p, 'utf8').then(s => s.trim(), () => null);
// Sensor limits in m°C; unset limits read as 0 or a huge sentinel (65261.85 °C).
const limit = v => { const n = num(v); return n != null && n > 0 && n < 200000 ? n / 1000 : null; };
const clean = s => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : s) || null;

/** /proc/diskstats → {name: {read, written, readOps, writeOps, busyMs}} (bytes, ops, ms since boot). */
export function parseDiskstats(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    out[f[2]] = {readOps: Number(f[3]), read: Number(f[5]) * SECTOR, writeOps: Number(f[7]), written: Number(f[9]) * SECTOR, busyMs: Number(f[12])};
  }
  return out;
}

/** Flattens an lsblk device tree into the filesystems/volumes under one disk. */
export function volumesOf(dev) {
  const out = [];
  const walk = (node, depth) => {
    for (const c of node.children || []) {
      const mounts = (c.mountpoints || []).filter(Boolean);
      const total = num(c.fssize), used = num(c.fsused);
      out.push({name: c.name, path: c.path, type: c.type, depth, fstype: c.fstype || null, label: c.label || null, size: num(c.size) || 0, mounts,
        ...(total ? {used: used ?? 0, total, available: num(c.fsavail) ?? 0, percent: Math.round(((used ?? 0) / total) * 100)} : {})});
      walk(c, depth + 1);
    }
  };
  walk(dev, 0);
  return out;
}

const KIND = (d) => d.transport === 'usb' || d.removable ? 'Removable' : d.transport === 'nvme' ? 'NVMe SSD' : d.rotational ? 'HDD' : d.name.startsWith('mmcblk') ? 'eMMC / SD' : d.name.startsWith('vd') || d.name.startsWith('xvd') ? 'Virtual disk' : 'SSD';

// ATA host read/write counters: the unit is in the attribute name smartctl assigns (Host_Writes_32MiB,
// Lifetime_Writes_GiB, ...). Total_LBAs_Written and unnamed variants count 512-byte sectors.
export function ataBytesUnit(name = '') {
  const m = /_(\d+)?([KMGT])i?B$/i.exec(name);
  if (!m) return SECTOR;
  const pow = {K: 1, M: 2, G: 3, T: 4}[m[2].toUpperCase()];
  return Number(m[1] || 1) * 1024 ** pow;
}

/** Normalizes the helper's SMART summary into what the dashboard shows. */
export function smartView(s) {
  if (!s) return null;
  if (s.standby) return {state: 'standby'};
  if (s.error) return ['not-installed', 'needs-setup'].includes(s.error) ? {state: s.error} : {state: 'error', error: s.error};
  const attr = id => s.ata?.find(a => a.id === id);
  const raw = id => { const v = attr(id)?.raw; return Number.isFinite(v) ? v : null; };
  const n = s.nvme || {};
  // Remaining life: NVMe percentage_used, else a normalized ATA wear attribute (100 = new).
  const wearAttr = [231, 202, 233, 177].map(attr).find(a => a && Number.isFinite(a.value) && a.value <= 100);
  const life = Number.isFinite(n.percentage_used) ? Math.max(0, 100 - n.percentage_used) : wearAttr ? wearAttr.value : null;
  const ataBytes = id => raw(id) != null ? raw(id) * ataBytesUnit(attr(id).name) : null;
  const written = Number.isFinite(n.data_units_written) ? n.data_units_written * 512000 : ataBytes(241);
  const read = Number.isFinite(n.data_units_read) ? n.data_units_read * 512000 : ataBytes(242);
  const poh = Number.isFinite(s.powerOnHours) ? s.powerOnHours : null;
  const pohBogus = poh != null && poh > MAX_POWER_ON_HOURS;
  const failing = (s.ata || []).filter(a => a.failing).map(a => a.name);
  const warnings = [];
  if (s.passed === false) warnings.push('SMART overall health check failed');
  if (n.critical_warning) warnings.push(`NVMe critical warning flags: 0x${Number(n.critical_warning).toString(16)}`);
  if (Number.isFinite(n.available_spare) && Number.isFinite(n.available_spare_threshold) && n.available_spare <= n.available_spare_threshold) warnings.push('Spare blocks at or below threshold');
  if (n.media_errors > 0) warnings.push(`${n.media_errors} media errors`);
  for (const [id, label] of [[5, 'reallocated sectors'], [197, 'pending sectors'], [198, 'uncorrectable sectors']]) {
    const v = raw(id); if (v > 0) warnings.push(`${v} ${label}`);
  }
  // 187: the raw value is a real error count only as the standard Reported_Uncorrect. Under vendor names
  // (SandForce/Intel Uncorrectable_Error_Cnt, ...) the raw value is an internal counter that grows on healthy
  // drives, so trust the drive's own normalized score (100 = no errors) instead.
  const a187 = attr(187);
  if (a187?.name === 'Reported_Uncorrect' || !a187?.name) { if (raw(187) > 0) warnings.push(`${raw(187)} reported uncorrectable errors`); }
  else if (Number.isFinite(a187.value) && a187.value < 100) warnings.push(`Drive reports uncorrectable errors (score ${a187.value}/100)`);
  if (failing.length) warnings.push(`Failing: ${failing.join(', ')}`);
  if (life != null && life <= 10) warnings.push(`${life}% rated life left`);
  return {
    state: 'ok', passed: s.passed ?? null, temperature: s.temperature ?? null, powerOnHours: pohBogus ? null : poh, powerOnRaw: pohBogus ? poh : null, powerCycles: s.powerCycles ?? null,
    life, written, read, unsafeShutdowns: n.unsafe_shutdowns ?? raw(192) ?? null, mediaErrors: n.media_errors ?? null, errorLog: n.num_err_log_entries ?? null,
    availableSpare: n.available_spare ?? null, reallocated: raw(5), pending: raw(197), uncorrectable: raw(198), crcErrors: raw(199),
    interfaceSpeed: s.interfaceSpeed ?? null, formFactor: s.formFactor ?? null, rotationRate: s.rotationRate ?? null, warnings,
    level: s.passed === false || failing.length || n.critical_warning ? 'critical' : warnings.length ? 'warn' : 'ok',
  };
}

export function createDiskReader({sys = '/sys', proc = '/proc', lsblk, smartRead} = {}) {
  const listBlock = lsblk || (async () => JSON.parse((await exec('lsblk', ['-J', '-b', '-o', LSBLK_COLS], {timeout: 6000, maxBuffer: 4 * 1024 * 1024})).stdout).blockdevices || []);
  // Only call the helper when the sudoers rule exists: a refused sudo would be logged as an authentication failure.
  let allowed = {at: 0, ok: false};
  const smartAllowed = async () => {
    if (Date.now() - allowed.at < (allowed.ok ? SMART_EVERY : 60000)) return allowed.ok;
    const ok = await exec('sudo', ['-n', '-l'], {timeout: 6000}).then(r => r.stdout.includes(`${HELPER} smart`), () => false);
    allowed = {at: Date.now(), ok}; return ok;
  };
  const readSmart = smartRead || (async name => {
    if (!(await smartAllowed())) return {error: 'needs-setup'};
    try { return JSON.parse((await exec('sudo', ['-n', HELPER, 'smart', name], {timeout: 40000})).stdout); }
    catch (e) { return {error: String(e.stderr || e.message).trim().slice(0, 200)}; }
  });
  let prev = null; const history = new Map(), smart = new Map(), smartBusy = new Set();

  async function temps(name) {
    // NVMe: hwmon under the controller; SATA/SAS with drivetemp: hwmon under the SCSI device.
    const ctrl = name.match(/^(nvme\d+)n\d+$/)?.[1];
    const bases = ctrl ? [join(sys, 'class/nvme', ctrl), join(sys, 'block', name, 'device')] : [join(sys, 'block', name, 'device'), join(sys, 'block', name, 'device/hwmon')];
    for (const base of bases) {
      const dirs = (await readdir(base).catch(() => [])).filter(d => /^hwmon\d+$/.test(d));
      for (const d of dirs) {
        const dir = join(base, d), files = await readdir(dir).catch(() => []);
        const sensors = [];
        for (const f of files.filter(f => /^temp\d+_input$/.test(f)).sort()) {
          const id = f.replace('_input', ''), v = num(await text(join(dir, f)));
          if (v == null || v <= -273000) continue;
          sensors.push({label: (await text(join(dir, id + '_label'))) || (sensors.length ? `Sensor ${sensors.length}` : 'Drive'), value: Math.round(v / 100) / 10,
            max: limit(await text(join(dir, id + '_max'))), crit: limit(await text(join(dir, id + '_crit')))});
        }
        if (sensors.length) return sensors;
      }
    }
    return [];
  }

  async function info(name, transport) {
    const ctrl = name.match(/^(nvme\d+)n\d+$/)?.[1];
    if (ctrl) {
      const base = join(sys, 'class/nvme', ctrl);
      const [firmware, speed, width] = await Promise.all([text(join(base, 'firmware_rev')), text(join(base, 'device/current_link_speed')), text(join(base, 'device/current_link_width'))]);
      return {firmware: clean(firmware), link: speed && width ? `${speed.replace(/\s*PCIe$/, '')} ×${width}` : null};
    }
    const [rev, sched] = await Promise.all([text(join(sys, 'block', name, 'device/rev')), text(join(sys, 'block', name, 'queue/scheduler'))]);
    return {firmware: clean(rev), link: transport === 'usb' ? 'USB' : null, scheduler: sched?.match(/\[([^\]]+)\]/)?.[1] || null};
  }

  function refreshSmart(name, now) {
    const s = smart.get(name);
    if (smartBusy.has(name) || (s && now - s.at < (s.data?.error === 'needs-setup' ? SMART_EVERY / 5 : SMART_EVERY))) return;
    smartBusy.add(name);
    readSmart(name).then(data => smart.set(name, {at: Date.now(), data}), () => {}).finally(() => smartBusy.delete(name));
  }

  return async function readDisks(now = Date.now()) {
    let devices;
    try { devices = await listBlock(); } catch (e) { return {available: false, error: e.code === 'ENOENT' ? 'lsblk not installed' : String(e.message), items: []}; }
    const stats = parseDiskstats((await text(join(proc, 'diskstats'))) || '');
    const old = prev && now - prev.at <= GAP_MS && now > prev.at ? prev : null;
    prev = {at: now, stats};
    const items = await Promise.all(devices.filter(d => d.type === 'disk' && PHYSICAL.test(d.name) && num(d.size) > 0).map(async d => {
      const transport = d.tran || (d.name.startsWith('nvme') ? 'nvme' : null);
      const base = {name: d.name, path: d.path || `/dev/${d.name}`, model: clean(d.model), vendor: /^ATA$/i.test(clean(d.vendor) || '') ? null : clean(d.vendor), serial: clean(d.serial), size: num(d.size) || 0,
        transport, rotational: d.rota === true || d.rota === '1', removable: d.rm === true || d.rm === '1', state: d.state || null};
      const [sensors, extra] = await Promise.all([temps(d.name), info(d.name, transport)]);
      const s = stats[d.name], o = old?.stats[d.name], dt = old ? (now - old.at) / 1000 : 0;
      const io = s && o && dt > 0 ? {
        read: Math.max(0, (s.read - o.read) / dt), write: Math.max(0, (s.written - o.written) / dt),
        readIops: Math.max(0, (s.readOps - o.readOps) / dt), writeIops: Math.max(0, (s.writeOps - o.writeOps) / dt),
        util: Math.min(100, Math.max(0, Math.round(((s.busyMs - o.busyMs) / (dt * 1000)) * 1000) / 10)),
      } : {read: 0, write: 0, readIops: 0, writeIops: 0, util: 0};
      refreshSmart(d.name, now);
      const sm = smartView(smart.get(d.name)?.data);
      const temperature = sensors[0]?.value ?? sm?.temperature ?? null;
      const h = (history.get(d.name) || []).filter(p => now - p.at <= HISTORY_MS);
      h.push({at: now, read: io.read, write: io.write, util: io.util, temperature}); history.set(d.name, h.slice(-180));
      const volumes = volumesOf(d);
      const mounted = volumes.filter(v => v.total && v.mounts.length);
      return {...base, kind: KIND(base), ...extra, temperature, sensors, tempWarn: sensors[0]?.max ?? null, tempCrit: sensors[0]?.crit ?? null,
        io, totals: s ? {read: s.read, written: s.written} : null, volumes,
        usage: mounted.length ? {used: mounted.reduce((a, v) => a + v.used, 0), total: mounted.reduce((a, v) => a + v.total, 0)} : null,
        system: volumes.some(v => v.mounts.includes('/')), smart: sm, smartAt: smart.get(d.name)?.at ?? null, history: h};
    }));
    // System disk first, then by name.
    items.sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name, undefined, {numeric: true}));
    for (const n of history.keys()) if (!items.some(i => i.name === n)) history.delete(n);
    return {available: true, items};
  };
}

export const readDisks = createDiskReader();
