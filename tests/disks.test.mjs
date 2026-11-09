import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {parseDiskstats, volumesOf, smartView, createDiskReader} from '../server/disks.mjs';

const STATS = (sdaRead, sdaBusy) => `   7       0 loop0 52 0 1324 36 0 0 0 0 0 22 36 0 0 0 0 0 0
   8       0 sda 100 0 ${sdaRead} 0 50 0 2000 0 0 ${sdaBusy} 0 0 0 0 0 0 0
   8       1 sda1 100 0 ${sdaRead} 0 50 0 2000 0 0 ${sdaBusy} 0 0 0 0 0 0 0
 259       0 nvme0n1 324 0 11536 19 0 0 0 0 0 10 19 0 0 0 0 0 0
`;
const LSBLK = [
  {name: 'loop0', type: 'loop', size: 70049792, mountpoints: ['/snap/core']},
  {name: 'zram0', type: 'disk', size: 8e9, mountpoints: ['[SWAP]']},
  {name: 'nvme0n1', path: '/dev/nvme0n1', type: 'disk', size: 500107862016, model: 'WD Blue SN5000 500GB  ', serial: 'X1', rota: false, tran: 'nvme', rm: false,
    children: [{name: 'nvme0n1p1', path: '/dev/nvme0n1p1', type: 'part', size: 1e9, fstype: 'crypto_LUKS', mountpoints: [null],
      children: [{name: 'data', path: '/dev/mapper/data', type: 'crypt', size: 9e8, fstype: 'ext4', mountpoints: ['/data'], fsused: 3e8, fssize: 8e8, fsavail: 5e8}]}]},
  {name: 'sda', path: '/dev/sda', type: 'disk', size: 256060514304, model: 'Colorful SL500 256GB', vendor: 'ATA     ', rota: false, tran: 'sata', rm: false,
    children: [{name: 'sda1', path: '/dev/sda1', type: 'part', size: 2.5e11, fstype: 'ext4', mountpoints: ['/'], fsused: 1e11, fssize: 2e11, fsavail: 1e11}]},
];

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'hb-disk-'));
  for (const [p, v] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), {recursive: true}); writeFileSync(join(root, p), v); }
  return root;
}

test('parseDiskstats converts sectors to bytes', () => {
  const s = parseDiskstats(STATS(2048, 10));
  assert.equal(s.sda.read, 2048 * 512);
  assert.equal(s.sda.written, 2000 * 512);
  assert.equal(s.sda.busyMs, 10);
  assert.equal(s.nvme0n1.readOps, 324);
});

test('volumesOf flattens nested volumes with usage', () => {
  const v = volumesOf(LSBLK[2]);
  assert.deepEqual(v.map(x => [x.name, x.depth]), [['nvme0n1p1', 0], ['data', 1]]);
  assert.equal(v[0].total, undefined);
  assert.deepEqual(v[0].mounts, []);
  assert.equal(v[1].percent, 38);
});

test('smartView: NVMe wear, bytes written and warnings', () => {
  const ok = smartView({passed: true, powerOnHours: 1200, nvme: {percentage_used: 3, data_units_written: 1000, available_spare: 100, available_spare_threshold: 10, media_errors: 0, critical_warning: 0}});
  assert.equal(ok.life, 97);
  assert.equal(ok.written, 512000000);
  assert.equal(ok.level, 'ok');
  const bad = smartView({passed: true, nvme: {percentage_used: 95, media_errors: 2, critical_warning: 0}});
  assert.equal(bad.level, 'warn');
  assert.ok(bad.warnings.some(w => w.includes('media errors')));
  assert.equal(smartView({passed: false}).level, 'critical');
});

test('smartView: ATA attributes and states', () => {
  const s = smartView({passed: true, ata: [{id: 5, name: 'Reallocated_Sector_Ct', value: 100, raw: 8}, {id: 231, name: 'SSD_Life_Left', value: 88, raw: 88}, {id: 241, name: 'Total_LBAs_Written', value: 100, raw: 1000}]});
  assert.equal(s.reallocated, 8);
  assert.equal(s.life, 88);
  assert.equal(s.written, 512000);
  assert.equal(s.level, 'warn');
  assert.equal(smartView({standby: true}).state, 'standby');
  assert.equal(smartView({error: 'needs-setup'}).state, 'needs-setup');
  assert.equal(smartView({error: 'boom'}).state, 'error');
  assert.equal(smartView(null), null);
});

test('reader: physical disks only, system disk first, temps, rates and SMART', async () => {
  const sys = tree({
    'class/nvme/nvme0/firmware_rev': '291000WD  \n', 'class/nvme/nvme0/device/current_link_speed': '16.0 GT/s PCIe\n', 'class/nvme/nvme0/device/current_link_width': '4\n',
    'class/nvme/nvme0/hwmon3/temp1_input': '39850\n', 'class/nvme/nvme0/hwmon3/temp1_label': 'Composite\n', 'class/nvme/nvme0/hwmon3/temp1_max': '83850\n', 'class/nvme/nvme0/hwmon3/temp1_crit': '87850\n',
    'class/nvme/nvme0/hwmon3/temp2_input': '58850\n', 'class/nvme/nvme0/hwmon3/temp2_max': '65261850\n',
    'block/sda/device/rev': '5A0\n', 'block/sda/queue/scheduler': 'none [mq-deadline]\n',
  });
  const proc = tree({diskstats: STATS(0, 0)});
  const smartCalls = [];
  try {
    const read = createDiskReader({sys, proc, lsblk: async () => LSBLK, smartRead: async n => { smartCalls.push(n); return n === 'sda' ? {passed: true, powerOnHours: 10} : {standby: true}; }});
    let r = await read(1000);
    assert.deepEqual(r.items.map(i => i.name), ['sda', 'nvme0n1']);
    const nv = r.items[1];
    assert.equal(nv.kind, 'NVMe SSD');
    assert.equal(nv.model, 'WD Blue SN5000 500GB');
    assert.equal(nv.link, '16.0 GT/s ×4');
    assert.equal(nv.temperature, 39.9);
    assert.equal(nv.tempCrit, 87.85);
    assert.equal(nv.sensors[1].max, null);
    assert.equal(r.items[0].vendor, null);
    assert.equal(r.items[0].scheduler, 'mq-deadline');
    assert.equal(r.items[0].system, true);
    await new Promise(res => setImmediate(res));
    writeFileSync(join(proc, 'diskstats'), STATS(2048, 2500));
    r = await read(6000);
    const sda = r.items[0];
    assert.equal(sda.io.read, (2048 * 512) / 5);
    assert.equal(sda.io.util, 50);
    assert.equal(sda.smart.state, 'ok');
    assert.equal(sda.smart.powerOnHours, 10);
    assert.equal(r.items[1].smart.state, 'standby');
    assert.equal(sda.history.length, 2);
    assert.deepEqual(smartCalls.sort(), ['nvme0n1', 'sda']); // cached, not re-read every sample
  } finally { rmSync(sys, {recursive: true}); rmSync(proc, {recursive: true}); }
});
