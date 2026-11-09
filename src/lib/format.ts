import type {Disk, Level, Status} from './types';

export const bytes = (v = 0) =>
  v >= 1024 ** 4 ? (v / 1024 ** 4).toFixed(2) + ' TB'
  : v >= 1024 ** 3 ? (v / 1024 ** 3).toFixed(1) + ' GB'
  : v >= 1024 ** 2 ? (v / 1024 ** 2).toFixed(1) + ' MB'
  : v >= 1024 ? (v / 1024).toFixed(1) + ' KB'
  : Math.round(v) + ' B';

export const rate = (v = 0) => bytes(v) + '/s';

export const elapsed = (v = 0) => {
  v = Math.max(0, v);
  if (v >= 86400) return `${Math.floor(v / 86400)}d ${Math.floor((v % 86400) / 3600)}h ${Math.floor((v % 3600) / 60)}m`;
  if (v >= 3600) return `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`;
  if (v >= 60) return `${Math.floor(v / 60)}m ${Math.floor(v % 60)}s`;
  return `${Math.floor(v)}s`;
};

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export const clock = (t: number, seconds = false) =>
  new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', ...(seconds ? {second: '2-digit'} : {})});

export const levelFor = (percent: number, warn = 75, critical = 90): Level =>
  percent >= critical ? 'critical' : percent >= warn ? 'warn' : 'ok';

/** Drive health from SMART and temperature, with reasons. Temperature limits come from the drive's sensor when it reports them. */
export function diskHealth(disk: Disk): {level: Level; reasons: string[]} {
  const reasons: string[] = [];
  let level: Level = 'ok';
  const name = disk.model || disk.name;
  if (disk.smart?.state === 'ok' && disk.smart.level && disk.smart.level !== 'ok') {
    level = disk.smart.level;
    reasons.push(...(disk.smart.warnings || []).map(w => `${name}: ${w}`));
  }
  const t = disk.temperature;
  if (t != null) {
    const crit = disk.tempCrit ?? (disk.rotational ? 55 : 80), warn = disk.tempWarn && disk.tempWarn < crit ? disk.tempWarn : crit - (disk.rotational ? 5 : 10);
    if (t >= crit) { level = 'critical'; reasons.push(`${name} at ${Math.round(t)}°C`); }
    else if (t >= warn) { if (level === 'ok') level = 'warn'; reasons.push(`${name} running hot (${Math.round(t)}°C)`); }
  }
  return {level, reasons};
}

/** Overall host health, with the human-readable reasons behind it. */
export function health(d: Status | null, error: string): {level: Level; title: string; reasons: string[]} {
  if (!d) return {level: error ? 'offline' : 'pending', title: error ? 'Agent unreachable' : 'Connecting', reasons: []};
  if (error) return {level: 'offline', title: 'Connection interrupted', reasons: ['Readings below may be stale']};
  const reasons: string[] = [];
  let level = 'ok' as Level;
  const check = (label: string, value: number, warn: number, crit: number) => {
    const l = levelFor(value, warn, crit);
    if (l === 'critical') { level = 'critical'; reasons.push(`${label} at ${value}%`); }
    else if (l === 'warn') { if (level === 'ok') level = 'warn'; reasons.push(`${label} at ${value}%`); }
  };
  check('CPU', d.cpu, 75, 90);
  check('Memory', d.memory.percent, 80, 92);
  if (d.disk) check('Disk', d.disk.percent, 80, 92);
  for (const disk of d.disks?.items || []) {
    const dh = diskHealth(disk);
    if (dh.level === 'critical') level = 'critical'; else if (dh.level === 'warn' && level === 'ok') level = 'warn';
    reasons.push(...dh.reasons);
  }
  if (d.load[0] > d.cores) { if (level === 'ok') level = 'warn'; reasons.push(`Load ${d.load[0].toFixed(2)} exceeds ${d.cores} cores`); }
  const title = level === 'critical' ? 'Under heavy pressure' : level === 'warn' ? 'Needs attention' : 'All systems normal';
  return {level, title, reasons};
}

export const levelColor: Record<Level, string> = {
  ok: 'var(--lime)', warn: 'var(--amber)', critical: 'var(--red)', offline: 'var(--red)', pending: 'var(--text-3)',
};
