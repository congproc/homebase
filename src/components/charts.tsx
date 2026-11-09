import {useId, useMemo, useRef, useState} from 'react';
import {clock} from '../lib/format';

const W = 600;
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '');

const GAP = 20000; // readings arrive every 5 s; anything longer is a pause or suspend

const GAP_SHOWN = 15000; // a pause is drawn as this much time, so an hour unwatched doesn't squash the live data into a sliver

/** X position (0..W) for each point: by timestamp when known (pauses collapsed), otherwise evenly spaced. */
function xs(n: number, times?: number[]) {
  if (times && times.length === n && n > 1 && times[n - 1] > times[0]) {
    let acc = 0;
    const t = times.map((v, i) => { const step = i ? v - times[i - 1] : 0; return (acc += step > GAP ? GAP_SHOWN : step); });
    const span = t[n - 1] || 1;
    return t.map(v => (v / span) * W);
  }
  const d = Math.max(n - 1, 1);
  return Array.from({length: n}, (_, i) => (i * W) / d);
}

/** Line + area paths; the line breaks wherever readings stopped for a while. */
function path(values: number[], max: number, h: number, pad = 4, times?: number[]) {
  if (!values.length) return {line: '', area: ''};
  const x = xs(values.length, times);
  const y = (v: number) => h - Math.min(Math.max(v, 0) / max, 1) * (h - pad);
  let line = '', area = '', start = 0;
  const close = (end: number) => { area += `${line.slice(line.lastIndexOf('M'))} L${x[end].toFixed(1)},${h} L${x[start].toFixed(1)},${h} Z `; };
  values.forEach((v, i) => {
    const brk = i > 0 && times && times[i] - times[i - 1] > GAP;
    if (brk) { close(i - 1); start = i; }
    line += `${i === 0 || brk ? 'M' : 'L'}${x[i].toFixed(1)},${y(v).toFixed(1)} `;
  });
  close(values.length - 1);
  return {line: line.trim(), area: area.trim()};
}

/** Compact background trend line for stat cards. */
export function Sparkline({values, times, color, max, height = 48}: {values: number[]; times?: number[]; color: string; max?: number; height?: number}) {
  const id = safeId(useId());
  const top = max ?? Math.max(1, ...values) * 1.25;
  const {line, area} = path(values, top, height, 4, times);
  return (
    <svg className={`sparkline ${values.length > 1 ? 'reveal' : ''}`} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {values.length > 1 && <>
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </>}
    </svg>
  );
}

/** Circular percentage gauge. */
export function Ring({value, color, size = 44}: {value: number; color: string; size?: number}) {
  const r = 18, c = 2 * Math.PI * r, v = Math.min(Math.max(value, 0), 100);
  return (
    <svg className="gauge" width={size} height={size} viewBox="0 0 44 44" role="img" aria-label={`${v}%`}>
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
      <circle cx="22" cy="22" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
        className="gauge-value" transform="rotate(-90 22 22)" style={{'--dash': `${(v / 100) * c} ${c}`} as React.CSSProperties} />
    </svg>
  );
}

export type Series = {label: string; color: string; values: number[]};

/** Interactive area chart with a hover crosshair and tooltip. */
export function AreaChart({series, times, max, floor = 1, format, height = 190}: {series: Series[]; times: number[]; max?: number; floor?: number; format: (v: number) => string; height?: number}) {
  const id = safeId(useId());
  const ref = useRef<HTMLDivElement>(null);
  const [hoverRaw, setHover] = useState<number | null>(null);
  const top = useMemo(() => {
    if (max) return max;
    const peak = Math.max(floor, ...series.flatMap(s => s.values)); // floor keeps an idle chart from labelling 0.5 B/s steps
    const mag = 10 ** Math.floor(Math.log10(peak));
    return Math.ceil((peak * 1.15) / mag) * mag;
  }, [series, max, floor]);
  const n = times.length;
  const hover = hoverRaw !== null && hoverRaw < n ? hoverRaw : null; // data can shrink while hovering
  const ticks = [1, 0.75, 0.5, 0.25, 0];
  const px = useMemo(() => xs(n, times), [n, times]);
  const onMove = (e: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || n < 2) return;
    const x = (Math.min(Math.max(e.clientX - box.left, 0), box.width) / box.width) * W;
    let best = 0;
    px.forEach((p, i) => { if (Math.abs(p - x) < Math.abs(px[best] - x)) best = i; });
    setHover(best);
  };
  const hx = hover === null ? 0 : (px[hover] / W) * 100;
  const short = n > 1 && times[n - 1] - times[0] < 180000; // under 3 min: minute labels would repeat
  const gaps = useMemo(() => times.reduce((k, t, i) => k + (i && t - times[i - 1] > GAP ? 1 : 0), 0), [times]);
  return (
    <div className="area-chart">
      <div className="area-ticks" style={{height}}>
        {ticks.map(t => <span key={t}>{format(top * t)}</span>)}
      </div>
      <div className="area-body">
        <div className="area-plot" ref={ref} style={{height}} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-label="Usage history chart" role="img">
            <defs>
              {series.map((s, i) => (
                <linearGradient key={i} id={`${id}-${i}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={s.color} stopOpacity=".22" />
                  <stop offset="1" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              ))}
            </defs>
            {ticks.map(t => <line key={t} x1="0" x2={W} y1={height - t * (height - 4)} y2={height - t * (height - 4)} className="grid-line" vectorEffect="non-scaling-stroke" />)}
            {n > 1 && series.map((s, i) => {
              const {line, area} = path(s.values, top, height, 4, times);
              return <g key={s.label} className="reveal">
                <path d={area} fill={`url(#${id}-${i})`} />
                <path d={line} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </g>;
            })}
          </svg>
          {n < 2 && <span className="area-wait"><i className="wait-dot" />Collecting usage history…</span>}
          {n > 1 && hover === null && series.map(s => (
            <span key={s.label} className="live-head" style={{top: height - Math.min(Math.max(s.values.at(-1) ?? 0, 0) / top, 1) * (height - 4), color: s.color}} />
          ))}
          {hover !== null && n > 1 && <>
            <span className="crosshair" style={{left: `${hx}%`}} />
            {series.map(s => (
              <span key={s.label} className="crosshair-dot" style={{left: `${hx}%`, top: height - Math.min(s.values[hover] / top, 1) * (height - 4), background: s.color}} />
            ))}
            <div className={`chart-tooltip ${hx > 70 ? 'flip' : ''}`} style={{left: `${hx}%`}}>
              <small>{clock(times[hover], true)}</small>
              {series.map(s => <div key={s.label}><i style={{background: s.color}} />{s.label}<strong>{format(s.values[hover])}</strong></div>)}
            </div>
          </>}
        </div>
        <div className="area-times">
          <span>{n ? clock(times[0], short) : '—'}</span>
          {n > 2 && <span>{gaps ? `${gaps} ${gaps === 1 ? 'pause' : 'pauses'} while unwatched` : clock((times[0] + times[n - 1]) / 2, short)}</span>}
          <span>Now</span>
        </div>
      </div>
    </div>
  );
}
