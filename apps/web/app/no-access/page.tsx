'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowserClient } from '@/lib/supabase-browser';

export default function NoAccessPage() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = supabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  const handleSignOut = async () => {
    const supabase = supabaseBrowserClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold mb-2">No access yet</h1>
        <p className="text-gray-600 mb-6">
          {email ? <>You&apos;re signed in as <strong>{email}</strong>, but</> : 'You\u2019re signed in, but'} you
          haven&apos;t been added to a client yet. Ask your administrator to invite you, or contact tapestr.ai support.
        </p>
        <button onClick={handleSignOut} className="px-4 py-2 bg-gray-200 rounded-lg hover:bg-gray-300 text-sm font-medium">
          Sign out
        </button>
      </div>
    </div>
  );
}
