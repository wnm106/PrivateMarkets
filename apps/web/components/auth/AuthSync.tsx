'use client';

import { useEffect } from 'react';
import { readBrowserAccessToken } from '@/lib/auth-token';
import { supabaseBrowserClient } from '@/lib/supabase-browser';

/**
 * Keeps `localStorage.auth_token` aligned with the Supabase session cookie.
 * GraphQL reads the cookie directly; this copy stays available for anything
 * that still looks in localStorage. Mounted once in the root layout.
 */
export function AuthSync() {
  useEffect(() => {
    const supabase = supabaseBrowserClient();

    const sync = () => syncToken(readBrowserAccessToken());
    sync();

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      syncToken(session?.access_token ?? readBrowserAccessToken());
    });
    window.addEventListener('focus', sync);

    return () => {
      subscription.subscription.unsubscribe();
      window.removeEventListener('focus', sync);
    };
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
