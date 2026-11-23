import type { NextRequest } from 'next/server';
import { handleMcpHttpRequest } from '@tapestrai/mcp-server/src/http';
import { authenticate, bearerToken } from '@/lib/chat-server';
import { REMOTE_TOOL_EFFECTS, bearerChallenge, publicOrigin, signInRefusal } from '@/lib/mcp-remote';
import { readSignInDecision } from '@/lib/sign-in-gate';

/**
 * The MCP server over HTTP, for an assistant outside the app (a claude.ai
 * connector). See docs/API.md, "Remote MCP endpoint".
 *
 * The caller is the person whose access token the request carries, issued by
 * the Supabase Auth server after they approved the connection. Every tool runs
 * with that token, so tenancy and row security decide what it can see. No
 * session cookie is read: middleware lets the request through untouched, so the
 * sign-in rules it applies to the app are applied here instead.
 */

export const dynamic = 'force-dynamic';

function unauthorized(request: Request, error?: { code: string; description: string }): Response {
  return Response.json(
    { error: error?.description ?? 'Sign in to use the tapestr.ai connector.' },
    { status: 401, headers: { 'WWW-Authenticate': bearerChallenge(publicOrigin(request), error) } }
  );
}

async function handle(request: NextRequest): Promise<Response> {
  if (!bearerToken(request)) return unauthorized(request);

  const auth = await authenticate(request);
  if (!auth) {
    return unauthorized(request, { code: 'invalid_token', description: 'The access token is not valid or has expired.' });
  }

  const { data, error } = await auth.supabase.schema('tenancy').rpc('current_sign_in_decision');
  const refusal = signInRefusal(error ? null : readSignInDecision(data));
  if (refusal) return Response.json({ error: refusal }, { status: 403 });

  return handleMcpHttpRequest(request, { client: auth.supabase, effects: REMOTE_TOOL_EFFECTS });
}

export { handle as GET, handle as POST, handle as DELETE };
