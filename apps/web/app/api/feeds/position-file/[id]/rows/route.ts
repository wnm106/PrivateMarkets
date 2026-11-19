import { NextRequest, NextResponse } from 'next/server';
import { getImportRows } from '@/lib/feeds/import-instances';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

/** A window of the rows read from the selected table: ?from=<row index>&count=<rows>. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to open the file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client first' }, { status: 400 });
  const { id } = await context.params;
  const query = request.nextUrl.searchParams;
  try {
    return NextResponse.json(await getImportRows(id, clientId, Number(query.get('from')) || 0, Number(query.get('count')) || 40));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'File not found' }, { status: 404 });
  }
}
