import { NextRequest } from 'next/server';
import { reportError } from '@tapestrai/graphql/src/lib/error-report';
import { clientIp } from '@tapestrai/graphql/src/lib/client-ip';
import { rateLimitKey, withinRateLimit } from '@tapestrai/graphql/src/lib/rate-limit';
import { rateLimiter } from '@/lib/cloudflare-bindings';
import { ignoredClientError, readClientError } from '@/lib/client-errors';

/**
 * Errors the browser hit, reported like server errors
 * (packages/graphql/src/lib/error-report.ts). Counted against the caller's
 * rate limit by address; the person is not named, because this route does not
 * read the session.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!(await withinRateLimit(rateLimiter(), rateLimitKey(null, clientIp(request.headers))))) {
    return new Response(null, { status: 429 });
  }
  const text = await request.text();
  if (text.length > 8000) return new Response(null, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const report = readClientError(body);
  if (!report) return new Response(null, { status: 400 });
  if (!ignoredClientError(report)) {
    const error = Object.assign(new Error(report.message), { name: 'BrowserError', stack: report.stack ?? undefined });
    await reportError(error, { source: 'browser', where: report.page, extra: { kind: report.kind } });
  }
  return new Response(null, { status: 204 });
}
