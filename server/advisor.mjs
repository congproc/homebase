// Power-saving advisor: checks this machine for the usual sources of wasted watts and says what each is worth.
// Every check is read-only. Watt figures are measured where possible (plug, nvidia-smi) and labelled as estimates
// otherwise; the dashboard turns them into money with the plug's effective price per kWh.
import {execFile} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import {getDesktop} from './desktop.mjs';
import {readEnergy} from './energy.mjs';
import {getPowerProfile} from './powerprofile.mjs';
import {getPowerState} from './services.mjs';

const exec = (bin, args) => new Promise(resolve => execFile(bin, args, {timeout: 8000}, (e, out) => resolve(e ? '' : out.trim())));
const text = p => readFile(p, 'utf8').then(s => s.trim()).catch(() => '');
const ASLEEP_W = 3; // a suspended desktop PC typically draws 1–5 W at the wall

/** Hours between two HH:MM times, across midnight. */
export const hoursBetween = (from, to) => {
  const [a, b] = [from, to].map(t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  return ((b - a + 1440) % 1440) / 60;
};

/** Deepest CPU idle state the kernel can use (from cpu0's cpuidle states), e.g. "C10" or "C3_ACPI". */
async function deepestIdle() {
  const dir = '/sys/devices/system/cpu/cpu0/cpuidle';
  const states = (await readdir(dir).catch(() => [])).filter(n => /^state\d+$/.test(n));
  const names = await Promise.all(states.map(async s => ((await text(`${dir}/${s}/disable`)) === '1' ? null : text(`${dir}/${s}/name`))));
  const levels = names.filter(Boolean).map(n => ({name: n, level: Number(n.match(/^C(\d+)/)?.[1] ?? 0)}));
  return levels.sort((a, b) => b.level - a.level)[0] || null;
}

/** The checks, from facts gathered elsewhere (kept pure so it can be tested). */
export function advise(f) {
  const items = [];
  const total = f.watts;
  const share = w => (total ? ` (${Math.round((w / total) * 100)}% of what the server draws now)` : '');

  items.push(f.profileMode === 'auto'
    ? {id: 'profile', status: 'ok', title: 'Auto power profile is on', detail: 'The server stays on a frugal profile and boosts to full performance only while it is busy.'}
    : {id: 'profile', status: 'suggest', title: f.profileMode === 'off' ? 'Let Homebase manage the power profile' : `Fixed “${f.profileMode}” profile`,
      detail: 'Auto runs on Eco while idle and switches to Performance only while the server is busy.',
      watts: null, wattsNote: 'Measured in the report below after a day', action: {kind: 'profile'}});

  for (const g of f.gpus) {
    const idle = (g.utilization ?? 0) < 5 && g.draw != null;
    if (!idle) continue;
    const extra = Math.max(0, g.draw - 12);
    if (g.display && extra >= 4) items.push({id: `gpu${g.index}-display`, status: 'suggest', title: `${g.name} idles at ${g.draw.toFixed(0)} W with a display attached`,
      detail: `A connected monitor keeps the card's memory clock up${share(g.draw)}. Unplug or switch off the monitor when unused${f.desktop?.running ? ' and turn the desktop off' : ''}.`,
      watts: extra, wattsNote: 'estimate', ...(f.desktop?.running ? {action: {kind: 'page', page: 'power/sleep', label: 'Desktop settings'}} : {action: {kind: 'note', label: 'Unplug the monitor'}})});
    else items.push({id: `gpu${g.index}-idle`, status: extra >= 6 ? 'info' : 'ok', title: `${g.name} idles at ${g.draw.toFixed(0)} W`,
      detail: extra >= 6 ? `That is high for an idle card${share(g.draw)}. Check that nothing keeps it busy (nvidia-smi) and that the driver's persistence daemon is running.` : 'Normal idle draw for this card.'});
  }

  if (f.desktop?.installed) items.push(f.desktop.running
    ? {id: 'desktop', status: 'suggest', title: 'The desktop (GUI) is running', detail: 'A headless server doesn’t need it; turning it off frees memory and GPU power.', watts: 3, wattsNote: 'estimate', action: {kind: 'page', page: 'power/sleep', label: 'Turn off'}}
    : {id: 'desktop', status: 'ok', title: 'Desktop is off', detail: 'Nothing graphical is running on the server.'});

  if (f.sleep) {
    const hours = hoursBetween(f.sleep.sleepTime, f.sleep.wakeTime);
    items.push(f.sleep.enabled
      ? {id: 'night-sleep', status: 'ok', title: `Sleeps ${hours.toFixed(1)} h a night`, detail: `${f.sleep.sleepTime}–${f.sleep.wakeTime}, unless something is still running.`}
      : {id: 'night-sleep', status: 'suggest', title: 'Nightly sleep is off', detail: 'The biggest saving: asleep, the server draws only a few watts.',
        watts: total ? ((total - ASLEEP_W) * hours) / 24 : null, wattsNote: `averaged over the day, for ${hours.toFixed(1)} h of sleep`, action: {kind: 'page', page: 'power/sleep', label: 'Sleep settings'}});
  }

  if (f.idle && f.vendor === 'GenuineIntel' && f.idle.level > 0 && f.idle.level < 6)
    items.push({id: 'cstates', status: 'suggest', title: `CPU can only idle down to ${f.idle.name}`,
      detail: 'The BIOS hides the deep idle states (C6–C10). In the BIOS enable “CPU C States” and set “Package C State” to Auto or C10.',
      watts: null, wattsNote: 'often several watts; varies by board', action: {kind: 'note', label: 'BIOS setting'}});
  else if (f.idle?.level >= 6) items.push({id: 'cstates', status: 'ok', title: `Deep CPU idle states available (${f.idle.name})`, detail: 'The CPU can power down fully between bursts of work.'});

  if (f.aspm && f.aspmFirmwareOnly)
    items.push({id: 'aspm', status: 'suggest', title: 'The BIOS keeps PCIe link power saving from Linux',
      detail: 'Linux can’t manage PCIe link sleep until the BIOS allows it. In the BIOS enable “Native ASPM” and set the PCIe/PCH/DMI ASPM options to L1 or Auto.',
      watts: null, wattsNote: 'usually 1–3 W, more with deep C-states', action: {kind: 'note', label: 'BIOS setting'}});
  else if (f.aspm && /\[default\]|\[performance\]/.test(f.aspm))
    items.push({id: 'aspm', status: 'info', title: 'PCIe link power saving is at the firmware default',
      detail: 'Add this kernel parameter so idle PCIe links can sleep. Advanced: a few devices misbehave with it.',
      watts: null, wattsNote: 'usually 1–3 W', action: {kind: 'command', command: 'pcie_aspm.policy=powersupersave', label: 'Kernel parameter'}});

  const order = {suggest: 0, info: 1, ok: 2};
  return items.sort((a, b) => order[a.status] - order[b.status] || (b.watts ?? 0) - (a.watts ?? 0));
}

export async function getAdvice() {
  const [energy, profile, desktop, sleep, idle, aspm, cpuinfo, display, aspmLog] = await Promise.all([
    readEnergy().catch(() => null), getPowerProfile().catch(() => null), getDesktop().catch(() => null), getPowerState().catch(() => null),
    deepestIdle(), text('/sys/module/pcie_aspm/parameters/policy'), text('/proc/cpuinfo'),
    exec('nvidia-smi', ['--query-gpu=index,display_active', '--format=csv,noheader']),
    // The kernel logs at boot when the firmware (ACPI FADT) withholds ASPM; the policy parameter is then ignored.
    exec('journalctl', ['-k', '-b', '--no-pager', '-o', 'cat', '--grep', 'FADT indicates ASPM is unsupported|OS doesn.t have ASPM control']),
  ]);
  const displays = Object.fromEntries(display.split('\n').filter(Boolean).map(l => { const [i, a] = l.split(',').map(s => s.trim()); return [i, a === 'Enabled']; }));
  const watts = energy?.available ? energy.watts : null;
  const items = advise({
    watts, profileMode: profile?.settings.mode ?? 'off', desktop, sleep: sleep?.installed ? sleep.config : null, idle, aspm, aspmFirmwareOnly: !!aspmLog,
    vendor: cpuinfo.match(/vendor_id\s*:\s*(\S+)/)?.[1] || '',
    gpus: (profile?.system.gpus || []).map(g => ({...g, display: !!displays[g.index]})),
  });
  return {items, watts, pricePerKwh: energy?.pricePerKwh ?? null, currency: energy?.currency || ''};
}
