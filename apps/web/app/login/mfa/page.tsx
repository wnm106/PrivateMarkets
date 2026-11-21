'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MfaStep } from '@/components/auth/MfaStep';

export default function MfaPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectedFrom = searchParams.get('redirectedFrom') || '/';
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
