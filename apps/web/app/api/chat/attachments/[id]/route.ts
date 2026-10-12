import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/chat-server';
import { CHAT_ATTACHMENT_BUCKET } from '@/lib/chat-attachments';

/**
 * GET /api/chat/attachments/:id
 *
 * Streams the stored object back to its owner. RLS on `chat_message_attachments`
 * resolves the row (so a non-owner gets 404), and the download itself runs with
 * the caller's token, so the bucket's `{uid}/` prefix policy also applies.
 */

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid attachment id' }, { status: 400 });

  const { data: row } = await auth.supabase
    .from('chat_message_attachments')
    .select('file_name, mime_type, storage_path')
    .eq('id', id)
    .maybeSingle();

  if (!row) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });

  const { data: blob, error } = await auth.supabase.storage
    .from(CHAT_ATTACHMENT_BUCKET)
    .download(row.storage_path);

  if (error || !blob) {
    return NextResponse.json({ error: error?.message || 'Could not read attachment' }, { status: 500 });
  }

  return new NextResponse(await blob.arrayBuffer(), {
    headers: {
      'Content-Type': row.mime_type,
      // The filename is echoed back out, so keep it inert.
      'Content-Disposition': `inline; filename="${row.file_name.replace(/[^\w.\- ]+/g, '_')}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
