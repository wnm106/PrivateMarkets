/**
 * Pages someone who is not signed in may open. The middleware and the
 * signed-out gate both read this, so the two cannot disagree.
 *
 * Each is an exact address, except a portal form, which is /portal/<token>, and
 * the Excel add-in's static files under /excel/addin/. The Excel sign-in page
 * (/excel/connect) signs in a separate session of its own (lib/session-store.ts).
 * An address under one of the others (such as /welcome/anything) is not
 * public: it would otherwise fall through to the record pages and show a
 * signed-out visitor a database error.
 *
 * /.well-known/ holds the document an MCP client reads before it has signed
 * anyone in (lib/mcp-remote.ts). The page where a person approves that client,
 * /oauth/consent, is not public: they sign in first.
 */

const EXACT = new Set(['/welcome', '/login', '/no-access', '/auth/callback', '/excel/connect']);
const PREFIXES = ['/portal/', '/excel/addin/', '/.well-known/'];

export function isPublicPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return EXACT.has(path) || PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
