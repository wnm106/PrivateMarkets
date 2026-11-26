import type { Instrumentation } from 'next';
import { reportError } from '@tapestrai/graphql/src/lib/error-report';

/**
 * Server errors in pages, route handlers and server actions, reported once each
 * (packages/graphql/src/lib/error-report.ts). Headers are not sent: they carry
 * the session cookie.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const digest = typeof error === 'object' && error !== null && 'digest' in error ? String((error as { digest: unknown }).digest) : null;
  await reportError(error, {
    source: context.routeType === 'route' ? 'route' : 'render',
    where: `${request.method} ${context.routePath}`,
    reference: digest,
    extra: { path: request.path.split('?')[0], routeType: context.routeType, renderSource: context.renderSource ?? null },
  });
};
