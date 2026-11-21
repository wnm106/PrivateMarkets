import { NextRequest, NextResponse } from 'next/server';
import { processImportInstance } from '@/lib/feeds/import-instances';
import { requireFeedLoader } from '@/lib/feeds/require-user';
import type { ColumnAssignment } from '@/lib/feeds/suggest';
import type { EntityResolutionDecision } from '@tapestrai/mcp-server/src/feeds/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Load a stored file straight into live records. The loader writes with the
 * service role, so the caller is checked first, with their own session: they
 * need load.promote in the client, the same as promoting a staged batch.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedLoader();
  if ('error' in who) return who.error;
  const { user, clientId } = who;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const instance = await processImportInstance(
      id,
      clientId,
      Array.isArray(body.columnMappings) ? body.columnMappings as ColumnAssignment[] : undefined,
      body.asOfDate ? String(body.asOfDate) : undefined,
      undefined,
      Array.isArray(body.resolutions) ? body.resolutions as EntityResolutionDecision[] : undefined,
      undefined,
      { actorId: user.id },
    );
    return NextResponse.json(instance);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The instance could not be processed' }, { status: 400 });
  }
}
