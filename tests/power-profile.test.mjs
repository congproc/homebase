import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS, account, autoTarget, busyReasons, parseSettings, parseSmi, report} from '../server/powerprofile.mjs';
import {advise, hoursBetween} from '../server/advisor.mjs';

test('settings are validated and clamped', () => {
  assert.deepEqual(parseSettings(null), DEFAULTS);
  assert.deepEqual(parseSettings({mode: 'turbo', idleProfile: 'performance', cpuBusy: 500, gpuBusy: -3, calmMinutes: '2', ollamaBoost: 'yes', extra: 1}),
    {...DEFAULTS, cpuBusy: 95, gpuBusy: 5, calmMinutes: 2});
  assert.equal(parseSettings({mode: 'auto'}).mode, 'auto');
});

test('auto mode boosts at once and only falls back after the calm period', () => {
  const s = parseSettings({mode: 'auto', calmMinutes: 3});
  const busy = busyReasons({cpu: 70, gpu: 0, models: 0}, s);
  assert.deepEqual(busy, ['CPU 70%']);
  assert.equal(autoTarget({reasons: busy, current: 'eco', lastBusyAt: 0, now: 0, settings: s}).profile, 'performance');
  const now = 10 * 60000;
  assert.equal(autoTarget({reasons: [], current: 'performance', lastBusyAt: now - 60000, now, settings: s}).profile, 'performance');
  assert.equal(autoTarget({reasons: [], current: 'performance', lastBusyAt: now - 4 * 60000, now, settings: s}).profile, 'eco');
  assert.deepEqual(busyReasons({cpu: 5, gpu: null, models: 1}, s), ['1 Ollama model loaded']);
  assert.deepEqual(busyReasons({cpu: 5, gpu: null, models: 1}, {...s, ollamaBoost: false}), []);
});

test('nvidia-smi rows parse, [N/A] becomes null', () => {
  assert.deepEqual(parseSmi('0, NVIDIA GeForce RTX 3060, 3, 21.50, 170.00, 100.00, 170.00, P8\n1, Old, [N/A], [N/A], [N/A], [N/A], [N/A], P0'), [
    {index: 0, name: 'NVIDIA GeForce RTX 3060', utilization: 3, draw: 21.5, limit: 170, min: 100, default: 170, pstate: 'P8'},
    {index: 1, name: 'Old', utilization: null, draw: null, limit: null, min: null, default: null, pstate: 'P0'},
  ]);
});

test('time and energy are accounted per profile; gaps are ignored', () => {
  const t = new Date(2026, 10, 15, 12).getTime();
  const st = {version: 1, months: {}};
  account(st, 'eco', 10, 40, t);
  account(st, 'eco', 10, null, t);
  account(st, 'eco', 3600, 40, t); // a suspend gap
  account(st, 'performance', 10, 80, t);
  assert.deepEqual(st.months['2026-11'].eco, {seconds: 20, measuredSeconds: 10, wattSeconds: 400});
  const r = report({version: 1, months: {'2026-11': {eco: {seconds: 7200, measuredSeconds: 3600, wattSeconds: 3600 * 45}}}}, t);
  assert.equal(r[0].profiles.eco.hours, 2);
  assert.equal(r[0].profiles.eco.avgWatts, 45);
});

test('advisor ranks suggestions first and prices night sleep', () => {
  assert.equal(hoursBetween('00:30', '05:00'), 4.5);
  assert.equal(hoursBetween('23:00', '01:00'), 2);
  const items = advise({watts: 51, profileMode: 'off', desktop: {installed: true, running: false}, sleep: {enabled: false, sleepTime: '00:00', wakeTime: '06:00'},
    idle: {name: 'C3_ACPI', level: 3}, vendor: 'GenuineIntel', aspm: '[default] performance powersave powersupersave',
    gpus: [{index: 0, name: 'RTX', utilization: 0, draw: 21, display: true}]});
  assert.deepEqual(items.map(i => i.id), ['night-sleep', 'gpu0-display', 'profile', 'cstates', 'aspm', 'desktop']);
  assert.equal(items[0].watts, 12);
  const fw = advise({watts: 40, profileMode: 'auto', gpus: [], aspm: '[default] performance', aspmFirmwareOnly: true}).find(i => i.id === 'aspm');
  assert.equal(fw.action.kind, 'note');
  assert.match(fw.detail, /Native ASPM/);
  assert.ok(advise({watts: 40, profileMode: 'auto', gpus: [], idle: {name: 'C10', level: 10}, vendor: 'GenuineIntel'}).every(i => i.status === 'ok'));
});
