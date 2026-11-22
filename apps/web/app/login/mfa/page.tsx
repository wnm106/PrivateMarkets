'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MfaStep } from '@/components/auth/MfaStep';
import { safeNextPath } from '@/lib/safe-next-path';

export default function MfaPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The address bar is not trusted: only a path inside this app is followed after the code is accepted.
  const redirectedFrom = safeNextPath(searchParams.get('redirectedFrom'));
  const onVerified = useCallback(() => {
    router.replace(redirectedFrom);
    router.refresh();
  }, [router, redirectedFrom]);
  const onSignedOut = useCallback(() => {
    router.replace('/login');
    router.refresh();
  }, [router]);
  return <MfaStep store="app" onVerified={onVerified} onSignedOut={onSignedOut} />;
}
