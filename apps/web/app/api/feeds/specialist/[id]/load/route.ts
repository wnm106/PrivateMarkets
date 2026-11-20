import { NextRequest, NextResponse } from 'next/server';
import { runLoadSession } from '@/lib/feeds/load-sessions';
import { requireFeedLoader } from '@/lib/feeds/require-user';
import type { EntityResolutionDecision } from '@tapestrai/mcp-server/src/feeds/types';

export const dynamic = 'force-dynamic';

/**
 * Load a session's file straight into live records, creating the record types
 * and fields the person accepted. The loader writes with the service role, so
 * the caller is checked first, with their own session: they need load.promote
 * in the client, the same as promoting a staged batch.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedLoader('Sign in to load data');
  if ('error' in who) return who.error;
  const { user, clientId } = who;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const decisions = Array.isArray(body.resolutions) ? body.resolutions as EntityResolutionDecision[] : undefined;
  try {
    return NextResponse.json(await runLoadSession(id, clientId, undefined, decisions, { actorId: user.id }));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be loaded' }, { status: 400 });
  }
}
