/**
 * The Supabase browser client keeps the session in a cookie. Middleware can
 * refresh that cookie without the page remounting, which leaves a copy in
 * localStorage stale. GraphQL requests should read the cookie each time.
 */

/** `@supabase/ssr` stores the session as `base64-` plus base64url, which `atob` rejects. */
function decodeBase64Url(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function accessTokenFromAuthCookie(raw: string): string | null {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  if (value.startsWith('base64-')) {
    const decoded = decodeBase64Url(value.slice('base64-'.length));
    if (!decoded) return null;
    value = decoded;
  }
  try {
    const session = JSON.parse(value) as { access_token?: string };
    return session.access_token || null;
  } catch {
    return null;
  }
}

export function supabaseProjectRef(supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  if (!supabaseUrl) return null;
  try {
    return new URL(supabaseUrl).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

/** Reads one project's session. A leftover cookie from another project must not win. */
export function accessTokenFromCookieHeader(header: string, projectRef: string | null): string | null {
  const cookieName = projectRef ? `sb-${projectRef}-auth-token` : null;
  const chunks = new Map<number, string>();
  let single: string | null = null;
  for (const part of header.split('; ')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (cookieName) {
      if (name !== cookieName && !name.startsWith(`${cookieName}.`)) continue;
      const chunk = name.slice(cookieName.length + 1);
      if (!chunk) single = value;
      else if (/^\d+$/.test(chunk)) chunks.set(Number(chunk), value);
      continue;
    }
    const match = name.match(/^sb-[A-Za-z0-9]+-auth-token(?:\.(\d+))?$/);
    if (!match) continue;
    if (match[1] == null) single = value;
    else chunks.set(Number(match[1]), value);
  }
  const raw = chunks.size
    ? [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('')
    : single;
  return raw ? accessTokenFromAuthCookie(raw) : null;
}

function tokenFromSupabaseCookie(): string | null {
  return accessTokenFromCookieHeader(document.cookie, supabaseProjectRef());
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
