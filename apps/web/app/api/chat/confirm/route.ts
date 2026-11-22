import { NextRequest, NextResponse } from 'next/server';
import { loadExternalServers } from '@tapestrai/mcp-server/src/external/load';
import { buildExternalToolset, type ExternalToolset } from '@tapestrai/mcp-server/src/external/toolset';
import { serviceClient } from '@/lib/assistant-connections-server';
import { callerClientId } from '@/lib/agent-audit';
import { authenticate } from '@/lib/chat-server';
import { releaseAction } from '@/lib/held-actions';

/**
 * POST /api/chat/confirm  { token, conversationId? }
 *
 * Runs one outside change the assistant held for confirmation, because the
 * signed-in person pressed Confirm on it. The token says exactly which tool and
 * arguments; nothing in the request can change them. It must have been held
 * for this person and client, within the last few minutes, and the tool must
 * still be enabled on the client's connection. See lib/held-actions.ts.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  let toolset: ExternalToolset | null = null;
  try {
    const { token, conversationId } = await request.json().catch(() => ({}));
    const clientId = await callerClientId(auth.supabase);
    if (!clientId) return NextResponse.json({ error: 'You are not signed in to a client.' }, { status: 403 });

    let call;
    try {
      call = releaseAction(String(token || ''), { userId: auth.userId, clientId });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'This confirmation is not valid.' }, { status: 400 });
    }

    // Built afresh, so a tool an administrator has since turned off is not run.
    toolset = buildExternalToolset(await loadExternalServers(serviceClient(), clientId));
    if (!toolset.has(call.name)) {
      return NextResponse.json({ error: `${call.tool} is no longer enabled for ${call.serverName}, so it was not run.` }, { status: 409 });
    }
    const result = await toolset.executeConfirmed(call.name, call.args);
    const text = result.isError
      ? `${call.serverName} refused ${call.tool}${result.text ? `: ${result.text.slice(0, 500)}` : '.'}`
      : `Confirmed and ran ${call.tool} in ${call.serverName}.${result.text ? `\n\n${result.text.slice(0, 2000)}` : ''}`;

    if (typeof conversationId === 'string' && conversationId) {
      // As the caller, so the thread's own row security decides whether it may be written.
      await auth.supabase.from('chat_messages').insert({
        conversation_id: conversationId,
        role: 'model',
        content: text,
        tool_calls: [{ name: call.name, args: call.args, confirmedBy: auth.userId }],
      });
    }
    return NextResponse.json({ ok: !result.isError, text });
  } catch (error) {
    console.error('[Chat confirm] Error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'The change could not be run.' }, { status: 500 });
  } finally {
    await toolset?.close();
  }
}
