import { NextRequest, NextResponse } from 'next/server';
import { getImportLocations } from '@/lib/feeds/import-instances';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

/** Where each value of the loaded table sits in the original document. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to open the file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client first' }, { status: 400 });
  const { id } = await context.params;
  try {
    const found = await getImportLocations(id, clientId);
    return NextResponse.json(found || { tableId: null, headers: [], pages: [], locations: [] });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'File not found' }, { status: 404 });
  }
}
