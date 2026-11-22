export const NEXT_PATH_COOKIE = 'tapestr-next';

/** A stand-in origin for resolving a path the way a browser would. It is never requested. */
const PROBE_ORIGIN = 'https://next-path.invalid';

/** ASCII control characters (tab and newline among them) and the backslash. */
const UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F\\]/;

/**
 * The text as given, and as it reads after percent-decoding. Null when it is
 * not valid encoding, or is encoded more deeply than any real path would be.
 */
function decodedForms(text: string): string[] | null {
  const forms = [text];
  let current = text;
  for (let depth = 0; depth < 3; depth += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return forms;
    forms.push(next);
    current = next;
  }
  return null;
}

/** One leading slash, and nothing a URL parser would drop or read as a slash. */
function startsInsideApp(text: string): boolean {
  return text.startsWith('/') && !text.startsWith('//') && !UNSAFE_CHARACTERS.test(text);
}

/**
 * A same-app path to send someone to after they sign in. Anything else gives
 * the fallback. Refused:
 *
 * - another site, in any spelling: `https://evil.example`, `//evil.example`,
 *   `/\evil.example` (a backslash reads as a slash);
 * - a tab, newline or other control character anywhere. URL parsers drop
 *   them, so `/<tab>/evil.example` is read as `//evil.example`;
 * - the same in the path, percent-encoded (`/%09/evil.example`), in case a
 *   later step decodes it;
 * - a path that resolves to another origin, or to one that starts with `//`;
 * - the pages that bounce a signed-in user (sign-in, welcome, the callback).
 */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || !value) return fallback;
  if (!startsInsideApp(value) || value.includes('://')) return fallback;
  // The part before the query is what decides where a browser goes.
  const pathForms = decodedForms(value.split(/[?#]/)[0]);
  if (!pathForms || !pathForms.every(startsInsideApp)) return fallback;

  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (resolved.origin !== PROBE_ORIGIN || resolved.pathname.startsWith('//')) return fallback;

  const path = resolved.pathname.length > 1 ? resolved.pathname.replace(/\/+$/, '') : resolved.pathname;
  if (path === '/login' || path === '/welcome' || path === '/auth/callback' || path.startsWith('/auth/callback/')) {
    return fallback;
  }
  return value;
}

export function nextPathCookie(path: string): string {
  return `${NEXT_PATH_COOKIE}=${encodeURIComponent(safeNextPath(path))}; Path=/; Max-Age=600; SameSite=Lax`;
}

/** The path a visitor was heading for, from the cookie nextPathCookie wrote. A value that cannot be read gives the fallback. */
export function nextPathFromCookie(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  try {
    return safeNextPath(decodeURIComponent(raw), fallback);
  } catch {
    return fallback;
  }
}

/** Login URL that returns the visitor to an in-app path after they sign in. */
export function loginPath(pathname: string): string {
  return `/login?redirectedFrom=${encodeURIComponent(safeNextPath(pathname))}`;
}

export function isUnauthenticatedGraphqlError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { message?: unknown; graphQLErrors?: Array<{ message?: unknown }> };
  const parts = [record.message, ...(record.graphQLErrors || []).map((item) => item?.message)];
  return parts.some((part) => typeof part === 'string' && /not authenticated/i.test(part));
}
