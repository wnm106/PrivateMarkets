import { NextRequest, NextResponse } from 'next/server';
import { saveSourceMap } from '@/lib/feeds/load-sessions';
import { requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load data' }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json(await saveSourceMap(id, body.name ? String(body.name) : undefined));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The map could not be saved' }, { status: 400 });
  }
}
