import { createYoga } from 'graphql-yoga';
import { createClient } from '@supabase/supabase-js';
import { schema } from '@tapestrai/graphql';
import { NextRequest } from 'next/server';
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
  maskedErrors: false,
  cors: {
    origin: '*',
    credentials: true,
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
  context: async ({ request }) => {
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    // IMPORTANT: `supabase` is scoped to the CALLER's own JWT (not the service
    // role key). This is what makes Row Level Security (multi-tenant isolation,
    // per-entity ACLs) actually take effect -- Postgres resolves auth.uid() from
    // this token on every query. See supabase/migrations/00026-00030 for the
    // tenancy schema + RLS policies this depends on.
    //
    // Previously this client was created with the SERVICE_ROLE_KEY, which has
    // BYPASSRLS and silently ignored every RLS policy in the database.
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // A small number of privileged, audited operations (e.g. inviting a user via
    // supabase.auth.admin.*) genuinely require the service role. Resolvers should
    // reach for `supabaseAdmin` only for those specific calls, never for normal
    // data access -- RLS must remain the source of truth for row visibility.
    const supabaseAdmin = supabaseServiceRoleKey
      ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
      : null;

    let user = null;
    if (token) {
      const { data: { user: authUser } } = await supabase.auth.getUser(token);
      if (authUser) {
        user = {
          id: authUser.id,
          email: authUser.email || '',
          role: (authUser.user_metadata?.role as any) || 'readonly',
          metadata: authUser.user_metadata,
        };
      }
    }

    return {
      supabase,
      supabaseAdmin,
      user,
      requestId: crypto.randomUUID(),
      loaders: {} as any,
    };
  },
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
