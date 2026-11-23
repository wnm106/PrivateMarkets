import { protectedResourceMetadata, publicOrigin } from '@/lib/mcp-remote';
import { supabaseUrl } from '@/lib/chat-server';

/**
 * Tells an MCP client which server signs people in for /api/mcp (RFC 9728).
 * A client reads it after the endpoint answers 401. It is asked for at this
 * address and at this address followed by the endpoint's path; both answer
 * the same.
 */

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return Response.json(protectedResourceMetadata(publicOrigin(request), supabaseUrl), {
    headers: {
      // The address in it depends on how the request arrived, so it is not kept by a cache.
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
