'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabaseBrowserClient } from '@/lib/supabase-browser';
import { BrandLogo } from '@/components/layout/BrandLogo';

type Enrollment = { factorId: string; qr: string; secret: string };

/**
 * Authenticator step-up. A client can require this after the password or SSO
 * session exists. Enrollment and verification both go to Supabase Auth.
 */
export default function MfaPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectedFrom = searchParams.get('redirectedFrom') || '/';
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = supabaseBrowserClient();
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        router.replace('/login');
        return;
      }
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        setError(listError.message);
        setLoading(false);
        return;
      }
      const verified = data?.totp?.find((factor) => factor.status === 'verified');
      if (verified) {
        setFactorId(verified.id);
        setLoading(false);
        return;
      }
      for (const factor of data?.totp || []) {
        if (factor.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
      const enrolled = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' });
      if (cancelled) return;
      if (enrolled.error || !enrolled.data?.totp) {
        setError(enrolled.error?.message || 'Could not start authenticator enrollment.');
        setLoading(false);
        return;
      }
      setEnrollment({ factorId: enrolled.data.id, qr: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret });
      setFactorId(enrolled.data.id);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [router]);

  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!factorId) return;
    setError(null);
    setLoading(true);
    try {
      const supabase = supabaseBrowserClient();
      const challenge = await supabase.auth.mfa.challenge({ factorId });
      if (challenge.error || !challenge.data) {
        setError(challenge.error?.message || 'Could not start verification.');
        return;
      }
      const verified = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: code.trim() });
      if (verified.error) {
        setError(verified.error.message);
        return;
      }
      router.replace(redirectedFrom);
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    await supabaseBrowserClient().auth.signOut();
    router.replace('/login');
    router.refresh();
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[radial-gradient(circle_at_80%_0%,rgba(0,163,255,0.14),transparent_45%),radial-gradient(circle_at_0%_100%,rgba(30,64,175,0.10),transparent_45%)]">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg border-t-4 border-brand-cyan p-8">
        <div className="mb-6 text-center">
          <div className="flex justify-center mb-2">
            <BrandLogo size={44} />
          </div>
          <div className="text-sm text-ink-3">Authenticator required</div>
        </div>
        {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{error}</div>}
        {loading && !factorId ? (
          <div className="text-sm text-gray-500 text-center">Preparing your authenticator…</div>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            {enrollment && (
              <div className="space-y-2 text-center">
                <img src={enrollment.qr} alt="Authenticator QR code" className="mx-auto h-40 w-40" />
                <p className="text-xs text-gray-500">Scan the code, or enter this secret: <span className="font-mono text-gray-800">{enrollment.secret}</span></p>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">6-digit code</label>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan tracking-widest text-center"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2 bg-accent text-white rounded-lg hover:brightness-110 font-medium disabled:bg-none disabled:bg-gray-300"
            >
              {loading ? 'Checking…' : 'Verify'}
            </button>
            <button type="button" onClick={signOut} className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">
              Sign out
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
