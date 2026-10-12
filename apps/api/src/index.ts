import { createYoga, createSchema } from 'graphql-yoga';
import { createClient } from '@supabase/supabase-js';
import { schema } from '@tapestrai/graphql';

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
  cors: {
    origin: '*',
    credentials: true,
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
  context: async ({ request, env }) => {
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    // IMPORTANT: scoped to the CALLER's own JWT so Postgres Row Level Security
    // (multi-tenant isolation + per-entity ACLs, see supabase/migrations/00026-00030)
    // actually applies. The service role key bypasses RLS entirely and must only
    // be used for specific privileged operations via `supabaseAdmin`.
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const supabaseAdmin = env.SUPABASE_SERVICE_ROLE_KEY
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
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

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    // yoga.fetch is compatible with Workers fetch signature
    // It takes (request: Request | URL, requestInit?: RequestInit, env?: E, ctx?: C)
    return (yoga as any).fetch(request, { env, ctx });
  },
};
