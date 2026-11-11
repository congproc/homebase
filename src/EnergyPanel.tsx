import {useCallback, useEffect, useState} from 'react';
import {AlertTriangle, Plug} from 'lucide-react';
import {AreaChart} from './components/charts';
import {Panel, Pill, Skeleton} from './components/panels';
import {cost, elapsed, energy, money, watts} from './lib/format';
import type {Energy, EnergyEstimate, EnergyLive} from './lib/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (date: string) => { const [, m, d] = date.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const hm = (t: number) => new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
const SIGNAL = ['No signal', 'Weak', 'Fair', 'Good', 'Excellent'];

type Bar = {label: string; value: number};

/** Simple bar chart with a hover readout; `current` marks the bar still filling up (this hour, today, this month). */
function Bars({title, items, current, format}: {title: string; items: Bar[]; current?: number; format: (v: number) => string}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...items.map(b => b.value));
  const shown = hover ?? current ?? items.length - 1;
  return (
    <div className="en-bars-wrap">
      <div className="en-bars-head"><h4>{title}</h4><span><small>{items[shown]?.label}</small><strong>{items[shown] ? format(items[shown].value) : '—'}</strong></span></div>
      <div className="en-bars" onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
        {items.map((b, i) => <span key={b.label} className={`${hover === i ? 'on' : ''}${current === i ? ' now' : ''}`} onPointerEnter={() => setHover(i)} title={`${b.label}: ${format(b.value)}`}>
          <i style={{height: `${b.value ? Math.max(3, (b.value / max) * 100) : 0}%`}} />
        </span>)}
      </div>
      <div className="en-bars-axis"><span>{items[0]?.label}</span><span>{items.at(-1)?.label}</span></div>
    </div>
  );
}

const tierText = (tiers: {tier: number}[]) => tiers.length ? `tier ${tiers[0].tier}${tiers.length > 1 ? `–${tiers.at(-1)!.tier}` : ''}` : '';
const nextDay = (ms: number) => { const d = new Date(ms); d.setDate(d.getDate() + 1); return d.toLocaleDateString([], {day: 'numeric', month: 'short'}); };

/** What the server costs: running 24/7 at its measured awake power, and (once on-time is logged) its real schedule. */
function CostSection({est}: {est: EnergyEstimate}) {
  const cur = est.tariff.currency, m = (v: number) => money(v, cur);
  const a = est.alwaysOn, p = est.predicted;
  const fullDays = p?.days ?? 0;
  const priceNote = (c: {tiers: {tier: number; price: number}[]}) => c.tiers.length
    ? `${tierText(c.tiers)} · ${c.tiers.map(t => m(t.price)).filter((v, i, l) => l.indexOf(v) === i).join(' / ')} per kWh before VAT` : '';
  return (
    <div className="en-cost">
      <div className={`en-cost-card${est.basis === 'always-on' ? ' lead' : ''}`}>
        <small>If it runs 24/7</small>
        <strong>{m(a.cost)}<small> / month</small></strong>
        <p>{energy(a.kwhMonth * 1000)} a month at <b>{watts(est.awakeW)}</b> while on{est.source === 'plug' ? ' (from the plug’s recent readings)' : est.source === 'log' ? ' (measured over the last week)' : ''} · {m(a.perDay)} a day</p>
        <p className="dim">{priceNote(a)}</p>
      </div>
      <div className={`en-cost-card${est.basis === 'predicted' ? ' lead' : ''}`}>
        <small>From its real on-time {p && !p.ready && <em className="en-tag">provisional</em>}</small>
        {p ? <>
          <strong>{m(p.cost)}<small> / month</small></strong>
          <p>On <b>{p.hoursOn.toFixed(1)} h</b> a day on average over {p.days} full day{p.days === 1 ? '' : 's'} · {energy(p.dailyWh)} a day · {energy(p.kwhMonth * 1000)} a month
            {a.cost - p.cost > 0 && <> · <b>{m(a.cost - p.cost)}</b> less than 24/7</>}</p>
        </> : <>
          <strong className="en-learning">Learning its schedule…</strong>
          <p>Homebase logs every minute the machine is awake. The first prediction appears after the first full day{est.log.started ? ` (${nextDay(est.log.started)})` : ''}, and it becomes the main estimate after 7 days.</p>
        </>}
        <div className="en-progress" title={`${fullDays} of 7 full days logged`}><span style={{width: `${Math.min(100, fullDays / 7 * 100)}%`}} /></div>
        <p className="dim">{fullDays} of 7 days logged{est.log.today ? ` · on ${est.log.today.awakeHours.toFixed(1)} h so far today` : ''}{est.log.started ? ` · since ${new Date(est.log.started).toLocaleString([], {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})}` : ''}</p>
      </div>
    </div>
  );
}

/** Drop the empty stretch before the plug started recording, keeping at least `min` entries. */
const sinceFirst = <T extends {wh: number}>(list: T[], min: number) => {
  const first = list.findIndex(x => x.wh > 0);
  return first < 0 ? list.slice(-min) : list.slice(Math.min(first, Math.max(0, list.length - min)));
};

