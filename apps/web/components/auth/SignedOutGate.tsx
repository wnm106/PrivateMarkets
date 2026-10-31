'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { browserSessionIsActive } from '@/lib/auth-token';
import { supabaseBrowserClient } from '@/lib/supabase-browser';

const PUBLIC_PATHS = ['/welcome', '/login', '/no-access', '/auth/callback'];

function destinationFor(pathname: string) {
  if (pathname === '/') return '/welcome';
  return `/login?redirectedFrom=${encodeURIComponent(pathname)}`;
}

/**
 * Middleware sends a full request with no session to the marketing home page.
 * This covers the case where the session ends while the app is already open,
 * so the dashboard does not stay on screen after sign-out.
 */
export function SignedOutGate() {
  const pathname = usePathname() || '/';

  useEffect(() => {
    const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
    if (isPublic) return;

    const leave = () => {
      window.location.replace(destinationFor(pathname));
    };

    if (!browserSessionIsActive()) {
      leave();
      return;
    }

    const { data } = supabaseBrowserClient().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && !browserSessionIsActive()) leave();
    });
    return () => data.subscription.unsubscribe();
  }, [pathname]);

  return null;
}
