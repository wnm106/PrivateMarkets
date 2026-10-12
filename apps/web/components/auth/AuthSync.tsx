'use client';

import { useEffect } from 'react';
import { supabaseBrowserClient } from '@/lib/supabase-browser';

/**
 * Keeps `localStorage.auth_token` (read by lib/graphql.ts on every GraphQL
 * request) in sync with the current Supabase session, including on silent
 * token refresh. Mounted once in the root layout.
 */
export function AuthSync() {
  useEffect(() => {
    const supabase = supabaseBrowserClient();

    supabase.auth.getSession().then(({ data: { session } }) => {
      syncToken(session?.access_token ?? null);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      syncToken(session?.access_token ?? null);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  return null;
}

function syncToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) {
    localStorage.setItem('auth_token', token);
  } else {
    localStorage.removeItem('auth_token');
  }
}
