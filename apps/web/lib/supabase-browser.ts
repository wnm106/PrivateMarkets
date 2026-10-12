'use client';

import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Cookie-backed Supabase client for use in Client Components. Session state is
 * synced via cookies (not localStorage) so Server Components / middleware /
 * route handlers can read the same session for SSR auth checks.
 */
export function supabaseBrowserClient() {
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
