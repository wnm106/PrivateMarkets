import { NextRequest, NextResponse } from 'next/server';
import { checkServer } from '@tapestrai/mcp-server/src/external/client';
import { serverFromRuntimeRow, serverView } from '@tapestrai/mcp-server/src/external/rows';
import { friendlyError } from '@/lib/assistant-connections';
import { callerSession, findServer, serviceClient } from '@/lib/assistant-connections-server';

export const dynamic = 'force-dynamic';

/**
 * Connects to a server, lists its tools and records the result. The caller
 * must be able to manage the server's client; the stored credential is read
 * with the service role only after that check, and never returned.
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await callerSession();
  if (!session) return NextResponse.json({ error: 'Sign in to check a connection.' }, { status: 401 });
  const { id } = await context.params;
  const visible = await findServer(session, id).catch(() => null);
  if (!visible) return NextResponse.json({ error: 'Server was not found.' }, { status: 404 });
  if (!visible.canManage) return NextResponse.json({ error: 'You cannot manage assistant connections for this client.' }, { status: 403 });

  try {
    const service = serviceClient();
    const { data: row, error } = await service.rpc('assistant_mcp_server_context', { p_id: id });
    if (error || !row) throw error || new Error('Server was not found.');
    const server = serverFromRuntimeRow(row as Record<string, any>);

    let ok = true;
    let message: string;
    let tools: unknown = null;
    try {
      const result = await checkServer(server);
      tools = result.tools;
      message = `Connected. The server lists ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}.`;
    } catch (failure) {
      ok = false;
      message = failure instanceof Error ? failure.message : 'The server could not be reached.';
    }

    const { data: saved, error: saveError } = await service.rpc('assistant_mcp_server_checked', {
      p_id: id,
      p_ok: ok,
      p_message: message,
      p_tools: tools,
    });
    if (saveError) throw saveError;
    const view = serverView(saved as Record<string, any>);
    return NextResponse.json({ server: { ...view, canManage: true }, ok, message });
  } catch (error) {
    return NextResponse.json({ error: friendlyError(error).message }, { status: 400 });
  }
}
