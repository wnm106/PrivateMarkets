'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowserClient } from '@/lib/supabase-browser';
import { graphqlClient, ME_QUERY, UPDATE_PROFILE_MUTATION } from '@/lib/graphql';
import { signOutAndRedirect } from '@/components/layout/UserMenu';

interface MeData {
  id: string;
  email: string | null;
  displayName: string | null;
  isTenantAdmin: boolean;
  clients: { id: string; clientName: string }[];
}

export default function ProfilePage() {
  const [me, setMe] = useState<MeData | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [provider, setProvider] = useState<string>('email');
  const [saving, setSaving] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const loadMe = async () => {
    const result = await graphqlClient.query(ME_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
    const m = result.data?.me ?? null;
    setMe(m);
    if (m) setDisplayName(m.displayName ?? '');
    const { data } = await supabaseBrowserClient().auth.getUser();
    setProvider(data.user?.app_metadata?.provider ?? 'email');
  };

  useEffect(() => {
    loadMe();
  }, []);

  const saveName = async () => {
    if (!me) return;
    setSaving(true);
    setMsg(null);
    try {
      const result = await graphqlClient
        .mutation(UPDATE_PROFILE_MUTATION, { input: { displayName: displayName.trim() || null } })
        .toPromise();
      
      const updateResult = result.data?.updateProfile;
      
      if (result.error) {
        setMsg({ kind: 'err', text: result.error.message });
        return;
      }
      
      if (!updateResult?.success) {
        const errorMsg = updateResult?.errors?.[0]?.message ?? 'Failed to save profile';
        setMsg({ kind: 'err', text: errorMsg });
        return;
      }
      
      // Update local state with the returned profile data
      if (updateResult.profile) {
        setMe(prev => prev ? { ...prev, displayName: updateResult.profile.displayName } : prev);
      }
      
      // Re-fetch from GraphQL to confirm persistence
      await loadMe();
      
      setMsg({ kind: 'ok', text: 'Profile updated.' });
      window.dispatchEvent(new Event('profile-updated'));
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const savePassword = async () => {
    setSavingPassword(true);
    setMsg(null);
    try {
      const { error } = await supabaseBrowserClient().auth.updateUser({ password });
      if (error) {
        setMsg({ kind: 'err', text: error.message });
        return;
      }
      setPassword('');
      setMsg({ kind: 'ok', text: 'Password changed.' });
    } finally {
      setSavingPassword(false);
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const input =
    'w-full px-3 py-2 bg-surface border border-line rounded text-sm text-ink';
  const btn = 'px-4 py-2 rounded text-sm font-medium bg-[var(--accent-2)] text-white disabled:opacity-50 disabled:cursor-not-allowed';

  if (!me) return <div className="p-8 text-ink-3">Loading…</div>;

  return (
    <div className="max-w-xl mx-auto p-8 space-y-8 text-ink">
      <h1 className="text-xl font-semibold">Manage profile</h1>
      {msg && (
        <div className={msg.kind === 'ok' ? 'text-green-600 text-sm' : 'text-red-600 text-sm'}>{msg.text}</div>
      )}

      <section className="space-y-3">
        <label className="block text-xs text-ink-3">Email</label>
        <input className={input} value={me.email ?? ''} disabled />
        <label className="block text-xs text-ink-3">Display name</label>
        <input className={input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <button className={btn} onClick={saveName} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </section>

      <section className="space-y-2">
        <div className="text-xs text-ink-3">Organizations</div>
        {me.clients.length === 0 ? (
          <div className="text-sm text-ink-2">None</div>
        ) : (
          <ul className="text-sm text-ink-2 list-disc pl-5">
            {me.clients.map((c) => <li key={c.id}>{c.clientName}</li>)}
          </ul>
        )}
        {me.isTenantAdmin && <div className="text-xs text-accent">tapestr.ai tenant admin</div>}
      </section>

      {provider === 'email' && (
        <section className="space-y-3">
          <label className="block text-xs text-ink-3">New password</label>
          <input
            className={input}
            type="password"
            value={password}
            minLength={8}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className={btn} onClick={savePassword} disabled={savingPassword || password.length < 8}>
            {savingPassword ? 'Changing…' : 'Change password'}
          </button>
        </section>
      )}

      <button className="px-4 py-2 rounded text-sm border border-line text-ink-2 hover:bg-bg-alt transition-colors" onClick={signOutAndRedirect}>
        Sign out
      </button>
    </div>
  );
}
