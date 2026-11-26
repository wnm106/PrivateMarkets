/**
 * Error tracking for the servers (GraphQL, the web app's routes and pages) and,
 * through /api/client-errors, the browser.
 *
 * Every report is written as one JSON line to the log, which Cloudflare Workers
 * Logs keeps (observability is on in apps/web/wrangler.jsonc). When a
 * Sentry-compatible DSN is set (ERROR_REPORT_DSN), it is also sent there as an
 * event, without an SDK, so it works the same on Workers and in Node.
 *
 * Reports never carry tokens, cookies or email addresses: anything that looks
 * like a bearer token or a JWT is cut from the text, and the person is named
 * by their id only.
 */

export interface ErrorReportConfig {
  /** https://<key>@<host>/<project>. Unset: log only. */
  dsn?: string | null;
  /** production, staging, development. */
  environment?: string | null;
  /** The deployed commit. */
  release?: string | null;
}

export interface ErrorContext {
  /** Where it happened: graphql, route, render, browser, worker. */
  source: string;
  /** The route, page or operation. */
  where?: string | null;
  /** The person's id, never their email. */
  userId?: string | null;
  /** A reference the person was shown, so support can find the report. */
  reference?: string | null;
  requestId?: string | null;
  extra?: Record<string, unknown>;
}

let configured: ErrorReportConfig | null = null;

/** Set once per process (web) or per request (Workers API, from env). */
export function configureErrorReporting(config: ErrorReportConfig): void {
  configured = config;
}

function settings(): ErrorReportConfig {
  if (configured) return configured;
  const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);
  return {
    dsn: env.ERROR_REPORT_DSN || null,
    environment: env.ERROR_REPORT_ENVIRONMENT || env.NODE_ENV || null,
    release: env.ERROR_REPORT_RELEASE || null,
  };
}

const SECRET = [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g];

/** Text with tokens and email addresses cut out. */
export function scrub(text: string): string {
  return SECRET.reduce((out, pattern) => out.replace(pattern, '[removed]'), text).slice(0, 8000);
}

function describe(error: unknown): { type: string; message: string; stack: string | null } {
  if (error instanceof Error) return { type: error.name || 'Error', message: scrub(error.message || ''), stack: error.stack ? scrub(error.stack) : null };
  return { type: 'Error', message: scrub(typeof error === 'string' ? error : JSON.stringify(error) ?? String(error)), stack: null };
}

function eventId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32).toLowerCase();
}

/** The Sentry envelope for one event, and where it goes. Exported for tests. */
export function sentryEnvelope(dsn: string, error: unknown, context: ErrorContext, config: ErrorReportConfig, now = new Date()) {
  const parsed = new URL(dsn);
  const project = parsed.pathname.replace(/^\/+|\/+$/g, '');
  const key = decodeURIComponent(parsed.username);
  if (!project || !key) throw new Error('ERROR_REPORT_DSN is not a DSN');
  const id = eventId();
  const described = describe(error);
  const event = {
    event_id: id,
    timestamp: now.getTime() / 1000,
    platform: 'javascript',
    level: 'error',
    environment: config.environment || undefined,
    release: config.release || undefined,
    tags: { source: context.source, where: context.where || undefined, reference: context.reference || undefined },
    user: context.userId ? { id: context.userId } : undefined,
    exception: { values: [{ type: described.type, value: described.message }] },
    extra: { stack: described.stack, requestId: context.requestId || undefined, ...(context.extra || {}) },
  };
  return {
    url: `${parsed.protocol}//${parsed.host}/api/${project}/envelope/`,
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=tapestrai/1.0`,
    },
    body: [JSON.stringify({ event_id: id, sent_at: now.toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n'),
  };
}

/**
 * Report one error. Always logs; sends to the tracker when one is set. Never
 * throws: a broken tracker must not break the request that failed.
 */
export async function reportError(error: unknown, context: ErrorContext): Promise<void> {
  const config = settings();
  const described = describe(error);
  try {
    console.error(JSON.stringify({
      level: 'error',
      source: context.source,
      where: context.where ?? null,
      reference: context.reference ?? null,
      userId: context.userId ?? null,
      requestId: context.requestId ?? null,
      type: described.type,
      message: described.message,
      stack: described.stack,
    }));
  } catch {
    // Logging failed; nothing else to do.
  }
  if (!config.dsn) return;
  try {
    const envelope = sentryEnvelope(config.dsn, error, context, config);
    await fetch(envelope.url, { method: 'POST', headers: envelope.headers, body: envelope.body });
  } catch (sendError) {
    console.error(JSON.stringify({ level: 'error', source: 'error-report', message: `The error tracker could not be reached: ${sendError instanceof Error ? sendError.message : String(sendError)}` }));
  }
}
