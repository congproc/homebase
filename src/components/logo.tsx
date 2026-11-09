import {useEffect} from 'react';
import type {Level} from '../lib/types';

/**
 * Homebase mark: a lowercase "h" whose counter is a lit doorway. The dot is the wordmark's period
 * and doubles as the live status light, so it takes the current health colour.
 */
const ARCH = 'M60 36H96V92A68 68 0 0 1 196 152V220H160V152A32 32 0 0 0 96 152V220H60Z';
/** Heavier cut for 16–32 px (favicons). */
const ARCH_SMALL = 'M52 32H98V86A74 74 0 0 1 204 152V224H160V152A31 31 0 0 0 98 152V224H52Z';

export const STATUS_HEX: Record<Level, string> = {ok: '#101113', warn: '#c47f12', critical: '#d0432b', offline: '#d0432b', pending: '#101113'};

export function LogoMark({level = 'ok', size = 18, className = ''}: {level?: Level; size?: number; className?: string}) {
  return (
    <svg className={`logo-mark ${className}`} width={size} height={size} viewBox="36 30 184 196" aria-hidden="true">
      <path d={ARCH} fill="currentColor" />
      <circle className={`logo-light level-${level}`} cx="128" cy="194" r="18" />
    </svg>
  );
}

/** Favicon that mirrors the status light: dark dot when healthy, amber/red when not. */
export function useStatusFavicon(level: Level) {
  useEffect(() => {
    const big = level === 'ok' || level === 'pending' ? 22 : 30;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="60" fill="#d1ee97"/><g transform="translate(28.16 28.16) scale(.78)"><path fill="#101113" d="${ARCH_SMALL}"/><circle cx="129" cy="196" r="${big}" fill="${STATUS_HEX[level]}"/></g></svg>`;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.type = 'image/svg+xml'; document.head.appendChild(link); }
    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }, [level]);
}
