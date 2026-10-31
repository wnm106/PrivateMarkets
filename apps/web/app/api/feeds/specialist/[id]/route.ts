import { NextRequest, NextResponse } from 'next/server';
import { answerLoadSession, getLoadSession } from '@/lib/feeds/load-sessions';
import { requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load data' }, { status: 401 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await getLoadSession(id));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Load session not found' }, { status: 404 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load data' }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const session = await answerLoadSession(
      id,
      body.answers && typeof body.answers === 'object' ? body.answers : {},
      Array.isArray(body.acceptedRecommendationIds) ? body.acceptedRecommendationIds.map(String) : undefined,
      Array.isArray(body.dismissedRecommendationIds) ? body.dismissedRecommendationIds.map(String) : undefined
    );
    return NextResponse.json(session);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'That answer could not be applied' }, { status: 400 });
  }
}
