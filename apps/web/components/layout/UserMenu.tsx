'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { graphqlClient, ME_QUERY } from '@/lib/graphql';
import { supabaseBrowserClient } from '@/lib/supabase-browser';

interface MeData {
  id: string;
  email: string | null;
  displayName: string | null;
  isTenantAdmin: boolean;
  clients: { id: string; clientName: string }[];
}

export function initialsFor(name: string | null | undefined, email: string | null | undefined) {
  const source = (name || email || '?').trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export async function signOutAndRedirect() {
  try {
    await supabaseBrowserClient().auth.signOut();
  } catch {
    /* Still leave the app if the auth server cannot be reached. */
  }
  try {
    localStorage.removeItem('auth_token');
  } catch {
    /* ignore */
  }
  window.location.href = '/welcome';
}

/** Where the account menu opens from its trigger. */
export type UserMenuAnchor = 'down-end' | 'up-start' | 'side';

export function UserMenu({
  anchor = 'down-end',
  showLabel = true,
  variant = 'bar',
}: {
  anchor?: UserMenuAnchor;
  showLabel?: boolean;
  variant?: 'bar' | 'sidebar';
}) {
  const [me, setMe] = useState<MeData | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await graphqlClient.query(ME_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
      if (!cancelled) setMe(result.data?.me ?? null);
    };
    load();
    // Reload when auth state changes (login / token refresh / profile edits)
    const { data: sub } = supabaseBrowserClient().auth.onAuthStateChange(() => {
      setTimeout(load, 300);
    });
    const onProfileUpdated = () => load();
    window.addEventListener('profile-updated', onProfileUpdated);
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      window.removeEventListener('profile-updated', onProfileUpdated);
    };
  }, []);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
  }, []);

  useEffect(() => {
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, handleClickOutside]);

  if (!me) {
    return (
      <Link href="/login" className={`user-chip ${variant === 'sidebar' ? 'user-chip-sidebar' : ''}`} style={{ textDecoration: 'none' }}>
        <div className="avatar">?</div>
        {showLabel && <div style={{ fontSize: '12px', color: 'var(--accent)', fontWeight: 600 }}>Sign in</div>}
      </Link>
    );
  }

  const label = me.displayName || me.email || 'Account';
  const itemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '10px 16px',
    color: 'var(--ink-2)',
    fontSize: '13px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    textDecoration: 'none',
  };

  const menuPosition: React.CSSProperties =
    anchor === 'up-start'
      ? { bottom: 'calc(100% + 8px)', left: 0 }
      : anchor === 'side'
        ? { left: 'calc(100% + 10px)', bottom: 0 }
        : { top: 'calc(100% + 8px)', right: 0 };

  return (
    <div ref={ref} className={`user-menu ${variant === 'sidebar' ? 'user-menu-sidebar' : ''}`}>
      <button
        className={`user-chip ${variant === 'sidebar' ? 'user-chip-sidebar' : ''}`}
        onClick={() => setOpen(!open)}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
      >
        <div className="avatar">{initialsFor(me.displayName, me.email)}</div>
        {showLabel && (
          <span className="user-chip-text">
            <span className="user-chip-name">{label}</span>
            {variant === 'sidebar' && me.email && me.displayName && (
              <span className="user-chip-email">{me.email}</span>
            )}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            ...menuPosition,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: '10px',
            boxShadow: '0 12px 32px rgba(10, 22, 40, 0.14)',
            minWidth: '240px',
            zIndex: 80,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ color: 'var(--ink)', fontSize: '13px', fontWeight: 600 }}>
              {me.displayName || 'Unnamed user'}
            </div>
            <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>{me.email}</div>
            {me.isTenantAdmin && (
              <div style={{ color: 'var(--accent)', fontSize: '11px', marginTop: '4px' }}>tapestr.ai tenant admin</div>
            )}
          </div>
          <Link href="/profile" onClick={() => setOpen(false)} style={itemStyle}>
            Manage profile
          </Link>
          <button style={{ ...itemStyle, borderTop: '1px solid var(--line)' }} onClick={signOutAndRedirect}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
