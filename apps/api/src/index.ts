import { createYoga } from 'graphql-yoga';
import { configureErrorReporting, createRequestContext, GRAPHQL_CORS, maskGraphqlError, schema, useQueryLimits, type RateLimitBinding } from '@tapestrai/graphql';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ENVIRONMENT: string;
  /** Sentry-compatible DSN for error reports; unset logs only (packages/graphql/src/lib/error-report.ts). */
  ERROR_REPORT_DSN?: string;
  ERROR_REPORT_RELEASE?: string;
  /** Requests per person per minute (wrangler.toml, unsafe.bindings). */
  RATE_LIMITER?: RateLimitBinding;
}

const yoga = createYoga<{ env: Env }>({
  schema,
  graphqlEndpoint: '/graphql',
  landingPage: false,
  // Depth and alias limits, checked before a query runs.
  plugins: [useQueryLimits()],
  cors: GRAPHQL_CORS,
  // The same rule as the web route: resolver messages pass, the database's own text does not.
  maskedErrors: { maskError: (error: unknown, message: string) => maskGraphqlError(error, message) },
  // The caller's own JWT, so row security applies. See packages/graphql/src/request-context.ts.
  context: ({ request, env }) =>
    createRequestContext(request, {
      supabaseUrl: env.SUPABASE_URL,
      supabaseAnonKey: env.SUPABASE_ANON_KEY,
      supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      rateLimiter: env.RATE_LIMITER ?? null,
    }),
});

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    // yoga.fetch is compatible with Workers fetch signature
    // It takes (request: Request | URL, requestInit?: RequestInit, env?: E, ctx?: C)
    // Workers hand settings to each request, not to the process.
    configureErrorReporting({ dsn: env.ERROR_REPORT_DSN ?? null, environment: env.ENVIRONMENT, release: env.ERROR_REPORT_RELEASE ?? null });
    return (yoga as any).fetch(request, { env, ctx });
  },
};
