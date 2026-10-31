import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { authenticate, selectConversationRows } from '@/lib/chat-server';
import {
  ATTACHMENT_COLUMNS,
  CHAT_ATTACHMENT_BUCKET,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
  attachmentObjectPath,
} from '@/lib/chat-attachments';

/**
 * POST /api/chat/attachments  (multipart/form-data)
 *
 * Fields: `file` (required), `conversationId` (optional), `messageId` (optional).
 *
 * Uploads run as the caller against the private `chat-attachments` bucket, whose
 * policies only allow objects under the caller's own `{uid}/` prefix. The
 * conversation row is created on demand so a file can be staged before the first
 * message of a new thread is sent.
 */

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'File is empty' }, { status: 400 });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: `File is larger than ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB` },
      { status: 413 }
    );
  }

  const mimeType = file.type || 'application/octet-stream';
  const fileName = (file.name || 'attachment').slice(0, 300);

  // Resolve (or create) the thread this file belongs to.
  const requestedConversationId = form.get('conversationId');
  let conversationId =
    typeof requestedConversationId === 'string' && requestedConversationId ? requestedConversationId : null;

  if (conversationId) {
    const { data } = await selectConversationRows((columns) =>
      auth.supabase.from('chat_conversations').select(columns).eq('id', conversationId).maybeSingle()
    );
    if (!data) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  } else {
    const { data: created, error } = await selectConversationRows((columns) =>
      auth.supabase
        .from('chat_conversations')
        .insert({ created_by: auth.userId, title: 'New chat' })
        .select(columns)
        .single()
    );
    if (error || !created) {
      return NextResponse.json({ error: error?.message || 'Could not start a conversation' }, { status: 500 });
    }
    conversationId = (created as { id: string }).id;
  }

  // Enforce the per-turn cap against what is already staged on this thread.
  const { count } = await auth.supabase
    .from('chat_message_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .is('message_id', null);
  if ((count ?? 0) >= MAX_ATTACHMENTS_PER_TURN) {
    return NextResponse.json(
      { error: `A message can carry at most ${MAX_ATTACHMENTS_PER_TURN} attachments` },
      { status: 400 }
    );
  }

  const attachmentId = randomUUID();
  const objectPath = attachmentObjectPath(auth.userId, fileName, attachmentId);

  const { error: uploadError } = await auth.supabase.storage
    .from(CHAT_ATTACHMENT_BUCKET)
    .upload(objectPath, file, { contentType: mimeType, upsert: false });
  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  const messageId = form.get('messageId');

  const { data: row, error: insertError } = await auth.supabase
    .from('chat_message_attachments')
    .insert({
      id: attachmentId,
      conversation_id: conversationId,
      message_id: typeof messageId === 'string' && messageId ? messageId : null,
      uploaded_by: auth.userId,
      file_name: fileName,
      mime_type: mimeType,
      byte_size: file.size,
      storage_path: objectPath,
    })
    .select(ATTACHMENT_COLUMNS)
    .single();

  if (insertError || !row) {
    // Don't leave bytes behind if the metadata row could not be written.
    await auth.supabase.storage.from(CHAT_ATTACHMENT_BUCKET).remove([objectPath]);
    return NextResponse.json({ error: insertError?.message || 'Could not record attachment' }, { status: 500 });
  }

  return NextResponse.json({ attachment: row, conversationId }, { status: 201 });
}