/** Wall power of the whole server from the Tapo plug it is plugged into: live, last 24 h, today by hour, days, months. */
export default function EnergyPanel({live}: {live?: EnergyLive}) {
  const [data, setData] = useState<Energy | null>(null);
  const refresh = useCallback(async () => {
    try { const r = await fetch('/api/energy'); if (r.ok) setData(await r.json() as Energy); } catch { /* next poll */ }
  }, []);
  useEffect(() => { const first = setTimeout(refresh, 0); const id = setInterval(refresh, 30000); return () => { clearTimeout(first); clearInterval(id); }; }, [refresh]);

  if (live && !live.configured) return (
    <Panel title="Power consumption" sub="Measure what the whole server draws from the wall with a Tapo P110 / P110M / P115 smart plug">
      <p className="en-setup">Add the plug to <code>~/.config/homebase/config.json</code> and restart Homebase:
        <code>{'"energy": {"tapo": {"host": "192.168.1.x", "email": "…", "password": "…"}, "pricePerKwh": 3000, "currency": "VND"}'}</code>
        Use your Tapo account login and turn on <em>Third-Party Compatibility</em> in the Tapo app (Me → Third-Party Services).</p>
    </Panel>
  );
  const e = {...data, ...(live?.at && (!data?.at || live.at > data.at) ? live : {})} as Energy;
  if (!data && !live) return <Panel title="Power consumption"><div className="en-body"><Skeleton h={220} /></div></Panel>;

  const dev = e.device, h = e.history, price = (wh: number) => cost(wh, e.pricePerKwh, e.currency);
  const sub = [dev?.model ? `Tapo ${dev.model}` : 'Tapo plug', dev?.name, e.host].filter(Boolean).join(' · ');
  const power = (h?.power || []).filter(p => p.watts != null) as {at: number; watts: number}[];
  const est = data?.estimate ?? null;
  const tiles: [string, string, string?][] = [
    ['Now', e.available && e.watts != null ? watts(e.watts) : '—'],
    ['Today', e.today != null ? energy(e.today) : '—', e.today != null ? price(e.today) ?? undefined : undefined],
    ['This month', e.month != null ? energy(e.month) : '—', e.month != null ? price(e.month) ?? undefined : undefined],
    ['While on', est ? watts(est.awakeW) : '—', est?.source === 'log' ? 'last 7 days' : 'recent readings'],
    ['While asleep', est?.asleepW != null ? watts(est.asleepW) : '—', est?.asleepW != null ? 'standby draw' : 'no reading yet'],
    ['Plug Wi-Fi', dev?.rssi != null ? `${dev.rssi} dBm` : '—', dev?.signal != null ? SIGNAL[dev.signal] ?? undefined : undefined],
  ];
  const problems = [
    !e.available && `Can't read the plug: ${e.error || 'no answer'}. Showing the last readings.`,
    dev?.overheated && 'The plug reports it is overheating.',
    ...(dev?.protection || []).map(p => `Plug protection status: ${p.replace(/_/g, ' ')}.`),
    e.historyError && `Couldn't load history from the plug: ${e.historyError}`,
  ].filter(Boolean) as string[];

  return (
    <Panel title="Power consumption" sub={<span className="mono-sub">{sub}</span>} className="energy-panel"
      action={<Pill on={!!e.available}>{e.available ? 'Live' : 'Offline'}</Pill>}>
      {problems.map(p => <div key={p} className="gpu-note"><AlertTriangle size={14} />{p}</div>)}
      <div className="gpu-metrics">{tiles.map(([k, v, note]) => <div key={k}><small>{k}</small><strong>{v}</strong>{note && <small>{note}</small>}</div>)}</div>
      {est && <CostSection est={est} />}
      {h ? <>
        <div className="en-chart">
          <h4>Last 24 hours <small>5-minute readings from the plug</small></h4>
          {power.length > 1
            ? <AreaChart series={[{label: 'Power', color: 'var(--amber)', values: power.map(p => p.watts)}]} times={power.map(p => p.at)} format={v => `${Math.round(v)} W`}
                floor={10} height={170} gap={10 * 60000} collapseGaps={false} gapLabel="with no reading" timeLabel={hm} />
            : <p className="dim">The plug has no readings for the last 24 hours yet.</p>}
        </div>
        <div className="en-grid">
          <Bars title="Today by hour" items={h.hours.map(x => ({label: `${String(x.hour).padStart(2, '0')}:00`, value: x.wh}))} current={h.currentHour} format={energy} />
          <Bars title="Daily" items={sinceFirst(h.days, 7).map(x => ({label: dayLabel(x.date), value: x.wh}))} format={v => `${energy(v)}${price(v) ? ` · ${price(v)}` : ''}`} />
          <Bars title="Monthly" items={sinceFirst(h.months, 3).map(x => ({label: `${MONTHS[Number(x.month.slice(5)) - 1]} ${x.month.slice(0, 4)}`, value: x.wh}))} format={v => `${energy(v)}${price(v) ? ` · ${price(v)}` : ''}`} />
          {est && est.log.days.length > 0 && <Bars title="On-time per day" items={est.log.days.map(x => ({label: dayLabel(x.date), value: x.awakeHours}))} format={v => `${v.toFixed(1)} h on`} />}
        </div>
      </> : e.available && <div className="en-body"><Skeleton h={170} /></div>}
      <p className="en-foot"><Plug size={13} />
        The plug measures everything plugged into it, so this is the server's draw at the wall. Its own meter keeps recording while the dashboard is closed and while the server sleeps.
        {dev?.onFor != null && ` Plug powered for ${elapsed(dev.onFor)}.`}
        {dev?.firmware && ` Firmware ${dev.firmware.split(' ')[0]}.`}
        {est ? <> Costs use {est.tariff.name}{est.tariff.effective ? ` (from ${est.tariff.effective})` : ''} plus {Math.round(est.tariff.vat * 100)}% VAT. {est.householdKwh
          ? `The server’s kWh are priced on top of a ${est.householdKwh} kWh/month household, which is what your bill drops by if the server is off.`
          : 'The server is priced as if it had its own meter.'} Change "tariff", "vat" or "householdKwh" under "energy" in the config.</>
          : ' Add "tariff": "evn" (or "pricePerKwh" and "currency") under "energy" in the config to see costs.'}
      </p>
    </Panel>
  );
}
