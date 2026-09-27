import { createYoga } from 'graphql-yoga';
import { createClient } from '@supabase/supabase-js';
import { schema } from '@meridian-mdm/graphql';
import { NextRequest } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://yxougybcfuignxydipes.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

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
    const supabase = createClient(supabaseUrl, supabaseKey);
    
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

export async function GET(request: NextRequest) {
  return yoga.fetch(request);
}

export async function POST(request: NextRequest) {
  return yoga.fetch(request);
}

export async function OPTIONS(request: NextRequest) {
  return yoga.fetch(request);
}
