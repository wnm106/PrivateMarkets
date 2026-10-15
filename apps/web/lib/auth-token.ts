/**
 * The Supabase browser client keeps the session in a cookie. Middleware can
 * refresh that cookie without the page remounting, which leaves a copy in
 * localStorage stale. GraphQL requests should read the cookie each time.
 */

function decodeCookieValue(raw: string): string | null {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  if (value.startsWith('base64-')) {
    try {
      value = atob(value.slice('base64-'.length));
    } catch {
      return null;
    }
  }
  try {
    const session = JSON.parse(value) as { access_token?: string };
    return session.access_token || null;
  } catch {
    return null;
  }
}

function tokenFromSupabaseCookie(): string | null {
  const chunks = new Map<number, string>();
  let single: string | null = null;
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    const match = name.match(/^sb-[A-Za-z0-9]+-auth-token(?:\.(\d+))?$/);
    if (!match) continue;
    if (match[1] == null) single = value;
    else chunks.set(Number(match[1]), value);
  }
  const raw = chunks.size
    ? [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('')
    : single;
  return raw ? decodeCookieValue(raw) : null;
}

export function readBrowserAccessToken(): string | null {
  if (typeof document === 'undefined') return null;
  const token = tokenFromSupabaseCookie();
  try {
    if (token) localStorage.setItem('auth_token', token);
    else localStorage.removeItem('auth_token');
  } catch {
    /* ignore */
  }
  return token;
}

export function browserSessionIsActive(): boolean {
  const token = readBrowserAccessToken();
  if (!token) return false;
  const segment = token.split('.')[1];
  if (!segment) return false;
  try {
    const payload = JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}
