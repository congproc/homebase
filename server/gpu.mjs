// GPU readings for NVIDIA, AMD and Intel without root.
//  - Devices: PCI display controllers (class 0x03xxxx) from sysfs, named via pci.ids.
//  - NVIDIA (proprietary driver): nvidia-smi, matched to the PCI device by bus id. nouveau falls back to hwmon.
//  - AMD (amdgpu): gpu_busy_percent, mem_info_vram_*, pp_dpm_sclk, hwmon (temp, power, fan, sclk).
//  - Intel (i915 / xe): busy % derived from GT idle (RC6) residency between samples, GT frequency, hwmon when present.
//  - Per-process use on AMD/Intel: DRM fdinfo (drm-engine-*, drm-memory-*), for processes this account can read.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
const exec = promisify(execFile);

const VENDORS = {'0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel'};
const SHORT = {nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel'};
const HISTORY_MS = 15 * 60 * 1000, GAP_MS = 30000, PROC_EVERY = 10000;
const PCI_IDS = ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids', '/usr/share/pci.ids'];
// AMD APU codenames as they appear in pci.ids (integrated graphics share system memory).
const AMD_APU = /\b(Kaveri|Carrizo|Stoney|Raven|Picasso|Renoir|Lucienne|Cezanne|Barcelo|Rembrandt|Mendocino|Van Gogh|Phoenix|Hawk Point|Raphael|Granite Ridge|Strix|Krackan)/i;

const num = v => { if (v == null || v === '') return null; const n = Number(String(v).trim()); return Number.isFinite(n) ? n : null; };
const text = p => readFile(p, 'utf8').then(s => s.trim(), () => null);
const int = async p => num(await text(p));
const first = async (...paths) => { for (const p of paths) { const v = await int(p); if (v != null) return v; } return null; };
const list = p => readdir(p).catch(() => []);
const clamp = v => Math.max(0, Math.min(100, Math.round(v)));
const mem = (used, total) => total ? {used: used ?? 0, total, percent: clamp(((used ?? 0) / total) * 100)} : null;

/* ---------- names ---------- */

export function displayName(vendor, raw, deviceId) {
  const short = SHORT[vendor] || 'GPU';
  if (!raw) return `${short} GPU (${deviceId})`;
  let n = raw.match(/\[([^\]]+)\]\s*$/)?.[1] || raw;
  if (!n.toLowerCase().startsWith(short.toLowerCase())) n = `${short} ${n}`;
  return n;
}

export function lookupPciName(db, vendorId, deviceId) {
  const v = vendorId.replace(/^0x/, '').toLowerCase(), d = deviceId.replace(/^0x/, '').toLowerCase();
  const start = db.search(new RegExp(`^${v}  `, 'm'));
  if (start < 0) return null;
  const block = db.slice(start);
  const end = block.slice(1).search(/^[0-9a-f]{4} {2}/m);
  const body = end < 0 ? block : block.slice(0, end + 1);
  return body.match(new RegExp(`^\\t${d}  (.+)$`, 'm'))?.[1]?.trim() || null;
}

/* ---------- nvidia-smi ---------- */

const SMI_FIELDS = ['pci.bus_id', 'index', 'uuid', 'name', 'utilization.gpu', 'utilization.memory', 'memory.used', 'memory.total', 'temperature.gpu', 'power.draw', 'power.limit', 'fan.speed', 'clocks.sm', 'clocks.max.sm', 'pstate', 'driver_version'];
const csv = out => out.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split(/\s*,\s*/));
// "00000000:01:00.0" → "0000:01:00.0" (sysfs form)
const busId = id => id.toLowerCase().replace(/^0*([0-9a-f]{4}:)/, '$1').replace(/^([0-9a-f]{2}:)/, '0000:$1');

export function parseGpus(out) {
  return csv(out).filter(r => r.length >= SMI_FIELDS.length).map(r => {
    const [bus, , uuid, name, util, memUtil, memUsed, memTotal, temp, power, powerLimit, fan, clock, clockMax, pstate, driverVersion] = r;
    const used = num(memUsed), total = num(memTotal);
    return {
      busId: busId(bus), uuid, name, driverVersion, pstate,
      utilization: num(util) ?? 0, memoryUtilization: num(memUtil),
      memory: mem(used != null ? used * 1048576 : 0, total ? total * 1048576 : 0),
      temperature: num(temp), power: num(power), powerLimit: num(powerLimit), fan: num(fan), clock: num(clock), clockMax: num(clockMax),
    };
  });
}

