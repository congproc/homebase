export type Point = {at: number; cpu: number; memory: number; download: number; upload: number; gpu?: number | null; vram?: number | null; power?: number | null};
export type GpuProc = {pid: number; name: string; memory: number; utilization: number | null};
export type GpuPoint = {at: number; utilization: number | null; memory: number | null; temperature: number | null; power: number | null};
export type Gpu = {
  id: string; index: number; name: string; vendor: 'nvidia' | 'amd' | 'intel'; kind: 'discrete' | 'integrated';
  driver: string | null; driverVersion: string | null; pstate: string | null; note?: string;
  utilization: number | null; utilizationSource?: 'idle-residency'; memoryUtilization: number | null;
  memory: {used: number; total: number; percent: number} | null;
  temperature: number | null; power: number | null; powerLimit: number | null; fan: number | null; fanRpm: number | null; clock: number | null; clockMax: number | null;
  processes: GpuProc[];
  history: GpuPoint[];
};
export type DiskVolume = {name: string; path: string; type: string; depth: number; fstype: string | null; label: string | null; size: number; mounts: string[]; used?: number; total?: number; available?: number; percent?: number};
export type DiskSmart = {
  state: 'ok' | 'standby' | 'not-installed' | 'needs-setup' | 'error'; error?: string;
  passed?: boolean | null; temperature?: number | null; powerOnHours?: number | null; powerOnRaw?: number | null; powerCycles?: number | null; life?: number | null;
  written?: number | null; read?: number | null; unsafeShutdowns?: number | null; mediaErrors?: number | null; errorLog?: number | null; availableSpare?: number | null;
  reallocated?: number | null; pending?: number | null; uncorrectable?: number | null; crcErrors?: number | null;
  interfaceSpeed?: string | null; formFactor?: string | null; rotationRate?: number | null; warnings?: string[]; level?: 'ok' | 'warn' | 'critical';
};
export type Disk = {
  name: string; path: string; model: string | null; vendor: string | null; serial: string | null; size: number; transport: string | null;
  rotational: boolean; removable: boolean; state: string | null; kind: string; firmware: string | null; link: string | null; scheduler?: string | null;
  temperature: number | null; sensors: {label: string; value: number; max: number | null; crit: number | null}[]; tempWarn: number | null; tempCrit: number | null;
  io: {read: number; write: number; readIops: number; writeIops: number; util: number}; totals: {read: number; written: number} | null;
  volumes: DiskVolume[]; usage: {used: number; total: number} | null; system: boolean; smart: DiskSmart | null; smartAt: number | null;
  history: {at: number; read: number; write: number; util: number; temperature: number | null}[];
};
export type PlugDevice = {
  name: string | null; model: string | null; firmware: string | null; hardware: string | null; on: boolean; onFor: number | null;
  signal: number | null; rssi: number | null; overheated: boolean; protection: string[]; timeDiff: number | null; region: string | null;
};
/** Live power from the smart plug the server is plugged into (watts; energy in Wh; runtimes in minutes). */
export type EnergyLive = {
  configured: boolean; host?: string | null; pricePerKwh?: number | null; currency?: string; monthlyCost?: number | null; costBasis?: 'always-on' | 'predicted' | null;
  available?: boolean; error?: string;
  watts?: number | null; today?: number | null; month?: number | null; todayRuntime?: number | null; monthRuntime?: number | null; at?: number;
  device?: PlugDevice | null;
};
export type EnergyHistory = {
  power: {at: number; watts: number | null}[]; average: number | null; covered: number;
  hours: {hour: number; wh: number}[]; currentHour: number; days: {date: string; wh: number}[]; months: {month: string; wh: number}[];
  timeDiff: number; region: string | null;
};
export type CostEstimate = {kwhMonth: number; cost: number; perKwh: number; perDay: number; tiers: {tier: number; kwh: number; price: number}[]; household: number};
export type EnergyEstimate = {
  tariff: {id: string; name: string; effective: string | null; vat: number; currency: string; tiers: [number | null, number][]};
  householdKwh: number; awakeW: number; asleepW: number | null; source: 'log' | 'plug' | 'live'; basis: 'always-on' | 'predicted'; perKwh: number;
  alwaysOn: CostEstimate;
  predicted: (CostEstimate & {days: number; needed: number; ready: boolean; hoursOn: number; dailyWh: number}) | null;
  log: {started: number | null; today: {awakeHours: number} | null; days: {date: string; awakeHours: number; awakeWatts: number | null; wh: number | null}[]};
};
export type Energy = EnergyLive & {history?: EnergyHistory | null; historyError?: string; estimate?: EnergyEstimate | null};
export type Container = {ID: string; Names: string; Image: string; State: string; Status: string; Ports?: string; RunningFor?: string};
export type Session = {name: string; windows: number; attached: number; created: number};
export type Proc = {pid: number; name: string; cpu: number; memory: number; elapsed: number};
export type Agent = {name: string; installed?: boolean; processes?: Proc[]};
export type Model = {name: string; size: number; size_vram: number};
export type SleepInfo = {awake: number; asleep: number; bootAt: number; count: number; periods: {from: number; to: number}[]};
export type Status = {
  at: number;
  sleep?: SleepInfo;
  hostname: string;
  user?: string;
  platform: string;
  cpuModel?: string;
  cores: number;
  cpu: number;
  memory: {used: number; total: number; percent: number};
  disk: {used: number; total: number; percent: number} | null;
  uptime: number;
  load: number[];
  network: Point;
  history: Point[];
  interfaces: {name: string; address: string}[];
  containers: {available: boolean; error?: string; items: Container[]};
  sessions: {available: boolean; error?: string; items: Session[]};
  agents: Agent[];
  models: Model[];
  ollamaOnline: boolean;
  processes: Proc[];
  gpu?: {available: boolean; error?: string; items: Gpu[]};
  disks?: {available: boolean; error?: string; items: Disk[]; setupCommand?: string};
  energy?: EnergyLive;
  features?: Features;
  events: {message: string; at: number}[];
  token: string;
  version?: string;
  updateAvailable?: boolean;
  alertsUnread?: number;
};

export type FeatureId = 'docker' | 'tmux' | 'ai' | 'traffic' | 'energy' | 'gpu';
/** Whether an optional part of the dashboard applies to this machine (detected, or forced in the config). */
export type Feature = {on: boolean; detected: boolean; forced: boolean; reason: string};
export type Features = Record<FeatureId, Feature>;

export type Level = 'ok' | 'warn' | 'critical' | 'offline' | 'pending';
