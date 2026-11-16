export const NEXT_PATH_COOKIE = 'tapestr-next';

/** A same-app path. Rejects protocol-relative URLs and the pages that bounce a signed-in user. */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('://')) {
    return fallback;
  }
  const path = value.split('?')[0]?.split('#')[0] || '/';
  if (path === '/login' || path === '/welcome' || path === '/auth/callback' || path.startsWith('/auth/callback/')) {
    return fallback;
  }
  return value;
}

export function nextPathCookie(path: string): string {
  return `${NEXT_PATH_COOKIE}=${encodeURIComponent(safeNextPath(path))}; Path=/; Max-Age=600; SameSite=Lax`;
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
