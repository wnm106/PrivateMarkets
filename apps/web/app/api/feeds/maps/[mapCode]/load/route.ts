import { NextRequest, NextResponse } from 'next/server';
import { loadFileWithMap, MapMismatchError } from '@/lib/feeds/import-instances';
import { requireFeedLoader } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

/**
 * Store a file and load it straight into live records with a saved map. The
 * loader writes with the service role, so the caller is checked first, with
 * their own session: they need load.promote in the client, the same as
 * promoting a staged batch.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ mapCode: string }> }) {
  const who = await requireFeedLoader('Sign in to load a file with a saved map.');
  if ('error' in who) return who.error;
  const { user, clientId } = who;
  const { mapCode } = await context.params;
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a CSV, Excel, or PDF file.' }, { status: 400 });
  const asOfDate = form.get('asOfDate');
  const source = form.get('source');
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const instance = await loadFileWithMap(
      decodeURIComponent(mapCode),
      file.name,
      file.type || 'application/octet-stream',
      bytes,
      clientId,
      typeof asOfDate === 'string' && asOfDate ? asOfDate : undefined,
      undefined,
      typeof source === 'string' && source ? source : undefined,
      user.id,
    );
    return NextResponse.json({
      mapCode: instance.mapCode,
      reuse: instance.mapReuse,
      instance,
    });
  } catch (error: unknown) {
    if (error instanceof MapMismatchError) {
      return NextResponse.json({ error: error.message, missingHeaders: error.missingHeaders }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'The file could not be loaded with this map.';
    const status = /was not found/.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