export function parseApps(out) {
  return csv(out).filter(r => r.length >= 4).map(([uuid, pid, ...rest]) => {
    const memory = num(rest.pop());
    return {uuid, pid: num(pid), name: rest.join(', ').split('/').pop(), memory: (memory ?? 0) * 1048576, utilization: null};
  }).filter(p => Number.isInteger(p.pid));
}

async function defaultSmi(args) {
  const {stdout} = await exec('nvidia-smi', args, {timeout: 4000, maxBuffer: 512 * 1024});
  return stdout;
}

async function readSmi(smi) {
  const [gpuOut, appOut] = await Promise.all([
    smi([`--query-gpu=${SMI_FIELDS.join(',')}`, '--format=csv,noheader,nounits']),
    smi(['--query-compute-apps=gpu_uuid,pid,process_name,used_memory', '--format=csv,noheader,nounits']).catch(() => ''),
  ]);
  return {gpus: parseGpus(gpuOut), apps: parseApps(appOut)};
}

/* ---------- sysfs ---------- */

async function devices(sys) {
  const base = join(sys, 'bus/pci/devices'), out = [];
  for (const addr of await list(base)) {
    const dir = join(base, addr);
    if (!(await text(join(dir, 'class')))?.startsWith('0x03')) continue;
    const vendorId = (await text(join(dir, 'vendor'))) || '', deviceId = (await text(join(dir, 'device'))) || '';
    const vendor = VENDORS[vendorId.toLowerCase()];
    const driver = await readlink(join(dir, 'driver')).then(basename, () => null);
    if (!vendor || !driver || driver.startsWith('vfio')) continue; // BMC/virtual VGA, unbound or passed-through cards
    const card = (await list(join(dir, 'drm'))).find(n => /^card\d+$/.test(n));
    const hw = (await list(join(dir, 'hwmon'))).find(n => /^hwmon\d+$/.test(n));
    out.push({addr, dir, vendorId, deviceId, vendor, driver, card: card ? join(dir, 'drm', card) : null, hwmon: hw ? join(dir, 'hwmon', hw) : null});
  }
  return out;
}

async function hwmon(h, st, t) {
  if (!h) return {};
  const r = k => int(join(h, k));
  const temp = await r('temp1_input');
  let power = await first(join(h, 'power1_average'), join(h, 'power1_input'));
  power = power != null ? power / 1e6 : null;
  if (power == null) { // Intel discrete exposes only an energy counter (µJ)
    const e = await r('energy1_input');
    if (e != null) {
      if (st.energy && t - st.energy.at <= GAP_MS && t > st.energy.at && e >= st.energy.v) power = (e - st.energy.v) / 1e6 / ((t - st.energy.at) / 1000);
      st.energy = {v: e, at: t};
    }
  }
  const cap = await first(join(h, 'power1_cap'), join(h, 'power1_max'));
  const pwm = await r('pwm1'), pwmMax = (await r('pwm1_max')) || 255, rpm = await r('fan1_input'), freq = await r('freq1_input');
  return {
    temperature: temp != null ? Math.round(temp / 1000) : null,
    power: power != null ? Math.round(power * 10) / 10 : null,
    powerLimit: cap ? Math.round(cap / 1e6) : null,
    fan: pwm != null ? clamp((pwm / pwmMax) * 100) : null,
    fanRpm: rpm,
    clock: freq ? Math.round(freq / 1e6) : null,
  };
}

async function amd(d) {
  const p = k => join(d.dir, k);
  const sclk = await text(p('pp_dpm_sclk')); // "0: 500Mhz\n1: 2600Mhz *"
  const levels = sclk ? [...sclk.matchAll(/(\d+)\s*Mhz/gi)].map(m => Number(m[1])) : [];
  const current = sclk?.match(/(\d+)\s*Mhz\s*\*/i);
  return {
    utilization: await int(p('gpu_busy_percent')),
    memoryUtilization: await int(p('mem_busy_percent')),
    memory: mem(await int(p('mem_info_vram_used')), await int(p('mem_info_vram_total'))),
    clockMax: levels.length ? Math.max(...levels) : null,
    dpmClock: current ? Number(current[1]) : null,
  };
}

function busyFromIdle(st, idleMs, t) {
  let u = null;
  if (idleMs != null && st.idle && t - st.idle.at <= GAP_MS && t > st.idle.at && idleMs >= st.idle.v) u = clamp(100 - ((idleMs - st.idle.v) / (t - st.idle.at)) * 100);
  if (idleMs != null) st.idle = {v: idleMs, at: t};
  return u;
}

