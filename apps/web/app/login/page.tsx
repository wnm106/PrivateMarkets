'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabaseBrowserClient } from '@/lib/supabase-browser';
import { BrandLogo } from '@/components/layout/BrandLogo';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectedFrom = searchParams.get('redirectedFrom') || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'password' | 'azure' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePasswordSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading('password');
    try {
      const supabase = supabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
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

  const handleAzureSignIn = async () => {
    setError(null);
    setLoading('azure');
    const supabase = supabaseBrowserClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?redirectedFrom=${encodeURIComponent(redirectedFrom)}`,
        scopes: 'email openid profile',
      },
    });
    if (oauthError) {
      setError(oauthError.message);
      setLoading(null);
    }
    // On success the browser is redirected to Azure AD; nothing else to do here.
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[radial-gradient(circle_at_80%_0%,rgba(0,163,255,0.14),transparent_45%),radial-gradient(circle_at_0%_100%,rgba(30,64,175,0.10),transparent_45%)]">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg border-t-4 border-brand-cyan p-8">
        <div className="mb-6 text-center">
          <div className="flex justify-center mb-2">
            <BrandLogo size={44} />
          </div>
          <div className="text-sm text-ink-3">Sign in to your account</div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">{error}</div>
        )}

        <button
          onClick={handleAzureSignIn}
          disabled={loading !== null}
          className="w-full mb-4 flex items-center justify-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50"
        >
          <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true">
            <path fill="#f25022" d="M1 1h10v10H1z" />
            <path fill="#00a4ef" d="M1 12h10v10H1z" />
            <path fill="#7fba00" d="M12 1h10v10H12z" />
            <path fill="#ffb900" d="M12 12h10v10H12z" />
          </svg>
          {loading === 'azure' ? 'Redirecting…' : 'Continue with Microsoft'}
        </button>

        <div className="relative my-4 text-center text-xs text-gray-400">
          <span className="bg-white px-2 relative z-10">or sign in with email</span>
          <div className="absolute inset-x-0 top-1/2 border-t border-gray-200" />
        </div>

        <form onSubmit={handlePasswordSignIn} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan"
              placeholder="you@client.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-cyan"
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
      </div>
    </div>
  );
}
