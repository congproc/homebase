import {useEffect, useRef, useState} from 'react';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Eases a number toward its latest value so live readings glide instead of jumping. */
export function useTween(target: number, ms = 600) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const shown = useRef(target);
  useEffect(() => {
    if (!Number.isFinite(target) || reduced() || Math.abs(target - shown.current) < 1e-9) { shown.current = target; setValue(target); return; }
    from.current = shown.current;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - (1 - k) ** 3; // ease-out cubic
      shown.current = from.current + (target - from.current) * e;
      setValue(shown.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Renders a formatted number that animates between readings. */
export function Num({value, format = v => String(Math.round(v))}: {value: number; format?: (v: number) => string}) {
  return <>{format(useTween(value))}</>;
}
