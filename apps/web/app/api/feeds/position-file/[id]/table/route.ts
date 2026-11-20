import { NextRequest, NextResponse } from 'next/server';
import { selectImportTable } from '@/lib/feeds/import-instances';
import { asFeedCaller } from '@/lib/agent-audit';
import { requireFeedWriter } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

/** Choose which table of a multi-table file to load. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedWriter();
  if ('error' in who) return who.error;
  const { user, clientId } = who;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  if (!body.tableId) return NextResponse.json({ error: 'Choose a table' }, { status: 400 });
  try {
    return NextResponse.json(await asFeedCaller(user.id, clientId, () => selectImportTable(id, clientId, String(body.tableId))));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The table could not be opened' }, { status: 400 });
  }
}
