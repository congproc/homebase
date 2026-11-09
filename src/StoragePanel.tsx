import {AlertTriangle, Copy, HardDrive, ShieldCheck, Thermometer} from 'lucide-react';
import {toast} from 'sonner';
import {Panel, Empty, Skeleton} from './components/panels';
import {AreaChart} from './components/charts';
import {bytes, diskHealth, levelColor, levelFor, rate} from './lib/format';
import type {Disk, DiskSmart, Status} from './lib/types';

const TRANSPORT: Record<string, string> = {nvme: 'NVMe', sata: 'SATA', sas: 'SAS', usb: 'USB', ata: 'ATA', mmc: 'MMC', virtio: 'VirtIO', scsi: 'SCSI'};
const decimal = (v: number) => v >= 1e12 ? `${+(v / 1e12).toFixed(2)} TB` : `${Math.round(v / 1e9)} GB`; // drives are sold in decimal units
const hours = (h: number) => h >= 24 * 365 ? `${(h / 24 / 365).toFixed(1)} years` : h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`;
const count = (v?: number | null) => v == null ? '—' : v.toLocaleString();

function SmartBadge({s}: {s: DiskSmart | null}) {
  if (!s) return <span className="status muted"><i />SMART pending</span>;
  if (s.state === 'standby') return <span className="status muted"><i />Standby</span>;
  if (s.state !== 'ok') return <span className="status muted"><i />SMART unavailable</span>;
  if (s.level === 'critical') return <span className="status failed"><i />Failing</span>;
  if (s.level === 'warn') return <span className="status warn"><i />Check drive</span>;
  return <span className="status green"><i />Healthy</span>;
}

/** Overview cards: one per physical drive. */
function DriveCards({disks}: {disks: Disk[]}) {
  return <div className="drive-cards">{disks.map(d => {
    const h = diskHealth(d);
    const used = d.usage ? Math.round((d.usage.used / d.usage.total) * 100) : null;
    const usedL = levelFor(used ?? 0, 80, 92);
    return <a key={d.name} href={`#disk-${d.name}`} className={`drive-card level-${h.level}`} onClick={e => { e.preventDefault(); document.getElementById(`disk-${d.name}`)?.scrollIntoView({behavior: 'smooth', block: 'start'}); }}>
      <div className="drive-card-top"><span className="resource-icon amber"><HardDrive size={16} /></span><div><strong>{d.model || d.name}</strong><small>{d.kind} · {decimal(d.size)}{d.system ? ' · system' : ''}</small></div></div>
      <div className="drive-card-stats">
        <span title="Temperature"><Thermometer size={13} />{d.temperature != null ? `${Math.round(d.temperature)}°C` : '—'}</span>
        <span title="Busy time over the last reading">{d.io.util}% busy</span>
        <SmartBadge s={d.smart} />
      </div>
      <div className="meter"><span style={{width: `${used ?? 0}%`, background: usedL === 'ok' ? 'var(--amber)' : levelColor[usedL]}} /></div>
      <div className="meter-legend"><span>{d.usage ? `${bytes(d.usage.used)} of ${bytes(d.usage.total)} used` : 'Not mounted'}</span><span>{used != null ? `${used}%` : ''}</span></div>
    </a>;
  })}</div>;
}

