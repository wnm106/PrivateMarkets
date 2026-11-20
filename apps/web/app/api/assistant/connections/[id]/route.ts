import { NextRequest, NextResponse } from 'next/server';
import { friendlyError } from '@/lib/assistant-connections';
import { callerSession } from '@/lib/assistant-connections-server';

export const dynamic = 'force-dynamic';

/** Removes a server and its stored credential. */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await callerSession();
  if (!session) return NextResponse.json({ error: 'Sign in to change assistant connections.' }, { status: 401 });
  const { id } = await context.params;
  const { data, error } = await session.supabase.rpc('assistant_mcp_server_delete', { p_id: id });
  if (error) return NextResponse.json({ error: friendlyError(error).message }, { status: 400 });
  if (data !== true) return NextResponse.json({ error: 'Server was not found.' }, { status: 404 });
  return NextResponse.json({ success: true });
}
