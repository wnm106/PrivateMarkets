import { NextRequest, NextResponse } from 'next/server';
import { selectImportTable } from '@/lib/feeds/import-instances';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

/** Choose which table of a multi-table file to load. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  if (!body.tableId) return NextResponse.json({ error: 'Choose a table' }, { status: 400 });
  try {
    return NextResponse.json(await selectImportTable(id, clientId, String(body.tableId)));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The table could not be opened' }, { status: 400 });
  }
}
