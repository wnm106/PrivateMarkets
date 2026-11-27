'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `load` every `ms` while `enabled`, but only while the page is visible.
 * A hidden browser tab makes no requests; on coming back it loads at once, so what
 * it shows is current, and then resumes the interval.
 */
export function useVisiblePolling(load: () => unknown, ms: number, enabled: boolean): void {
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => loadRef.current(), ms);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        loadRef.current();
        start();
      }
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, ms]);
}
