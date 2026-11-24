import { createHash, randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { DOCUMENT_BUCKET, formatOfFile } from '@tapestrai/graphql/src/lib/document-content';
import { feedWriteClientId, requireFeedUser } from '@/lib/feeds/require-user';
import { supabaseServerClient } from '@/lib/supabase-server';

/**
 * POST /api/documents  (multipart/form-data)
 *
 * Fields: `file`, `typeId`, and optionally `title`, `documentDate` (YYYY-MM-DD),
 * `tags` (comma separated) and `entities` (JSON: [{entityId, role}]).
 *
 * Stores the file under the caller's client in the private documents bucket,
 * records it, and queues it for the job worker to read. A PDF with selectable
 * text, an HTML file or a text file is read on the worker; a scan, a picture or
 * a Word file is read by the outside reader the worker is set up with. Everything runs as the
 * caller: the bucket's policies and document_create both need document.manage.
 * The same file added twice returns the document that already holds it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 50 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to add a document.' }, { status: 401 });
  // A document belongs to one client. Someone in several is refused, not filed under whichever came first.
  const client = await feedWriteClientId('Choose a client before adding a document.');
  if ('error' in client) return client.error;
  const { clientId } = client;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Send the file as a form.' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: 'Choose a file to add.' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Files need to be 50 MB or smaller.' }, { status: 413 });
  const typeId = String(form.get('typeId') || '');
  if (!typeId) return NextResponse.json({ error: 'Choose a document type.' }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const fileName = (file.name || 'document').slice(0, 300);
  // A scan, a picture or a Word file has no text this server reads itself. The worker reads it with the outside
  // reader when one is set up, and says so on the document when it is not.
  if (!formatOfFile(fileName, file.type, bytes) && !/\.(png|jpe?g|tiff?|bmp|docx?)$/i.test(fileName)) {
    return NextResponse.json({ error: 'Use a PDF, a scan or a picture of a page, a Word file, an HTML file or a text file.' }, { status: 400 });
  }

  let entities: unknown = [];
  try {
    entities = JSON.parse(String(form.get('entities') || '[]'));
  } catch {
    return NextResponse.json({ error: 'The linked records could not be read.' }, { status: 400 });
  }
  const date = String(form.get('documentDate') || '');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'Write the date as YYYY-MM-DD.' }, { status: 400 });

  const supabase = await supabaseServerClient();
  const id = randomUUID();
  const path = `${clientId}/${id}/${fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
  const mediaType = file.type || 'application/octet-stream';
  const { error: uploadError } = await supabase.storage.from(DOCUMENT_BUCKET).upload(path, bytes, { contentType: mediaType, upsert: false });
  if (uploadError) {
    const denied = /row-level security|not authorized|unauthorized/i.test(uploadError.message);
    return NextResponse.json(
      { error: denied ? 'You cannot add documents for this client.' : `The file could not be stored. ${uploadError.message}` },
      { status: denied ? 403 : 500 },
    );
  }

  const { data, error } = await supabase.rpc('document_create', {
    p_id: id,
    p_client_id: clientId,
    p_type_id: typeId,
    p_title: String(form.get('title') || '').trim() || null,
    p_file_name: fileName,
    p_media_type: mediaType,
    p_size_bytes: bytes.length,
    p_sha256: createHash('sha256').update(bytes).digest('hex'),
    p_storage_path: path,
    p_document_date: date || null,
    p_tags: String(form.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
    p_entity_links: Array.isArray(entities) ? entities : [],
  });
  const row = data as { id: string; title: string; duplicate?: boolean } | null;
  if (error || !row || row.duplicate) {
    // Nothing points at the file just stored: either the record failed, or an earlier copy is kept.
    await supabase.storage.from(DOCUMENT_BUCKET).remove([path]);
  }
  if (error || !row) return NextResponse.json({ error: error?.message || 'The document could not be recorded.' }, { status: 400 });
  return NextResponse.json({ id: row.id, title: row.title, duplicate: row.duplicate === true });
}
