import { createYoga } from 'graphql-yoga';
import { createClient } from '@supabase/supabase-js';
import { schema } from '@tapestrai/graphql';
import { NextRequest } from 'next/server';
// GraphQL route.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://yxougybcfuignxydipes.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const yoga = createYoga({
  schema,
  graphqlEndpoint: '/api/graphql',
  landingPage: false,
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
