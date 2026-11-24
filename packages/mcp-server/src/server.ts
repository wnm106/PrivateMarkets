import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../../.env') });
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';
import { createTapestraiServer } from './create-server';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

/**
 * A stdio server sees no HTTP request, so it cannot discover who is calling.
 * It must instead be *given* an identity: a Supabase user access token. Every
 * tool and resource query is issued with that token, so tenancy / RLS restrict
 * what this server can read.
 *
 * The service-role key must NOT be used here: the data schemas grant USAGE to
 * `authenticated` only, so a service-role (or anon) key fails on the
 * security-invoker views with "permission denied" before RLS is consulted.
 */
const accessToken = process.env.TAPESTRAI_MCP_ACCESS_TOKEN || '';

/** Reads JWT claims without verifying the signature -- diagnostics only. */
function decodeJwtClaims(token: string): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

let supabase: any = null;

if (!supabaseAnonKey) {
  console.error('[tapestrai-mcp] SUPABASE_ANON_KEY is not set; cannot reach Supabase.');
} else if (!accessToken) {
  console.error('[tapestrai-mcp] No user access token configured.');
  console.error('[tapestrai-mcp] Data tools will fail with "permission denied" because the anon role has no');
  console.error('[tapestrai-mcp] USAGE on the data schemas. Set TAPESTRAI_MCP_ACCESS_TOKEN to a Supabase user');
  console.error('[tapestrai-mcp] access token (see docs/API.md, "Assistant (Chat) API").');
} else {
  const claims = decodeJwtClaims(accessToken);
  if (claims?.role === 'service_role') {
    console.error('[tapestrai-mcp] TAPESTRAI_MCP_ACCESS_TOKEN is a service-role key.');
    console.error('[tapestrai-mcp] The data schemas grant USAGE to `authenticated` only, so tool calls will fail');
    console.error('[tapestrai-mcp] with "permission denied". Supply a signed-in user token instead.');
  }
  if (claims?.exp && claims.exp * 1000 < Date.now()) {
    console.error(`[tapestrai-mcp] The access token expired at ${new Date(claims.exp * 1000).toISOString()}.`);
  } else if (claims?.exp) {
    console.error(`[tapestrai-mcp] Token expires ${new Date(claims.exp * 1000).toISOString()}.`);
  }
  console.error(`[tapestrai-mcp] Acting as user ${claims?.sub ?? 'unknown'} (role: ${claims?.role ?? 'unknown'}).`);

  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    accessToken: async () => accessToken,
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Turns opaque Postgres privilege errors into an actionable message. */
function explainToolError(message: string): string {
  if (/permission denied/i.test(message)) {
    return `${message}\n\nThis server must run as an authenticated user. Set `
      + 'TAPESTRAI_MCP_ACCESS_TOKEN to a Supabase user access token: the data schemas grant USAGE '
      + 'to `authenticated` only, so the anon and service-role keys cannot read them.';
  }
  return message;
}

// The tools, resources and prompts are built in create-server.ts, shared with the HTTP endpoint.
const server = createTapestraiServer({
  client: supabase,
  noClientMessage: 'Error: this MCP server has no database identity configured. Set SUPABASE_ANON_KEY and '
    + 'TAPESTRAI_MCP_ACCESS_TOKEN (a Supabase user access token) so tool calls can run as a user.',
  explainError: explainToolError,
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('tapestr.ai MDM MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
