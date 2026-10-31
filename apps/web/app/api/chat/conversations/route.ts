import { NextRequest, NextResponse } from 'next/server';
import { authenticate, deriveTitle, selectConversationRows } from '@/lib/chat-server';

/**
 * GET  /api/chat/conversations        -- list the caller's threads, most recent first
 * POST /api/chat/conversations        -- create a thread
 *
 * Every query runs as the caller, so `chat_conversations` RLS scopes results to
 * the signed-in user without the handler having to filter by owner itself.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  const limit = Math.min(
    Math.max(Number(request.nextUrl.searchParams.get('limit')) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );

  const { data, error } = await selectConversationRows((columns) =>
    auth.supabase
      .from('chat_conversations')
      .select(columns)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit)
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ conversations: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  let body: {
    title?: string;
    toolContext?: string;
    context?: { page?: string; domainCode?: string; entityId?: string };
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { data, error } = await selectConversationRows((columns) =>
    auth.supabase
      .from('chat_conversations')
      .insert({
        created_by: auth.userId,
        title: deriveTitle(body.title ?? ''),
        tool_context: body.toolContext ?? null,
        page_context: body.context?.page ?? null,
        domain_code: body.context?.domainCode ?? null,
        entity_id: null,
      })
      .select(columns)
      .single()
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ conversation: data }, { status: 201 });
}
