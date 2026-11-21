/**
 * What a client's sign-in rules say about a signed-in session. The middleware
 * reads them from tenancy.current_sign_in_decision and acts on the standing.
 */

export interface SignInDecision {
  allowed?: boolean;
  reason?: string | null;
  mfa_required?: boolean;
  mfa_satisfied?: boolean;
}

/**
 * - `allowed`: the rules were read and the session meets them.
 * - `refused`: the rules were read and say no.
 * - `needs_mfa`: allowed, but a second factor is required and has not been given.
 * - `unchecked`: the rules could not be read, or gave no clear answer. This is
 *   never treated as allowed: a page is not served on a check that did not run.
 */
export type SignInStanding = 'allowed' | 'refused' | 'needs_mfa' | 'unchecked';

export const UNCHECKED_SIGN_IN = 'Your sign-in could not be checked. Sign in again.';
export const REFUSED_SIGN_IN = 'This sign-in method is not allowed for this organization.';

/** The decision out of what the database returned, or null when it is not one. */
export function readSignInDecision(data: unknown): SignInDecision | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as SignInDecision;
}

export function signInStanding(decision: SignInDecision | null): SignInStanding {
  if (!decision) return 'unchecked';
  if (decision.allowed === false) return 'refused';
  if (decision.allowed !== true) return 'unchecked';
  // A second factor that is required counts as owed unless the decision says it was given.
  if (decision.mfa_required && decision.mfa_satisfied !== true) return 'needs_mfa';
  return 'allowed';
}

/**
 * What to do with a signed-in request when the sign-in rules could not be
 * checked (`unchecked`). Nothing of the app is served on a check that did not run:
 *
 * - `sign_in_again`: a page. The visitor goes to the sign-in page with the reason.
 * - `forbid`: an API route. It answers 403.
 * - `serve`: a public page, a static file, or the sign-in API under /api/auth/,
 *   which a signed-out visitor may reach anyway, so none of them is held back.
 */
export type UncheckedSignInAction = 'serve' | 'forbid' | 'sign_in_again';

export function uncheckedSignInAction(pathname: string, where: { isPublic: boolean; isAsset: boolean }): UncheckedSignInAction {
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return pathname.startsWith('/api/auth/') ? 'serve' : 'forbid';
  }
  if (where.isPublic || where.isAsset) return 'serve';
  return 'sign_in_again';
}
