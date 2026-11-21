/**
 * Where a browser keeps a Supabase session.
 *
 * `app` is the web app's own session, in the default cookie that middleware refreshes.
 * `excel` is a separate session made for the Excel add-in. It has its own cookie, so
 * signing in for Excel neither replaces nor shares the browser's app session.
 * Supabase rotates refresh tokens, and two holders of one session sign each other out.
 * See docs/EXCEL_ADDIN.md.
 */

export type SessionStore = 'app' | 'excel';

/** Carries the store through an SSO round trip, as NEXT_PATH_COOKIE carries the destination. */
export const SESSION_STORE_COOKIE = 'tapestr-session-store';

/** The page that hands an Excel session to the add-in. */
export const EXCEL_CONNECT_PATH = '/excel/connect';

export function sessionStoreFrom(value: string | null | undefined): SessionStore {
  return value === 'excel' ? 'excel' : 'app';
}

/** The cookie name for a store. Null keeps Supabase's default name. */
export function sessionCookieName(store: SessionStore, projectRef: string | null): string | null {
  if (store === 'app') return null;
  return `sb-${projectRef || 'local'}-excel-auth-token`;
}

export function sessionStoreCookie(store: SessionStore): string {
  return store === 'app'
    ? `${SESSION_STORE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    : `${SESSION_STORE_COOKIE}=${store}; Path=/; Max-Age=600; SameSite=Lax`;
}

/** Cookies that hold one store's session: the value, its chunks, and the PKCE verifier. */
export function sessionCookieNames(cookieHeader: string, cookieName: string): string[] {
  return cookieHeader
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .filter((name) => name === cookieName || name.startsWith(`${cookieName}.`) || name === `${cookieName}-code-verifier`);
}
