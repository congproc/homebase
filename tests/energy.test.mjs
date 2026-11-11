import test from 'node:test';
import assert from 'node:assert/strict';
import {authHash, decrypt, deriveSession, encrypt} from '../server/tapo.mjs';
import {beat, completeDays, deviceInfo, lastDays, plugCalendar, samples, splitSamples, usage} from '../server/energy.mjs';
import {EVN_RESIDENTIAL, bill, parseTariff, serverCost, tiersBetween} from '../server/tariff.mjs';

const hex = b => Buffer.from(b).toString('hex');

test('KLAP v2 auth hash is sha256(sha1(email) + sha1(password))', () => {
  // Reference computed independently with Python's hashlib
  assert.equal(hex(authHash('user@example.com', 'secret')), 'b039216532fc844e9ae0cc8fe3ea911c9ba09c641bb96a3e1f776d93f7b5ae9b');
  assert.equal(authHash('a', 'b').length, 32);
  assert.notDeepEqual(authHash('a', 'b'), authHash('b', 'a'));
});

test('KLAP session encrypts, signs and decrypts with the sequence number', () => {
  const s = deriveSession(Buffer.alloc(16, 1), Buffer.alloc(16, 2), authHash('u', 'p'));
  assert.equal(s.key.length, 16); assert.equal(s.ivPrefix.length, 12); assert.equal(s.sig.length, 28);
  assert.ok(Number.isInteger(s.seq));
  const msg = JSON.stringify({method: 'get_energy_usage'});
  const packet = encrypt(s, s.seq + 1, msg);
  assert.equal((packet.length - 32) % 16, 0);
  assert.equal(decrypt(s, s.seq + 1, packet), msg);
  assert.notDeepEqual(encrypt(s, s.seq + 2, msg).subarray(32), packet.subarray(32)); // IV changes per request
  let wrong; try { wrong = decrypt(s, s.seq + 2, packet); } catch { wrong = null; }
  assert.notEqual(wrong, msg); // a reply is only readable with its own sequence number
});

test('usage converts milliwatts to watts and keeps Wh totals', () => {
  assert.deepEqual(usage({today_runtime: 42, month_runtime: 42, today_energy: 30, month_energy: 30, current_power: 51005}),
    {watts: 51, today: 30, month: 30, todayRuntime: 42, monthRuntime: 42});
  assert.equal(usage({current_power: 1234}).watts, 1.2);
  assert.equal(usage({}).watts, null);
});

test('deviceInfo decodes the nickname and leaves out location and Wi-Fi details', () => {
  const info = deviceInfo({nickname: Buffer.from('home-server').toString('base64'), model: 'P110M', fw_ver: '1.4.1 Build 251020', device_on: true, on_time: 2012,
    signal_level: 3, rssi: -38, power_protection_status: 'normal', overcurrent_status: 'normal', time_diff: 420, region: 'Asia/Ho_Chi_Minh',
    latitude: 1, longitude: 2, ssid: 'c3NpZA==', mac: 'AA-BB', ip: '192.168.1.50'});
  assert.equal(info.name, 'home-server');
  assert.deepEqual(info.protection, []);
  assert.equal(info.overheated, false);
  for (const k of ['latitude', 'longitude', 'ssid', 'mac', 'ip']) assert.ok(!(k in info));
  assert.deepEqual(deviceInfo({overcurrent_status: 'lasting_overcurrent'}).protection, ['lasting_overcurrent']);
});

test('plugCalendar finds local day, quarter and year starts from the plug time offset', () => {
  const t = Date.UTC(2026, 10, 11, 12, 5) / 1000; // 2026-11-11 19:05 at UTC+7
  const c = plugCalendar(t, 420);
  assert.equal(c.day, Date.UTC(2026, 10, 10, 17) / 1000);    // 11 Nov 00:00 +07
  assert.equal(c.quarter, Date.UTC(2026, 8, 30, 17) / 1000); // 1 Oct 00:00 +07
  assert.equal(c.year, Date.UTC(2025, 11, 31, 17) / 1000);   // 1 Jan 00:00 +07
  // 23:30 local is still the same local day even though UTC has rolled over
  assert.equal(plugCalendar(Date.UTC(2026, 10, 11, 16, 30) / 1000, 420).day, c.day);
});

test('samples maps the 5-minute grid and treats -1 as no reading', () => {
  assert.deepEqual(samples({start_timestamp: 1000, data: [-1, 2, 50]}), [{at: 1000000, watts: null}, {at: 1300000, watts: 2}, {at: 1600000, watts: 50}]);
});

