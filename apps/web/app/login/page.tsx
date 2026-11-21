'use client';

import { useSearchParams } from 'next/navigation';
import { safeNextPath } from '@/lib/safe-next-path';
import { SignInForm } from '@/components/auth/SignInForm';

export default function LoginPage() {
  const searchParams = useSearchParams();
  return (
    <SignInForm
      store="app"
      initialError={searchParams.get('error')}
      // Read the live URL. The rendered search params can still be empty
      // on the first client pass, and that fallback is the home page.
      nextPath={() => safeNextPath(new URLSearchParams(window.location.search).get('redirectedFrom'))}
    />
  );
}
