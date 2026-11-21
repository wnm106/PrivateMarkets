import { NextRequest, NextResponse } from 'next/server';
import { answerLoadSession, getLoadSession } from '@/lib/feeds/load-sessions';
import { feedClientId, requireFeedUser, requireFeedWriter } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load data' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await getLoadSession(id, clientId));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Load session not found' }, { status: 404 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedWriter('Sign in to load data');
  if ('error' in who) return who.error;
  const { clientId } = who;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const session = await answerLoadSession(
      id,
      body.answers && typeof body.answers === 'object' ? body.answers : {},
      Array.isArray(body.acceptedRecommendationIds) ? body.acceptedRecommendationIds.map(String) : undefined,
      Array.isArray(body.dismissedRecommendationIds) ? body.dismissedRecommendationIds.map(String) : undefined,
      clientId
    );
    return NextResponse.json(session);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'That answer could not be applied' }, { status: 400 });
  }
}
