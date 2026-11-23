import type { Metadata } from 'next';
import { OAuthConsent } from '@/components/auth/OAuthConsent';

export const metadata: Metadata = {
  title: 'Connect an app - tapestr.ai',
};

/** Where a person approves an outside assistant's connection. See components/auth/OAuthConsent.tsx. */
export default function OAuthConsentPage() {
  return <OAuthConsent />;
}
