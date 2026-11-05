'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { graphqlQuery, ME_QUERY } from '@/lib/graphql';
import { isPlatformAdminPath } from '@/lib/admin-access';

/**
 * Admin screens are for tenant admins and client administrators.
 * Platform catalog pages (entities, templates, sources, rules) stay with
 * tenant admins. Client administrators land on security instead.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    graphqlQuery<{ me: { isTenantAdmin: boolean; canAccessAdmin: boolean } | null }, Record<string, never>>(ME_QUERY, undefined, 'network-only').then(({ data, error }) => {
      if (cancelled) return;
      const me = data?.me;
      if (error || !me?.canAccessAdmin) {
        router.replace('/');
        return;
      }
      if (!me.isTenantAdmin && isPlatformAdminPath(pathname)) {
        router.replace('/admin/tenancy');
        return;
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  if (!ready) {
    return <div style={{ padding: '48px 24px', color: 'var(--ink-3)' }}>Checking access…</div>;
  }

  return <>{children}</>;
}
