import { NextRequest, NextResponse } from 'next/server';
import { saveSourceMap } from '@/lib/feeds/load-sessions';
import { requireFeedWriter } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedWriter('Sign in to load data');
  if ('error' in who) return who.error;
  const { clientId } = who;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json(await saveSourceMap(id, body.name ? String(body.name) : undefined, clientId));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The map could not be saved' }, { status: 400 });
  }
}
