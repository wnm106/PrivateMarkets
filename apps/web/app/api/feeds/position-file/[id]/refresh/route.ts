import { NextRequest, NextResponse } from 'next/server';
import { refreshImportInstance } from '@/lib/feeds/import-instances';
import { asFeedCaller } from '@/lib/agent-audit';
import { requireFeedWriter } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedWriter();
  if ('error' in who) return who.error;
  const { user, clientId } = who;
  const { id } = await context.params;
  try {
    return NextResponse.json(await asFeedCaller(user.id, clientId, () => refreshImportInstance(id, clientId)));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be read again' }, { status: 400 });
  }
}
