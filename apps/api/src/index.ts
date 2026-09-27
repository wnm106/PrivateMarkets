import { createYoga, createSchema } from 'graphql-yoga';
import { createClient } from '@supabase/supabase-js';
import { schema } from '@meridian-mdm/graphql';

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
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    
    // Extract user from Authorization header
    const authHeader = request.headers.get('Authorization');
    let user = null;
    
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
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
