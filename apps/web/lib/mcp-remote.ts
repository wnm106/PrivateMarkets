import type { ToolEffect } from '@tapestrai/mcp-server/src/lib/types';
import { REFUSED_SIGN_IN, UNCHECKED_SIGN_IN, signInStanding, type SignInDecision } from './sign-in-gate';

/**
 * The MCP endpoint an outside assistant connects to (a claude.ai connector),
 * and what it tells that assistant about signing in. See docs/API.md,
 * "Remote MCP endpoint".
 *
 * Sign-in is the Supabase Auth server's own OAuth 2.1 flow. This app adds the
 * two things that flow needs from it: the document that names the Auth server
 * (protectedResourceMetadata) and the page where the person approves
 * (OAUTH_CONSENT_PATH).
 */

export const MCP_PATH = '/api/mcp';
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const OAUTH_CONSENT_PATH = '/oauth/consent';

/**
 * What the endpoint offers. A tool that changes live records, rules or settings
 * is never run by an assistant on its own: in the app's chat it is held for the
 * person to confirm (lib/held-actions.ts). An outside assistant has no such
 * hold, so those tools are left out.
 */
export const REMOTE_TOOL_EFFECTS: readonly ToolEffect[] = ['read', 'stage'];

function firstValue(header: string | null): string {
  return (header || '').split(',')[0].trim();
}

/**
 * The address the outside world reaches this app at. Behind a proxy or a
 * tunnel the request's own address is the inner one, so the forwarded host and
 * scheme are used when the proxy gives them. MCP_PUBLIC_ORIGIN overrides both.
 */
export function publicOrigin(request: Request, configured = process.env.MCP_PUBLIC_ORIGIN): string {
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Not an address. Fall through to the request.
    }
  }
  const url = new URL(request.url);
  const forwardedHost = firstValue(request.headers.get('x-forwarded-host'));
  const forwardedProto = firstValue(request.headers.get('x-forwarded-proto'));
  // The forwarded host replaces host and port together: the inner port is not the outer one.
  const host = /^[A-Za-z0-9.-]+(:\d+)?$/.test(forwardedHost) ? forwardedHost : url.host;
  const proto = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : url.protocol.replace(':', '');
  return new URL(`${proto}://${host}`).origin;
}

/** The Supabase Auth server, which issues the tokens the endpoint accepts. */
export function authorizationServer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
}

/** OAuth 2.0 Protected Resource Metadata (RFC 9728) for the endpoint. */
export function protectedResourceMetadata(origin: string, supabaseUrl: string) {
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [authorizationServer(supabaseUrl)],
    bearer_methods_supported: ['header'],
    resource_name: 'tapestr.ai',
  };
}

function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, '').replace(/[^\x20-\x7E]/g, '')}"`;
}

/**
 * The WWW-Authenticate value on a 401. It is how a client that has no token,
 * or a stale one, finds the document above and starts sign-in.
 */
export function bearerChallenge(origin: string, error?: { code: string; description: string }): string {
  const parts = [`resource_metadata=${quoted(`${origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`)}`];
  if (error) parts.push(`error=${quoted(error.code)}`, `error_description=${quoted(error.description)}`);
  return `Bearer ${parts.join(', ')}`;
}

/**
 * The site an approval returns the browser to, for the approval page to show.
 * Anyone can register an app under any name, so the name alone does not say
 * who is asking; where the answer goes does.
 */
export function consentReturnHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host || redirectUri;
  } catch {
    return redirectUri;
  }
}

/**
 * Why a signed-in caller is turned away, or null when they may go on. The
 * client's sign-in rules hold here as they do in the app (middleware.ts): a
 * decision that could not be read is never treated as allowed.
 */
export function signInRefusal(decision: SignInDecision | null): string | null {
  const standing = signInStanding(decision);
  if (standing === 'allowed') return null;
  if (standing === 'refused') return decision?.reason || REFUSED_SIGN_IN;
  if (standing === 'needs_mfa') {
    return 'Your organization requires an authenticator code. Sign in to tapestr.ai with it, then connect again.';
  }
  return UNCHECKED_SIGN_IN;
}
