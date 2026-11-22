import { NextRequest, NextResponse } from 'next/server';
import { refreshLoadSession } from '@/lib/feeds/load-sessions';
import { asFeedCaller } from '@/lib/agent-audit';
import { requireFeedWriter } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedWriter('Sign in to load data');
  if ('error' in who) return who.error;
  const { user, clientId } = who;
  const { id } = await context.params;
  try {
    return NextResponse.json(await asFeedCaller(user.id, clientId, () => refreshLoadSession(id, clientId)));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The mapping could not be refreshed' }, { status: 400 });
  }
}