test('lastDays stitches quarters and lines days up with plug-local dates', () => {
  const off = 420, q3 = Date.UTC(2026, 5, 30, 17) / 1000, q4 = Date.UTC(2026, 8, 30, 17) / 1000;
  const today = plugCalendar(Date.UTC(2026, 9, 5, 12) / 1000, off).day; // 5 Oct
  const prev = {start_timestamp: q3, data: Array.from({length: 92}, (_, i) => i)}; // 1 Jul = 0 ... 30 Sep = 91
  const cur = {start_timestamp: q4, data: [100, 101, 102, 103, 104, 0]};
  const days = lastDays([prev, cur], today, off, 7);
  assert.deepEqual(days, [
    {date: '2026-09-29', wh: 90}, {date: '2026-09-30', wh: 91}, {date: '2026-10-01', wh: 100}, {date: '2026-10-02', wh: 101},
    {date: '2026-10-03', wh: 102}, {date: '2026-10-04', wh: 103}, {date: '2026-10-05', wh: 104},
  ]);
});

test('EVN 5-tier bill matches the published example (300 kWh = 708,400 VND before VAT)', () => {
  assert.equal(bill(300, EVN_RESIDENTIAL.tiers), 708400);
  assert.equal(bill(100, EVN_RESIDENTIAL.tiers), 190100);
  assert.equal(bill(800, EVN_RESIDENTIAL.tiers), 190100 + 228900 + 578800 + 1036800 + 100 * 3844);
  assert.equal(bill(0, EVN_RESIDENTIAL.tiers), 0);
});

test('server kWh are priced on top of the household: what the bill drops by without them', () => {
  const evn = {...EVN_RESIDENTIAL, vat: 0.08};
  const c = serverCost(27, 300, evn); // all in tier 3
  assert.deepEqual(c.tiers, [{tier: 3, kwh: 27, price: 2894}]);
  assert.equal(Math.round(c.cost), Math.round(27 * 2894 * 1.08));
  const split = serverCost(27, 205, evn); // 22 kWh in tier 2, 5 in tier 3
  assert.deepEqual(split.tiers.map(t => [t.tier, Math.round(t.kwh)]), [[2, 22], [3, 5]]);
  assert.equal(Math.round(split.cost), Math.round((22 * 2289 + 5 * 2894) * 1.08));
  // No household figure: priced as if alone on its own meter (cheapest tiers first).
  assert.equal(Math.round(serverCost(50, 0, {...evn, vat: 0}).cost), 50 * 1901);
  assert.deepEqual(tiersBetween(90, 110, EVN_RESIDENTIAL.tiers).map(t => t.tier), [1, 2]);
});

test('parseTariff accepts evn, a custom tier list or a flat price, and rejects malformed tiers', () => {
  assert.equal(parseTariff('evn', {vat: 0.1}).vat, 0.1);
  assert.equal(parseTariff('evn').vat, 0.08);
  assert.deepEqual(parseTariff(undefined, {pricePerKwh: 0.3, currency: 'EUR'}).tiers, [[null, 0.3]]);
  assert.equal(parseTariff({tiers: [[null, 100], [50, 200]]}), null); // open-ended tier must be last
  assert.equal(parseTariff(undefined), null);
  assert.deepEqual(parseTariff({tiers: [[100, 10], [null, 20]], currency: 'USD', vat: 0}).tiers, [[100, 10], [null, 20]]);
});

test('on-time log counts heartbeats and treats long gaps (suspend) as off', () => {
  const tz = 420, t0 = Date.UTC(2026, 10, 11, 10) / 1000 * 1000; // 17:00 local
  const log = {version: 1, started: null, days: {}};
  beat(log, t0, 0, 50, tz); // first beat only marks the start
  assert.equal(log.started, t0);
  beat(log, t0 + 60000, t0, 50, tz);
  beat(log, t0 + 120000, t0 + 60000, null, tz); // plug unreadable: awake but not measured
  beat(log, t0 + 3600000, t0 + 120000, 50, tz); // an hour asleep: not counted
  assert.deepEqual(log.days['2026-11-11'], {awake: 120, measured: 60, wattSeconds: 3000});
});

test('completeDays skips the day logging began and today, and joins the plug daily energy', () => {
  const log = {version: 1, started: Date.UTC(2026, 10, 11, 12) / 1000 * 1000, days: {
    '2026-11-11': {awake: 3600, measured: 3600, wattSeconds: 180000},
    '2026-11-12': {awake: 63000, measured: 63000, wattSeconds: 63000 * 50},
    '2026-11-13': {awake: 1000, measured: 0, wattSeconds: 0},
  }};
  const days = completeDays(log, '2026-11-13', [{date: '2026-11-12', wh: 900}]);
  assert.deepEqual(days, [{date: '2026-11-12', awakeHours: 17.5, awakeWatts: 50, wh: 900}]);
});

test('splitSamples separates awake draw from standby', () => {
  const r = splitSamples([{watts: 2}, {watts: null}, {watts: 50}, {watts: 54}, {watts: 1}]);
  assert.equal(r.awake, 52); assert.equal(r.asleep, 1.5); assert.ok(r.threshold > 2 && r.threshold < 50);
  assert.equal(splitSamples([]).awake, null);
});
