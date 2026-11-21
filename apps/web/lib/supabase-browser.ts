'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseProjectRef } from './auth-token';
import { sessionCookieName, sessionCookieNames, type SessionStore } from './session-store';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let excelClient: SupabaseClient | null = null;

/**
 * Cookie-backed Supabase client for use in Client Components. Session state is
 * synced via cookies (not localStorage) so Server Components / middleware /
 * route handlers can read the same session for SSR auth checks.
 *
 * `excel` is the Excel add-in's own session, in its own cookie. Middleware never
 * reads or refreshes it (lib/session-store.ts).
 */
export function supabaseBrowserClient(store: SessionStore = 'app'): SupabaseClient {
  if (store === 'app') return createBrowserClient(supabaseUrl, supabaseAnonKey);
  if (!excelClient) {
    excelClient = createBrowserClient(supabaseUrl, supabaseAnonKey, {
      isSingleton: false,
      cookieOptions: { name: sessionCookieName(store, supabaseProjectRef()) as string },
    });
  }
  return excelClient;
}

/**
 * Forget a store's session in this browser without revoking it. Used once the
 * session has been handed to the add-in, which is then its only holder.
 */
export function forgetBrowserSession(store: SessionStore): void {
  const name = sessionCookieName(store, supabaseProjectRef());
  if (!name || typeof document === 'undefined') return;
  for (const cookie of sessionCookieNames(document.cookie, name)) {
    document.cookie = `${cookie}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

export const publicSupabaseConfig = { url: supabaseUrl, anonKey: supabaseAnonKey };
