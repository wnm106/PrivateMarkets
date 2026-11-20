import { NextRequest, NextResponse } from 'next/server';
import { serverView } from '@tapestrai/mcp-server/src/external/rows';
import { cleanServerInput, friendlyError, type ServerInput } from '@/lib/assistant-connections';
import { callerSession, canManage, findServer, listServers, listSources } from '@/lib/assistant-connections-server';

export const dynamic = 'force-dynamic';

/** The client's MCP servers (never their credentials) and the sources one can be tied to. */
export async function GET() {
  const session = await callerSession();
  if (!session) return NextResponse.json({ error: 'Sign in to see assistant connections.' }, { status: 401 });
  try {
    const [servers, sources, manage] = await Promise.all([listServers(session), listSources(session), canManage(session)]);
    return NextResponse.json({ servers, sources, canManage: manage, hasClient: Boolean(session.clientId) });
  } catch (error) {
    return NextResponse.json({ error: friendlyError(error).message }, { status: 400 });
  }
}

/** Adds or changes a server. */
export async function POST(request: NextRequest) {
  const session = await callerSession();
  if (!session) return NextResponse.json({ error: 'Sign in to change assistant connections.' }, { status: 401 });
  const input = (await request.json().catch(() => ({}))) as ServerInput;
  try {
    const existing = input.id ? await findServer(session, input.id) : null;
    if (input.id && !existing) return NextResponse.json({ errors: [{ field: 'id', message: 'Server was not found.' }] }, { status: 404 });
    const clientId = existing?.clientId || session.clientId;
    if (!clientId) return NextResponse.json({ errors: [{ field: null, message: 'Choose a client before adding a server.' }] }, { status: 400 });

    const { value, errors } = cleanServerInput(input, existing, existing?.tools || []);
    if (!value) return NextResponse.json({ errors }, { status: 400 });

    const { data, error } = await session.supabase.rpc('assistant_mcp_server_save', {
      p_id: value.id,
      p_client_id: clientId,
      p_server_code: value.serverCode,
      p_server_name: value.serverName,
      p_url: value.url,
      p_auth_type: value.authType,
      p_header_name: value.headerName,
      p_secret: value.secret,
      p_source_code: value.sourceCode,
      p_instructions: value.instructions,
      p_identifier_hints: value.identifierHints,
      p_enabled_tools: value.enabledTools,
      p_write_tools: value.writeTools,
      p_is_active: value.isActive,
    });
    if (error) return NextResponse.json({ errors: [friendlyError(error)] }, { status: 400 });
    return NextResponse.json({ server: serverView(data as Record<string, any>), errors: [] });
  } catch (error) {
    return NextResponse.json({ errors: [friendlyError(error)] }, { status: 400 });
  }
}
