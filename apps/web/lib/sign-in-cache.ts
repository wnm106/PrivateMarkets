import { signInStanding, type SignInDecision } from '@/lib/sign-in-gate';

/**
 * A short memory of sign-in decisions that let a session in, so a page and the
 * dozen data calls it makes do not each ask the database again.
 *
 * - Keyed by a hash of the session's access token. A new token (a refresh, or a
 *   second factor completed, which changes the token's assurance level) is a new key.
 * - Only "allowed" is kept. Refused, owes a second factor, or could not be checked
 *   are asked again every time, so the gate fails closed exactly as before.
 * - Kept for at most `ttlMs`. A session refused after it was allowed is refused
 *   within that window.
 */
export const SIGN_IN_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;

const allowed = new Map<string, number>();

export async function sessionKey(accessToken: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when this session was allowed less than `ttlMs` ago. */
export function wasRecentlyAllowed(key: string, now = Date.now(), ttlMs = SIGN_IN_CACHE_TTL_MS): boolean {
  const at = allowed.get(key);
  if (at === undefined) return false;
  if (now - at >= ttlMs) {
    allowed.delete(key);
    return false;
  }
  return true;
}

/** Remembers the decision if, and only if, it let the session in. */
export function rememberDecision(key: string, decision: SignInDecision | null, now = Date.now()): void {
  if (signInStanding(decision) !== 'allowed') {
    allowed.delete(key);
    return;
  }
  if (allowed.size >= MAX_ENTRIES) {
    const oldest = allowed.keys().next().value;
    if (oldest !== undefined) allowed.delete(oldest);
  }
  allowed.delete(key);
  allowed.set(key, now);
}

export function forgetDecision(key: string): void {
  allowed.delete(key);
}

/** For tests. */
export function clearSignInCache(): void {
  allowed.clear();
}
