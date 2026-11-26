'use client';

import { useEffect } from 'react';
import { sendClientError } from '@/components/layout/ErrorReporter';

/** A page that crashed outright. The error is reported; the person can try again. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    sendClientError('render', error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 32, background: '#fff', color: '#1f2937' }}>
        <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Something went wrong</h1>
        <p style={{ fontSize: 14, margin: '0 0 16px' }}>
          It has been reported{error.digest ? <> under reference <code>{error.digest}</code></> : null}. Try again, or go back to the home page.
        </p>
        <button type="button" onClick={reset} style={{ fontSize: 14, padding: '6px 12px', marginRight: 8 }}>Try again</button>
        <a href="/" style={{ fontSize: 14 }}>Home</a>
      </body>
    </html>
  );
}
