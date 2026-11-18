import { NextRequest, NextResponse } from 'next/server';
import { runLoadSession } from '@/lib/feeds/load-sessions';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';
import type { EntityResolutionDecision } from '@tapestrai/mcp-server/src/feeds/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load data' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const decisions = Array.isArray(body.resolutions) ? body.resolutions as EntityResolutionDecision[] : undefined;
  try {
    return NextResponse.json(await runLoadSession(id, clientId, undefined, decisions));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be loaded' }, { status: 400 });
  }
}
