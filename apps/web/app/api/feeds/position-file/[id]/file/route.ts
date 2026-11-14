import { NextRequest, NextResponse } from 'next/server';
import { getImportFile } from '@/lib/feeds/import-instances';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

function viewableType(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return null;
}

/** The original upload, so the review can show where a value was read from. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to open the file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client first' }, { status: 400 });
  const { id } = await context.params;
  try {
    const file = await getImportFile(id, clientId);
    // The type comes from the file name, not from what the browser claimed at upload. Only a PDF or a
    // picture is shown inline. Anything else, HTML included, downloads as plain bytes.
    const viewable = viewableType(file.fileName);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': viewable || 'application/octet-stream',
        'Content-Disposition': `${viewable ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.fileName)}"`,
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'File not found' }, { status: 404 });
  }
}
