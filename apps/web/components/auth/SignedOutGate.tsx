'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { browserSessionIsActive } from '@/lib/auth-token';
import { loginPath } from '@/lib/safe-next-path';
import { supabaseBrowserClient } from '@/lib/supabase-browser';

// Keep in step with PUBLIC_PATHS in middleware.ts. /portal is a form opened by its private link, with no sign-in.
const PUBLIC_PATHS = ['/welcome', '/login', '/no-access', '/auth/callback', '/portal'];

/**
 * Middleware sends a full request with no session to the login page.
 * This covers the case where the session ends while the app is already open,
 * so the dashboard does not stay on screen after sign-out.
 */
export function SignedOutGate({ onLeave }: { onLeave?: () => void }) {
  const pathname = usePathname() || '/';

  useEffect(() => {
    const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
    if (isPublic) return;

    const leave = () => {
      onLeave?.();
      window.location.replace(loginPath(pathname));
    };

    let cancelled = false;
    const confirmSignedOut = async () => {
      if (browserSessionIsActive()) return;
      const { data: sessionData } = await supabaseBrowserClient().auth.getSession();
      if (cancelled || sessionData.session) return;
      leave();
    };
    void confirmSignedOut();

    const { data } = supabaseBrowserClient().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && !browserSessionIsActive()) leave();
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [pathname, onLeave]);

  return null;
}
