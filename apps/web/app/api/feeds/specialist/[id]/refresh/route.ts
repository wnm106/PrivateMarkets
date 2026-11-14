import { NextRequest, NextResponse } from 'next/server';
import { refreshLoadSession } from '@/lib/feeds/load-sessions';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load data' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await refreshLoadSession(id, clientId));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The mapping could not be refreshed' }, { status: 400 });
  }
}
