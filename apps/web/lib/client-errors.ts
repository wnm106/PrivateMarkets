/** What the browser sends to /api/client-errors, read and bounded on the server. */
export interface ClientErrorReport {
  message: string;
  stack: string | null;
  page: string | null;
  kind: 'error' | 'unhandledrejection' | 'render';
}

/** A report the route accepts, or null. Bounded so the endpoint cannot be used to store anything large. */
export function readClientError(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  const message = typeof value.message === 'string' ? value.message.trim().slice(0, 1000) : '';
  if (!message) return null;
  const kind = value.kind === 'unhandledrejection' || value.kind === 'render' ? value.kind : 'error';
  const stack = typeof value.stack === 'string' ? value.stack.slice(0, 4000) : null;
  // The path only: a query string can carry ids and search text.
  const page = typeof value.page === 'string' ? value.page.split('?')[0].slice(0, 300) : null;
  return { message, stack, page, kind };
}

/** Browser errors worth nothing to anyone: extensions, aborted fetches, resize noise. */
export function ignoredClientError(report: Pick<ClientErrorReport, 'message' | 'stack'>): boolean {
  return /ResizeObserver loop|chrome-extension:\/\/|moz-extension:\/\/|AbortError|The user aborted a request/i.test(`${report.message} ${report.stack ?? ''}`);
}
