import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadExternalServers } from '@tapestrai/mcp-server/src/external/load';
import { buildExternalToolset, type ExternalToolset } from '@tapestrai/mcp-server/src/external/toolset';
import { serviceClient } from '@/lib/assistant-connections-server';
import { callerClientId } from '@/lib/agent-audit';
import { authenticate, supabaseAnonKey, supabaseUrl } from '@/lib/chat-server';
import { toolRegistry } from '@/lib/chat-tools';
import { releaseAction } from '@/lib/held-actions';

/**
 * POST /api/chat/confirm  { token, conversationId? }
 *
 * Runs one change the assistant held for confirmation, because the signed-in
 * person pressed Confirm on it: a write to one of the client's MCP servers, or
 * one of Tapestry's own tools that changes live records, rules or settings.
 *
 * The token says exactly which tool and arguments; nothing in the request can
 * change them. It must have been held for this person and client, within the
 * last few minutes, and is run at most once (chat_held_action_uses). A
 * Tapestry tool runs as the person, so row security applies; an outside tool
 * must still be enabled on the client's connection. See lib/held-actions.ts.
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

    // Recorded before it runs, so pressing Confirm twice, or sending the request again, runs it once.
    const { error: useError } = await auth.supabase
      .from('chat_held_action_uses')
      .insert({ hold_id: call.id, user_id: auth.userId, client_id: clientId, tool: call.name });
    if (useError) {
      const already = useError.code === '23505';
      return NextResponse.json(
        { error: already ? 'This change was already confirmed.' : `The confirmation could not be recorded: ${useError.message}` },
        { status: already ? 409 : 500 },
      );
    }

    let ok: boolean;
    let detail: string;
    if (call.kind === 'internal') {
      if (toolRegistry.effectOf(call.name) !== 'write') {
        return NextResponse.json({ error: `${call.tool} is not a change that needs confirming.` }, { status: 400 });
      }
      // As the person: their JWT, so tenancy and row security decide what the tool may change.
      const asCaller = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${auth.token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      try {
        const value = await toolRegistry.executeTool(call.name, call.args, asCaller);
        const refused = value && typeof value === 'object' && ('error' in value) && value.error;
        ok = !refused;
        detail = refused ? String(value.error) : JSON.stringify(value).slice(0, 2000);
      } catch (error) {
        ok = false;
        detail = error instanceof Error ? error.message : String(error);
      }
    } else {
      // Built afresh, so a tool an administrator has since turned off is not run.
      toolset = buildExternalToolset(await loadExternalServers(serviceClient(), clientId));
      if (!toolset.has(call.name)) {
        return NextResponse.json({ error: `${call.tool} is no longer enabled for ${call.serverName}, so it was not run.` }, { status: 409 });
      }
      const result = await toolset.executeConfirmed(call.name, call.args);
      ok = !result.isError;
      detail = result.text || '';
    }
    const where = call.kind === 'internal' ? '' : ` in ${call.serverName}`;
    const text = ok
      ? `Confirmed and ran ${call.tool}${where}.${detail ? `\n\n${detail.slice(0, 2000)}` : ''}`
      : `${call.tool}${where} did not go through${detail ? `: ${detail.slice(0, 500)}` : '.'}`;

    if (typeof conversationId === 'string' && conversationId) {
      // As the caller, so the thread's own row security decides whether it may be written.
      await auth.supabase.from('chat_messages').insert({
        conversation_id: conversationId,
        role: 'model',
        content: text,
        tool_calls: [{ name: call.name, args: call.args, confirmedBy: auth.userId }],
      });
    }
    return NextResponse.json({ ok, text });
  } catch (error) {
    console.error('[Chat confirm] Error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'The change could not be run.' }, { status: 500 });
  } finally {
    await toolset?.close();
  }
}
