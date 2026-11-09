import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {parseGpus, parseApps, parseFdinfo, lookupPciName, displayName, createGpuReader} from '../server/gpu.mjs';

const PCI_IDS = `# test
1002  Advanced Micro Devices, Inc. [AMD/ATI]
\t73bf  Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]
\t1638  Cezanne [Radeon Vega Series / Radeon Vega Mobile Series]
10de  NVIDIA Corporation
\t2487  GA104 [GeForce RTX 3060]
8086  Intel Corporation
\t9a49  TigerLake-LP GT2 [Iris Xe Graphics]
\t56a0  DG2 [Arc A770]
\t73bf  Not a GPU (same id under another vendor)
`;

function tree(files, links = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hb-gpu-'));
  for (const [p, v] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), {recursive: true}); writeFileSync(join(root, p), String(v)); }
  for (const [p, target] of Object.entries(links)) { mkdirSync(dirname(join(root, p)), {recursive: true}); symlinkSync(target, join(root, p)); }
  return root;
}
const pci = (addr, files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`sys/bus/pci/devices/${addr}/${k}`, v]));
const noSmi = async () => { throw Object.assign(new Error('missing'), {code: 'ENOENT'}); };

test('nvidia-smi rows: N/A → null, bus id normalised', () => {
  const [g] = parseGpus('00000000:01:00.0, 0, GPU-abc, NVIDIA GeForce RTX 3060, 42, 3, 1024, 12288, 61, [N/A], 170.00, [Not Supported], 1800, 2130, P2, 595.99.02\n');
  assert.equal(g.busId, '0000:01:00.0');
  assert.equal(g.utilization, 42);
  assert.equal(g.memory.percent, 8);
  assert.equal(g.power, null);
  assert.equal(g.fan, null);
  const apps = parseApps('GPU-abc, 1234, /usr/bin/ollama, 4096\nGPU-abc, 99, /opt/app, beta/run, 10\n');
  assert.deepEqual(apps.map(a => [a.pid, a.name, a.memory / 1048576]), [[1234, 'ollama', 4096], [99, 'run', 10]]);
  assert.deepEqual(parseGpus(''), []);
});

test('pci.ids lookup stays inside the vendor block and names read naturally', () => {
  assert.equal(lookupPciName(PCI_IDS, '0x1002', '0x73bf'), 'Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]');
  assert.equal(lookupPciName(PCI_IDS, '0x10de', '0x73bf'), null);
  assert.equal(displayName('amd', 'Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]', '0x73bf'), 'AMD Radeon RX 6800/6800 XT / 6900 XT');
  assert.equal(displayName('intel', 'TigerLake-LP GT2 [Iris Xe Graphics]', '0x9a49'), 'Intel Iris Xe Graphics');
  assert.equal(displayName('amd', null, '0x1234'), 'AMD GPU (0x1234)');
});

test('fdinfo: amdgpu and xe/i915 formats', () => {
  const a = parseFdinfo('drm-driver:\tamdgpu\ndrm-pdev:\t0000:03:00.0\ndrm-client-id:\t7\ndrm-memory-vram:\t2048 KiB\ndrm-memory-gtt:\t512 KiB\ndrm-engine-gfx:\t1000 ns\ndrm-engine-compute:\t500 ns\n');
  assert.deepEqual(a, {pdev: '0000:03:00.0', client: '7', engines: {gfx: 1000, compute: 500}, vram: 2048 * 1024, system: 512 * 1024});
  const i = parseFdinfo('drm-driver:\ti915\ndrm-pdev:\t0000:00:02.0\ndrm-client-id:\t3\ndrm-engine-render:\t900 ns\ndrm-engine-capacity-video:\t2\ndrm-resident-system0:\t64 MiB\n');
  assert.deepEqual(i.engines, {render: 900});
  assert.equal(i.system, 64 * 1048576);
  assert.equal(parseFdinfo('pos: 0\nflags: 02\n'), null);
});

