import { createYoga } from 'graphql-yoga';
import { createRequestContext, GRAPHQL_CORS, maskGraphqlError, schema, useQueryLimits } from '@tapestrai/graphql';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ENVIRONMENT: string;
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
    }),
});

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    // yoga.fetch is compatible with Workers fetch signature
    // It takes (request: Request | URL, requestInit?: RequestInit, env?: E, ctx?: C)
    return (yoga as any).fetch(request, { env, ctx });
  },
};
