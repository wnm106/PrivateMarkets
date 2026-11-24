import { NextRequest, NextResponse } from 'next/server';
import { identifyFileRecord, searchStoredRecords } from '@tapestrai/mcp-server/src/feeds/import-document';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

/**
 * The stored records of one type a file names or resembles, and, with `q`, the records whose name
 * contains the text. For the screen where a person chooses the record a file is about.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to open the file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client first' }, { status: 400 });
  const { id } = await context.params;
  const recordType = request.nextUrl.searchParams.get('recordType') || '';
  const q = request.nextUrl.searchParams.get('q') || '';
  if (!recordType) return NextResponse.json({ error: 'Say which type of record to choose' }, { status: 400 });
  try {
    const [found, matches] = await Promise.all([identifyFileRecord(id, clientId, recordType), searchStoredRecords(clientId, recordType, q)]);
    return NextResponse.json({ ...found, matches });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The records could not be searched' }, { status: 400 });
  }
}