test('AMD discrete + Intel iGPU via sysfs, with per-process use from fdinfo', async () => {
  const amd = '0000:03:00.0', igpu = '0000:00:02.0';
  const root = tree({
    'pci.ids': PCI_IDS,
    ...pci(amd, {class: '0x030000', vendor: '0x1002', device: '0x73bf', gpu_busy_percent: 37, mem_busy_percent: 5,
      mem_info_vram_used: 2 * 1073741824, mem_info_vram_total: 16 * 1073741824, pp_dpm_sclk: '0: 500Mhz\n1: 2100Mhz *\n2: 2575Mhz\n',
      'hwmon/hwmon3/temp1_input': 61000, 'hwmon/hwmon3/power1_average': 145500000, 'hwmon/hwmon3/power1_cap': 255000000,
      'hwmon/hwmon3/pwm1': 128, 'hwmon/hwmon3/pwm1_max': 255, 'hwmon/hwmon3/fan1_input': 1450, 'hwmon/hwmon3/freq1_input': 2100000000, 'drm/card1/dev': ''}),
    ...pci(igpu, {class: '0x030000', vendor: '0x8086', device: '0x9a49', 'drm/card0/gt/gt0/rc6_residency_ms': 10000, 'drm/card0/gt_act_freq_mhz': 1100, 'drm/card0/gt_RP0_freq_mhz': 1300}),
    ...pci('0000:05:00.0', {class: '0x030000', vendor: '0x1a03', device: '0x2000'}), // ASPEED BMC VGA: ignored
    'proc/100/comm': 'blender', 'proc/100/fdinfo/5': `drm-pdev:\t${amd}\ndrm-client-id:\t1\ndrm-engine-gfx:\t0 ns\ndrm-memory-vram:\t1048576 KiB\n`,
    'proc/100/fdinfo/6': `drm-pdev:\t${amd}\ndrm-client-id:\t1\ndrm-engine-gfx:\t0 ns\ndrm-memory-vram:\t1048576 KiB\n`, // same client, second fd
    'proc/200/comm': 'gnome-shell', 'proc/200/fdinfo/9': `drm-pdev:\t${igpu}\ndrm-client-id:\t4\ndrm-engine-render:\t0 ns\ndrm-resident-system0:\t32 MiB\n`,
  }, {
    [`sys/bus/pci/devices/${amd}/driver`]: '../../../bus/pci/drivers/amdgpu',
    [`sys/bus/pci/devices/${igpu}/driver`]: '../../../bus/pci/drivers/i915',
    'sys/bus/pci/devices/0000:05:00.0/driver': '../../../bus/pci/drivers/ast',
    'proc/100/fd/5': '/dev/dri/renderD128', 'proc/100/fd/6': '/dev/dri/card1', 'proc/100/fd/1': '/dev/null',
    'proc/200/fd/9': '/dev/dri/renderD129',
  });
  try {
    const read = createGpuReader({sys: join(root, 'sys'), proc: join(root, 'proc'), smi: noSmi, pciIds: [join(root, 'pci.ids')]});
    let r = await read(1_000_000);
    assert.equal(r.items.length, 2);
    const [a, i] = r.items; // discrete first
    assert.equal(a.name, 'AMD Radeon RX 6800/6800 XT / 6900 XT');
    assert.deepEqual([a.kind, a.driver, a.utilization, a.memory.percent, a.temperature, a.power, a.powerLimit, a.fan, a.fanRpm, a.clock, a.clockMax],
      ['discrete', 'amdgpu', 37, 13, 61, 145.5, 255, 50, 1450, 2100, 2575]);
    assert.deepEqual(a.processes, [{pid: 100, name: 'blender', memory: 1073741824, utilization: null}]);
    assert.equal(i.name, 'Intel Iris Xe Graphics');
    assert.equal(i.kind, 'integrated');
    assert.equal(i.utilization, null); // needs two samples
    assert.equal(i.memory, null);
    assert.equal(i.clock, 1100);

    // 5 s later: iGPU idle 3.5 s of 5 s → 30 % busy; blender used 2.5 s of gfx in 10 s → 25 %
    writeFileSync(join(root, `sys/bus/pci/devices/${igpu}/drm/card0/gt/gt0/rc6_residency_ms`), '13500');
    r = await read(1_005_000);
    assert.equal(r.items[1].utilization, 30);
    assert.equal(r.items[1].history.length, 2);
    writeFileSync(join(root, 'proc/100/fdinfo/5'), `drm-pdev:\t${amd}\ndrm-client-id:\t1\ndrm-engine-gfx:\t2500000000 ns\ndrm-memory-vram:\t1048576 KiB\n`);
    writeFileSync(join(root, 'proc/100/fdinfo/6'), `drm-pdev:\t${amd}\ndrm-client-id:\t1\ndrm-engine-gfx:\t2500000000 ns\ndrm-memory-vram:\t1048576 KiB\n`);
    r = await read(1_010_000);
    assert.equal(r.items[0].processes[0].utilization, 25);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('AMD APU is integrated; Intel xe discrete reads idle residency and energy-based power', async () => {
  const apu = '0000:c4:00.0', arc = '0000:03:00.0';
  const root = tree({
    'pci.ids': PCI_IDS,
    ...pci(apu, {class: '0x030000', vendor: '0x1002', device: '0x1638', gpu_busy_percent: 4, mem_info_vram_used: 100 * 1048576, mem_info_vram_total: 2 * 1073741824}),
    ...pci(arc, {class: '0x030000', vendor: '0x8086', device: '0x56a0', 'tile0/gt0/gtidle/idle_residency_ms': 0, 'tile0/gt0/freq0/act_freq': 2000, 'tile0/gt0/freq0/rp0_freq': 2400,
      'hwmon/hwmon5/energy1_input': 0, 'hwmon/hwmon5/power1_max': 190000000}),
  }, {
    [`sys/bus/pci/devices/${apu}/driver`]: '../../../bus/pci/drivers/amdgpu',
    [`sys/bus/pci/devices/${arc}/driver`]: '../../../bus/pci/drivers/xe',
  });
  try {
    const read = createGpuReader({sys: join(root, 'sys'), proc: join(root, 'proc'), smi: noSmi, pciIds: [join(root, 'pci.ids')]});
    await read(0);
    writeFileSync(join(root, `sys/bus/pci/devices/${arc}/tile0/gt0/gtidle/idle_residency_ms`), '1000');
    writeFileSync(join(root, `sys/bus/pci/devices/${arc}/hwmon/hwmon5/energy1_input`), String(200e6)); // 200 J in 2 s
    const r = await read(2000);
    const [arcG, apuG] = r.items;
    assert.deepEqual([arcG.name, arcG.kind, arcG.driver, arcG.utilization, arcG.power, arcG.powerLimit, arcG.clock, arcG.clockMax], ['Intel Arc A770', 'discrete', 'xe', 50, 100, 190, 2000, 2400]);
    assert.deepEqual([apuG.name, apuG.kind, apuG.utilization], ['AMD Radeon Vega Series / Radeon Vega Mobile Series', 'integrated', 4]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('NVIDIA proprietary driver is read through nvidia-smi and matched by bus id; missing tool is reported', async () => {
  const root = tree({...pci('0000:01:00.0', {class: '0x030000', vendor: '0x10de', device: '0x2487'})}, {'sys/bus/pci/devices/0000:01:00.0/driver': '../../../bus/pci/drivers/nvidia'});
  const smi = async args => args[0].startsWith('--query-gpu')
    ? '00000000:01:00.0, 0, GPU-x, NVIDIA GeForce RTX 3060, 55, 10, 6144, 12288, 70, 120.5, 170.00, 40, 1800, 2130, P2, 595.99.02\n'
    : 'GPU-x, 42, /usr/bin/ollama, 6000\n';
  try {
    let r = await createGpuReader({sys: join(root, 'sys'), proc: join(root, 'proc'), smi})(0);
    assert.deepEqual([r.items[0].name, r.items[0].utilization, r.items[0].memory.percent, r.items[0].processes[0].name], ['NVIDIA GeForce RTX 3060', 55, 50, 'ollama']);
    r = await createGpuReader({sys: join(root, 'sys'), proc: join(root, 'proc'), smi: noSmi, pciIds: []})(0);
    assert.equal(r.items.length, 1);
    assert.match(r.items[0].note, /nvidia-smi not found/);
    r = await createGpuReader({sys: join(root, 'nothing'), proc: join(root, 'proc'), smi: noSmi})(0);
    assert.equal(r.available, false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
