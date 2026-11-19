import { NextRequest, NextResponse } from 'next/server';
import { DOCUMENT_BUCKET, formatOfFile } from '@tapestrai/graphql/src/lib/document-content';
import { requireFeedUser } from '@/lib/feeds/require-user';
import { supabaseServerClient } from '@/lib/supabase-server';

/**
 * GET /api/documents/<id>/file
 *
 * The original file of a stored document, shown as a reader would see it.
 * Storage hands an HTML file back as plain text, so a link straight to it
 * shows the markup. Here the file is served with its real type.
 *
 * An HTML document is someone else's page served from this site, so it is
 * boxed in: the sandbox policy gives it no scripts, no forms and an origin of
 * its own, and nothing is loaded from outside it. It can show its text, its
 * inline styles and images embedded in it, and nothing else.
 *
 * Runs as the caller: document_get and the bucket's policy both check that the
 * document belongs to their client.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES = { pdf: 'application/pdf', html: 'text/html', text: 'text/plain; charset=utf-8' } as const;

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to open the file.' }, { status: 401 });
  const { id } = await context.params;
  const supabase = await supabaseServerClient();

  const { data, error } = await supabase.rpc('document_get', { p_id: id });
  const document = data as { storage_path?: string; file_name?: string; media_type?: string | null } | null;
  if (error || !document?.storage_path) return NextResponse.json({ error: 'This document was not found, or you cannot see it.' }, { status: 404 });

  const { data: blob, error: downloadError } = await supabase.storage.from(DOCUMENT_BUCKET).download(document.storage_path);
  if (downloadError || !blob) return NextResponse.json({ error: 'The original file could not be opened.' }, { status: 404 });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // The type comes from the file itself and its name, not from what was claimed at upload.
  const fileName = document.file_name || 'document';
  const format = formatOfFile(fileName, document.media_type, bytes);
  const policy = format === 'html'
    ? "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
    : 'sandbox';
  return new Response(bytes, {
    headers: {
      'Content-Type': format ? TYPES[format] : 'application/octet-stream',
      'Content-Disposition': `${format ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`,
      'Content-Security-Policy': policy,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
