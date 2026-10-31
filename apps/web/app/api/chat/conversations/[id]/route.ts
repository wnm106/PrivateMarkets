import { NextRequest, NextResponse } from 'next/server';
import { authenticate, deriveTitle, selectConversationRows } from '@/lib/chat-server';
import { ATTACHMENT_COLUMNS, CHAT_ATTACHMENT_BUCKET } from '@/lib/chat-attachments';

/**
 * GET    /api/chat/conversations/:id   -- the thread plus its messages
 * PATCH  /api/chat/conversations/:id   -- rename
 * DELETE /api/chat/conversations/:id   -- delete (messages and attachment rows cascade,
 *                                         attachment objects are removed explicitly)
 *
 * RLS restricts every statement to rows owned by the caller, so a non-owner
 * simply sees no rows rather than a permission error.
 */

const MESSAGE_COLUMNS = 'id, role, content, tool_calls, model, created_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 });

  const { data: conversation, error: conversationError } = await selectConversationRows((columns) =>
    auth.supabase.from('chat_conversations').select(columns).eq('id', id).maybeSingle()
  );

  if (conversationError) {
    return NextResponse.json({ error: conversationError.message }, { status: 500 });
  }
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const { data: messages, error: messagesError } = await auth.supabase
    .from('chat_messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  if (messagesError) {
    return NextResponse.json({ error: messagesError.message }, { status: 500 });
  }

  // Fold stored attachments onto the message they were sent with.
  const { data: attachments } = await auth.supabase
    .from('chat_message_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('conversation_id', id)
    .not('message_id', 'is', null)
    .order('created_at', { ascending: true });

  const byMessage = new Map<string, any[]>();
  for (const a of attachments ?? []) {
    const list = byMessage.get(a.message_id) ?? [];
    list.push(a);
    byMessage.set(a.message_id, list);
  }

  const withAttachments = (messages ?? []).map((m) => ({
    ...m,
    attachments: byMessage.get(m.id) ?? [],
  }));

  return NextResponse.json({ conversation, messages: withAttachments });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 });

  let body: { title?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });

  const { data, error } = await selectConversationRows((columns) =>
    auth.supabase
      .from('chat_conversations')
      .update({ title: deriveTitle(title, 200) })
      .eq('id', id)
      .select(columns)
      .maybeSingle()
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  return NextResponse.json({ conversation: data });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid conversation id' }, { status: 400 });

  // Collect storage paths first. Deleting the conversation cascades to the
  // attachment rows, which would otherwise drop the only pointer to these objects
  // and leak their bytes into the bucket.
  const { data: attachments } = await auth.supabase
    .from('chat_message_attachments')
    .select('storage_path')
    .eq('conversation_id', id);

  const { data, error } = await auth.supabase
    .from('chat_conversations')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  const paths = (attachments ?? []).map((a: any) => a.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: storageError } = await auth.supabase.storage.from(CHAT_ATTACHMENT_BUCKET).remove(paths);
    if (storageError) {
      console.error('[Chat API] Deleted conversation but could not remove attachment objects:', storageError.message);
    }
  }

  return NextResponse.json({ deleted: true, id: data.id, removedAttachments: paths.length });
}