function SmartDetails({d}: {d: Disk}) {
  const s = d.smart;
  if (!s || s.state === 'needs-setup' || s.state === 'not-installed') return null;
  if (s.state === 'standby') return <p className="dim drive-note">The drive is spun down; SMART is read again once it is awake, without waking it.</p>;
  if (s.state === 'error') return <p className="dim drive-note">SMART could not be read: {s.error}</p>;
  const rows: [string, React.ReactNode][] = [
    ['Overall assessment', s.passed == null ? '—' : s.passed ? 'Passed' : <span style={{color: 'var(--red)'}}>Failed</span>],
    ['Power-on time', s.powerOnHours != null ? `${hours(s.powerOnHours)} (${s.powerOnHours.toLocaleString()} h)` : '—'],
    ['Power cycles', count(s.powerCycles)],
    ['Unsafe shutdowns', count(s.unsafeShutdowns)],
    ...(s.availableSpare != null ? [['Available spare', `${s.availableSpare}%`] as [string, string]] : []),
    ...(s.mediaErrors != null ? [['Media errors', count(s.mediaErrors)] as [string, string]] : []),
    ...(s.errorLog != null ? [['Error log entries', count(s.errorLog)] as [string, string]] : []),
    ...(s.reallocated != null ? [['Reallocated sectors', count(s.reallocated)] as [string, string]] : []),
    ...(s.pending != null ? [['Pending sectors', count(s.pending)] as [string, string]] : []),
    ...(s.uncorrectable != null ? [['Uncorrectable sectors', count(s.uncorrectable)] as [string, string]] : []),
    ...(s.crcErrors != null ? [['Interface CRC errors', count(s.crcErrors)] as [string, string]] : []),
    ...(s.read != null ? [['Lifetime read', bytes(s.read)] as [string, string]] : []),
    ...(s.written != null ? [['Lifetime written', bytes(s.written)] as [string, string]] : []),
    ...(s.interfaceSpeed ? [['Interface speed', s.interfaceSpeed] as [string, string]] : []),
    ...(s.rotationRate ? [['Rotation rate', `${s.rotationRate} rpm`] as [string, string]] : []),
  ];
  return <div className="drive-section">
    <h4>SMART health</h4>
    {!!s.warnings?.length && <div className="gpu-note drive-warn"><AlertTriangle size={14} />{s.warnings.join(' · ')}</div>}
    <dl className="detail-list compact">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
  </div>;
}

function DrivePanel({d}: {d: Disk}) {
  const h = diskHealth(d);
  const hist = d.history || [], times = hist.map(p => p.at);
  const s = d.smart?.state === 'ok' ? d.smart : null;
  const tempL = h.reasons.some(r => r.includes('°C')) ? h.level : 'ok';
  const metrics: [string, React.ReactNode, string?][] = [
    ['Temperature', d.temperature != null ? `${d.temperature.toFixed(0)}°C` : '—', d.sensors.length > 1 ? d.sensors.map(x => `${x.label}: ${x.value}°C`).join('\n') : d.tempCrit ? `Critical at ${d.tempCrit.toFixed(0)}°C` : undefined],
    ['Read', rate(d.io.read), `${d.io.readIops.toFixed(0)} operations/s`],
    ['Write', rate(d.io.write), `${d.io.writeIops.toFixed(0)} operations/s`],
    ['Busy', `${d.io.util}%`, 'Share of time the drive had requests in flight'],
    ['Life left', s?.life != null ? `${s.life}%` : '—', 'Manufacturer wear estimate (100% = new)'],
    ['Power-on', s?.powerOnHours != null ? hours(s.powerOnHours) : '—'],
  ];
  const sub = [d.path, `${d.transport ? (TRANSPORT[d.transport] || d.transport.toUpperCase()) + ' ' : ''}${d.kind}`, decimal(d.size), d.link, d.firmware && `firmware ${d.firmware}`, d.serial && `S/N ${d.serial}`].filter(Boolean).join(' · ');
  const series = [{label: 'Read', color: 'var(--sky)', values: hist.map(p => p.read)}, {label: 'Write', color: 'var(--pink)', values: hist.map(p => p.write)}];
  return <div id={`disk-${d.name}`} className="drive-anchor"><Panel title={d.model || d.name} sub={<span className="mono-sub">{sub}</span>} className="gpu-panel drive-panel" action={<SmartBadge s={d.smart} />}>
    {h.level !== 'ok' && <div className="gpu-note" style={h.level === 'critical' ? {background: 'var(--red-bg)', color: 'var(--red)'} : undefined}><AlertTriangle size={14} />{h.reasons.join(' · ')}</div>}
    <div className="gpu-metrics">{metrics.map(([k, v, tip]) => <div key={k} title={tip}><small>{k}</small><strong style={k === 'Temperature' && tempL !== 'ok' ? {color: levelColor[tempL]} : undefined}>{v}</strong></div>)}</div>
    {hist.length > 1 && <div className="gpu-temp-chart">
      <AreaChart series={series} times={times} format={rate} height={130} />
      <div className="chart-legend">{series.map(c => <span key={c.label}><i style={{background: c.color}} />{c.label}</span>)}{d.totals && <span className="dim">Since boot: {bytes(d.totals.read)} read · {bytes(d.totals.written)} written</span>}</div>
    </div>}
    <div className="drive-section">
      <h4>Partitions & filesystems</h4>
      {d.volumes.length
        ? <div className="volume-list">{d.volumes.map(v => {
            const l = levelFor(v.percent ?? 0, 80, 92);
            return <div key={v.name} style={{paddingLeft: v.depth * 14}}>
              <span className="mono">{v.name}</span>
              <span className="dim">{[v.fstype, v.label && `“${v.label}”`, v.type !== 'part' && v.type].filter(Boolean).join(' · ') || 'unformatted'}</span>
              <span className="mono vol-mount">{v.mounts.join(', ') || <span className="dim">not mounted</span>}</span>
              {v.total ? <span className="vol-usage"><span className="meter small"><span style={{width: `${v.percent}%`, background: l === 'ok' ? 'var(--amber)' : levelColor[l]}} /></span>{bytes(v.used)} / {bytes(v.total)}</span>
                : <span className="vol-usage dim">{bytes(v.size)}</span>}
            </div>;
          })}</div>
        : <p className="dim drive-note">No partitions.{d.usage ? '' : ' The whole drive is unused or used directly.'}</p>}
    </div>
    <SmartDetails d={d} />
  </Panel></div>;
}

