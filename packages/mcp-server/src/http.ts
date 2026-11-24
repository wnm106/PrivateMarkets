import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createTapestraiServer, type TapestraiServerOptions } from './create-server';

/**
 * The MCP server over Streamable HTTP, for a client that cannot run a local
 * process (a claude.ai connector).
 *
 * Each request is answered on its own: a server is built for that request with
 * the caller's database client, answers in JSON, and is closed. Nothing is kept
 * between requests, so it runs on a host that keeps no memory between them, and
 * one caller's client can never serve another's request.
 *
 * The caller decides who the request is from before calling this. It checks
 * nothing itself: `options.client` must already be the signed-in person's.
 */
export async function handleMcpHttpRequest(request: Request, options: TapestraiServerOptions): Promise<Response> {
  // Only POST carries messages. GET would open a stream for server-sent
  // notices, which this server never sends, and there is no session to DELETE.
  if (request.method !== 'POST') {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Send MCP messages with POST.' }, id: null },
      { status: 405, headers: { Allow: 'POST' } }
    );
  }

  const server = createTapestraiServer(options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // No session id: every request stands alone.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    // In JSON mode this resolves once every message in the request is answered.
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}
