import { NextRequest, NextResponse } from 'next/server';
import { runLoadSession } from '@/lib/feeds/load-sessions';
import { requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load data' }, { status: 401 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await runLoadSession(id));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be loaded' }, { status: 400 });
  }
}
