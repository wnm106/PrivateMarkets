'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabaseBrowserClient } from '@/lib/supabase-browser';
import { BrandLogo } from '@/components/layout/BrandLogo';
import { parseSignInDiscovery, type SignInDiscovery, type SignInMethod } from '@tapestrai/graphql/src/lib/enterprise-sso';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectedFrom = searchParams.get('redirectedFrom') || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [discovery, setDiscovery] = useState<SignInDiscovery | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(searchParams.get('error'));

  const redirectTo = () => `${window.location.origin}/auth/callback?redirectedFrom=${encodeURIComponent(redirectedFrom)}`;

  const discover = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading('discover');
    try {
      const response = await fetch('/api/auth/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(typeof body?.message === 'string' ? body.message : 'Sign-in options could not be loaded. Try again.');
        return;
      }
      const next = parseSignInDiscovery(body);
      setDiscovery(next);
      if (next.message && next.methods.length === 0) setError(next.message);
    } catch {
      setError('Sign-in options could not be loaded. Try again.');
    } finally {
      setLoading(null);
    }
  };

  const startPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (discovery && !discovery.password) {
      setError('This organization requires single sign-on.');
      return;
    }
    setError(null);
    setLoading('password');
    try {
      const { error: signInError } = await supabaseBrowserClient().auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      router.replace(redirectedFrom);
      router.refresh();
    } finally {
      setLoading(null);
    }
  };

  const startMethod = async (method: SignInMethod) => {
    setError(null);
    setLoading(method.protocol);
    const supabase = supabaseBrowserClient();
    if (method.protocol === 'oidc' && !method.identifier) {
      setError('This OpenID Connect connection is not ready.');
      setLoading(null);
      return;
    }
    if (method.protocol === 'saml') {
      if (!method.domain) {
        setError('This SAML connection has no email domain.');
        setLoading(null);
        return;
      }
      const { data, error: ssoError } = await supabase.auth.signInWithSSO({
        domain: method.domain,
        options: { redirectTo: redirectTo() },
      });
      if (ssoError || !data?.url) {
        setError(ssoError?.message || 'SAML sign-in could not be started.');
        setLoading(null);
        return;
      }
      window.location.assign(data.url);
      return;
    }

    // Custom OIDC identifiers are created per client (`custom:domain`) and are
    // not part of the built-in provider union.
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: (method.protocol === 'azure' ? 'azure' : method.identifier || 'azure') as 'azure',
      options: {
        redirectTo: redirectTo(),
        scopes: 'email openid profile',
        queryParams: {
          ...(method.domain ? { domain_hint: method.domain } : {}),
          ...(email ? { login_hint: email } : {}),
        },
      },
    });
    if (oauthError) {
      setError(oauthError.message);
      setLoading(null);
    }
  };

  const methods = (discovery?.methods || []).filter((method) => method.protocol !== 'password');
  const passwordAllowed = !discovery || discovery.methods.some((method) => method.protocol === 'password');

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[radial-gradient(circle_at_80%_0%,rgba(0,163,255,0.14),transparent_45%),radial-gradient(circle_at_0%_100%,rgba(30,64,175,0.10),transparent_45%)]">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg border-t-4 border-brand-cyan p-8">
        <div className="mb-6 text-center">
          <div className="flex justify-center mb-2">
            <BrandLogo size={44} />
          </div>
          <div className="text-sm text-ink-3">Sign in to your account</div>
          {discovery?.organization && <div className="mt-1 text-sm font-medium text-gray-800">{discovery.organization}</div>}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{error}</div>
        )}

        {!discovery ? (
          <form onSubmit={discover} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Work email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan"
                placeholder="you@client.com"
                autoComplete="username"
              />
            </div>
            <p className="text-xs text-gray-500">Your email domain opens the sign-in method your organization requires.</p>
            <button
              type="submit"
              disabled={loading !== null}
              className="w-full px-4 py-2 bg-accent text-white rounded-lg hover:brightness-110 font-medium disabled:bg-none disabled:bg-gray-300"
            >
              {loading === 'discover' ? 'Checking…' : 'Continue'}
            </button>
          </form>
        ) : (
          <div className="space-y-3">
            {methods.map((method) => (
              <button
                key={`${method.protocol}-${method.identifier || method.domain || method.label}`}
                type="button"
                onClick={() => startMethod(method)}
                disabled={loading !== null}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50"
              >
                {method.protocol === 'azure' && (
                  <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true">
                    <path fill="#f25022" d="M1 1h10v10H1z" />
                    <path fill="#00a4ef" d="M1 12h10v10H1z" />
                    <path fill="#7fba00" d="M12 1h10v10H12z" />
                    <path fill="#ffb900" d="M12 12h10v10H12z" />
                  </svg>
                )}
                {loading === method.protocol ? 'Redirecting…' : `Continue with ${method.label}`}
              </button>
            ))}

            {discovery.mfa_required && (
              <p className="text-xs text-gray-500">This organization requires an authenticator app after sign-in.</p>
            )}

            {passwordAllowed && (
              <form onSubmit={startPassword} className="space-y-3 pt-2">
                {methods.length > 0 && (
                  <div className="relative my-2 text-center text-xs text-gray-400">
                    <span className="bg-white px-2 relative z-10">or sign in with email</span>
                    <div className="absolute inset-x-0 top-1/2 border-t border-gray-200" />
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan"
                    autoComplete="current-password"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading !== null}
                  className="w-full px-4 py-2 bg-accent text-white rounded-lg hover:brightness-110 font-medium disabled:bg-none disabled:bg-gray-300"
                >
                  {loading === 'password' ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            )}

            <button
              type="button"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              onClick={() => { setDiscovery(null); setPassword(''); setError(null); }}
            >
              Use a different email
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