export default function StoragePanel({d}: {d: Status | null}) {
  if (!d) return <Panel title="Drives" sub="Discovering storage"><div style={{padding: '0 20px 20px'}}><Skeleton h={90} /></div></Panel>;
  const disks = d.disks?.items || [];
  if (!d.disks?.available || !disks.length) return <Panel title="Drives"><Empty icon={HardDrive} title="No drives found">{d.disks?.error || 'No physical drives were reported by lsblk.'}</Empty></Panel>;
  const needsSetup = disks.some(x => x.smart?.state === 'needs-setup'), notInstalled = disks.some(x => x.smart?.state === 'not-installed');
  const cmd = d.disks.setupCommand || '';
  return <div className="storage-view">
    <DriveCards disks={disks} />
    {needsSetup && <div className="setup-notice">
      <ShieldCheck size={20} />
      <div>
        <strong>Enable SMART health readings</strong>
        <p>Capacity, temperatures and throughput are live now. Drive health (wear, bad sectors, power-on time) needs root to read. Install <code>smartmontools</code>, then run the administrator setup once. It adds a rule that only allows a read-only SMART query of whole disks, and never wakes a sleeping drive.</p>
        {cmd && <div className="setup-command">
          <code>{cmd}</code>
          <button className="button" aria-label="Copy setup command" onClick={() => navigator.clipboard.writeText(cmd).then(() => toast.success('Setup command copied')).catch(() => toast.error('Copy the displayed command manually'))}><Copy size={14} /></button>
        </div>}
      </div>
    </div>}
    {!needsSetup && notInstalled && <div className="setup-notice">
      <ShieldCheck size={20} />
      <div>
        <strong>Install smartmontools for drive health</strong>
        <p>The SMART rule is in place, but <code>smartctl</code> was not found. Install it (for example <code>sudo apt install smartmontools</code>); readings appear within a few minutes.</p>
      </div>
    </div>}
    {disks.map(x => <DrivePanel key={x.name} d={x} />)}
  </div>;
}
