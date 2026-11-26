import { createYoga } from 'graphql-yoga';
import { createRequestContext, GRAPHQL_CORS, maskGraphqlError, schema, useQueryLimits } from '@tapestrai/graphql';
import { NextRequest } from 'next/server';
import { rateLimiter } from '@/lib/cloudflare-bindings';
import { accessTokenFromCookieHeader, supabaseProjectRef } from '@/lib/auth-token';
// GraphQL route.

const CAPACITY_EXAMPLE = `# Investment capacity for one security in one fund.
# Fill in the variables below, then press Run.
query InvestmentCapacity($fund: ID!, $security: String, $asOf: Date!) {
  investmentCapacity(anchorEntityId: $fund, securityCode: $security, asOfDate: $asOf) {
    capacityPar
    bindingRuleCode
    bindingGroup
    lines {
      ruleCode
      ruleName
      groupByValue
      baselineValue
      limitValue
      nativeHeadroom
      capacityPar
      binding
    }
    errors { message code }
  }
}
`;

// GraphiQL at GET /api/graphql, in development only. It fills the
// Authorization header from the signed-in session cookie, so queries run as
// that user under Row Level Security. Production serves no explorer.
function graphiqlOptions(request: Request) {
  if (process.env.NODE_ENV === 'production') return false;
  const token = accessTokenFromCookieHeader(request.headers.get('cookie') || '', supabaseProjectRef());
  const headers = JSON.stringify(token ? { Authorization: `Bearer ${token}` } : {}, null, 2);
  return {
    title: 'TapestrAI GraphQL',
    defaultQuery: CAPACITY_EXAMPLE,
    headers,
    defaultHeaders: headers,
    shouldPersistHeaders: false,
  };
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const yoga = createYoga({
  schema,
  graphqlEndpoint: '/api/graphql',
  landingPage: false,
  graphiql: graphiqlOptions,
  // Resolver messages reach the page; the database's own text does not (lib/mask-errors.ts).
  maskedErrors: { maskError: (error: unknown, message: string) => maskGraphqlError(error, message) },
  // Depth and alias limits, checked before a query runs.
  plugins: [useQueryLimits()],
  cors: GRAPHQL_CORS,
  // The caller's own JWT, so row security applies. The service role is kept for the
  // few audited calls that need it. See packages/graphql/src/request-context.ts.
  context: ({ request }) =>
    createRequestContext(request, {
      supabaseUrl,
      supabaseAnonKey,
      supabaseServiceRoleKey,
      rateLimiter: rateLimiter(),
    }),
});

export async function GET(request: NextRequest) {
  return yoga.fetch(request);
}

export async function POST(request: NextRequest) {
  return yoga.fetch(request);
}

export async function OPTIONS(request: NextRequest) {
  return yoga.fetch(request);
}
