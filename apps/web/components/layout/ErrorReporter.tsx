'use client';

import { useEffect } from 'react';

const MAX_PER_PAGE = 5;

/** Sends one browser error to /api/client-errors. Never throws. */
export function sendClientError(kind: 'error' | 'unhandledrejection' | 'render', error: unknown) {
  try {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
    const stack = error instanceof Error ? error.stack ?? null : null;
    const body = JSON.stringify({ kind, message, stack, page: window.location.pathname });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/client-errors', new Blob([body], { type: 'application/json' }));
    else void fetch('/api/client-errors', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
  } catch {
    // Reporting must never add an error of its own.
  }
}

/** Reports uncaught browser errors, a few per page at most, so one loop cannot flood the tracker. */
export function ErrorReporter() {
  useEffect(() => {
    let sent = 0;
    const seen = new Set<string>();
    const report = (kind: 'error' | 'unhandledrejection', error: unknown) => {
      const key = `${kind}:${error instanceof Error ? error.message : String(error)}`;
      if (sent >= MAX_PER_PAGE || seen.has(key)) return;
      seen.add(key);
      sent += 1;
      sendClientError(kind, error);
    };
    const onError = (event: ErrorEvent) => report('error', event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => report('unhandledrejection', event.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
