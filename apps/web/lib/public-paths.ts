/**
 * Pages someone who is not signed in may open. The middleware and the
 * signed-out gate both read this, so the two cannot disagree.
 *
 * Each is an exact address, except a portal form, which is /portal/<token>.
 * An address under one of the others (such as /welcome/anything) is not
 * public: it would otherwise fall through to the record pages and show a
 * signed-out visitor a database error.
 */

const EXACT = new Set(['/welcome', '/login', '/no-access', '/auth/callback']);
const PREFIXES = ['/portal/'];

export function isPublicPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return EXACT.has(path) || PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