async function intel(d, st, t) {
  const c = d.card, gt = join(d.dir, 'tile0/gt0');
  const xe = d.driver === 'xe';
  const idle = xe ? await int(join(gt, 'gtidle/idle_residency_ms')) : c ? await first(join(c, 'gt/gt0/rc6_residency_ms'), join(c, 'power/rc6_residency_ms')) : null;
  return {
    utilization: busyFromIdle(st, idle, t),
    utilizationSource: idle != null ? 'idle-residency' : undefined,
    clock: xe ? await int(join(gt, 'freq0/act_freq')) : c ? await first(join(c, 'gt_act_freq_mhz'), join(c, 'gt_cur_freq_mhz')) : null,
    clockMax: xe ? await first(join(gt, 'freq0/rp0_freq'), join(gt, 'freq0/max_freq')) : c ? await first(join(c, 'gt_RP0_freq_mhz'), join(c, 'gt_max_freq_mhz')) : null,
  };
}

/* ---------- DRM fdinfo (per-process use on AMD / Intel) ---------- */

const UNIT = {'': 1, B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824};
export function parseFdinfo(s) {
  const pdev = s.match(/^drm-pdev:\s*(\S+)/m)?.[1], client = s.match(/^drm-client-id:\s*(\d+)/m)?.[1];
  if (!pdev || !client) return null;
  const engines = {};
  for (const m of s.matchAll(/^drm-engine-(?!capacity-)([\w-]+):\s*(\d+)\s*ns/gm)) engines[m[1]] = Number(m[2]);
  const size = re => { const m = s.match(re); return m ? Number(m[1]) * (UNIT[m[2] || ''] ?? 1) : 0; };
  const vram = size(/^drm-memory-vram:\s*(\d+)\s*(\w*)/m) || size(/^drm-resident-vram0:\s*(\d+)\s*(\w*)/m) || size(/^drm-total-vram0:\s*(\d+)\s*(\w*)/m) || size(/^drm-resident-local0:\s*(\d+)\s*(\w*)/m);
  const system = size(/^drm-memory-gtt:\s*(\d+)\s*(\w*)/m) || size(/^drm-resident-system0?:\s*(\d+)\s*(\w*)/m) || size(/^drm-total-system0?:\s*(\d+)\s*(\w*)/m);
  return {pdev: busId(pdev), client, engines, vram, system};
}

async function scanProcs(proc, ps, t) {
  if (t - ps.at < PROC_EVERY) return ps.cache;
  const found = new Map(), seen = new Set(); // key pid|pdev → aggregate
  await Promise.all((await list(proc)).filter(n => /^\d+$/.test(n)).map(async pid => {
    const fdDir = join(proc, pid, 'fd');
    const fds = await list(fdDir);
    if (!fds.length) return;
    const links = await Promise.all(fds.map(fd => readlink(join(fdDir, fd)).catch(() => '')));
    const drm = fds.filter((_, i) => links[i].startsWith('/dev/dri/'));
    if (!drm.length) return;
    const name = (await text(join(proc, pid, 'comm'))) || pid;
    for (const fd of drm) {
      const info = parseFdinfo((await text(join(proc, pid, 'fdinfo', fd))) || '');
      if (!info || seen.has(info.pdev + '/' + info.client)) continue; // a client can be shared by several fds
      seen.add(info.pdev + '/' + info.client);
      const key = pid + '|' + info.pdev;
      const a = found.get(key) || {pid: Number(pid), name, pdev: info.pdev, engines: {}, vram: 0, system: 0};
      for (const [e, ns] of Object.entries(info.engines)) a.engines[e] = (a.engines[e] || 0) + ns;
      a.vram += info.vram; a.system += info.system;
      found.set(key, a);
    }
  }));
  const byDev = new Map(), prev = ps.prev, next = new Map();
  for (const [key, a] of found) {
    const old = prev.get(key);
    let utilization = null;
    if (old && t - old.at <= GAP_MS * 2 && t > old.at) {
      const dt = (t - old.at) * 1e6;
      utilization = clamp(Math.max(0, ...Object.entries(a.engines).map(([e, ns]) => (ns - (old.engines[e] ?? ns)) / dt * 100)));
    }
    next.set(key, {at: t, engines: a.engines});
    const row = {pid: a.pid, name: a.name, memory: a.vram || a.system, utilization};
    byDev.set(a.pdev, [...(byDev.get(a.pdev) || []), row]);
  }
  for (const rows of byDev.values()) rows.sort((x, y) => (y.utilization ?? 0) - (x.utilization ?? 0) || y.memory - x.memory).splice(12);
  ps.prev = next; ps.at = t; ps.cache = byDev;
  return byDev;
}

/* ---------- reader ---------- */

export function createGpuReader({sys = '/sys', proc = '/proc', smi = defaultSmi, pciIds = PCI_IDS} = {}) {
  const state = new Map(), ps = {at: 0, prev: new Map(), cache: new Map()}, names = new Map();
  let db;
  const pciName = async (v, d) => {
    const k = v + ':' + d;
    if (!names.has(k)) {
      db ??= (async () => { for (const p of pciIds) { const s = await readFile(p, 'utf8').catch(() => null); if (s) return s; } return ''; })();
      names.set(k, lookupPciName(await db, v, d));
    }
    return names.get(k);
  };

  return async function read(t = Date.now()) {
    const devs = await devices(sys);
    let smiData = null, smiError;
    if (devs.some(d => d.driver === 'nvidia') || !devs.length) {
      try { smiData = await readSmi(smi); } catch (e) { smiError = e.code === 'ENOENT' ? 'nvidia-smi not found — install the NVIDIA utilities for full readings' : (e.stderr?.trim() || e.message); }
    }
    const procs = devs.some(d => d.driver !== 'nvidia') ? await scanProcs(proc, ps, t).catch(() => new Map()) : new Map();
    const base = (id, vendor) => ({id, vendor, kind: 'discrete', driver: null, driverVersion: null, pstate: null, utilization: null, memoryUtilization: null, memory: null,
      temperature: null, power: null, powerLimit: null, fan: null, fanRpm: null, clock: null, clockMax: null, processes: []});
    const items = [];
    for (const d of devs) {
      const st = state.get(d.addr) || {history: []};
      state.set(d.addr, st);
      const raw = await pciName(d.vendorId, d.deviceId);
      const g = {...base(d.addr, d.vendor), driver: d.driver, name: displayName(d.vendor, raw, d.deviceId), processes: procs.get(d.addr) || []};
      for (const [k, v] of Object.entries(await hwmon(d.hwmon, st, t))) if (v != null) g[k] = v;
      if (d.driver === 'amdgpu') {
        const {dpmClock, ...a} = await amd(d);
        for (const [k, v] of Object.entries(a)) if (v != null) g[k] = v;
        g.clock ??= dpmClock;
        if (AMD_APU.test(raw || '') || (g.memory && g.memory.total <= 1073741824)) g.kind = 'integrated';
      } else if (d.driver === 'i915' || d.driver === 'xe') {
        for (const [k, v] of Object.entries(await intel(d, st, t))) if (v != null) g[k] = v;
        if (/^[0-9a-f]{4}:00:/.test(d.addr)) g.kind = 'integrated'; // Intel iGPU sits on the root bus (00:02.0)
      } else if (d.driver === 'nvidia') {
        const s = smiData?.gpus.find(x => x.busId === d.addr);
        if (s) {
          const {busId: _b, uuid, ...rest} = s;
          Object.assign(g, rest);
          g.processes = smiData.apps.filter(a => a.uuid === uuid).map(({uuid: _u, ...a}) => a);
        } else g.note = smiError || 'nvidia-smi did not report this GPU';
      }
      items.push(g);
    }
    for (const s of smiData?.gpus || []) { // nvidia-smi sees a GPU that sysfs did not list (e.g. restricted /sys)
      if (items.some(i => i.id === s.busId)) continue;
      const {busId: id, uuid, ...rest} = s;
      items.push({...base(id, 'nvidia'), driver: 'nvidia', ...rest, processes: smiData.apps.filter(a => a.uuid === uuid).map(({uuid: _u, ...a}) => a)});
    }
    items.sort((a, b) => (a.kind === 'integrated') - (b.kind === 'integrated') || (b.memory?.total ?? 0) - (a.memory?.total ?? 0) || a.id.localeCompare(b.id));
    items.forEach((g, i) => {
      g.index = i;
      const st = state.get(g.id) || {history: []};
      state.set(g.id, st);
      st.history.push({at: t, utilization: g.utilization, memory: g.memory?.percent ?? null, temperature: g.temperature, power: g.power});
      st.history = st.history.filter(p => t - p.at <= HISTORY_MS).slice(-180);
      g.history = st.history;
    });
    return {available: items.length > 0, items, ...(items.length ? {} : {error: smiError || 'No NVIDIA, AMD or Intel GPU found'})};
  };
}

export const readGpus = createGpuReader();
