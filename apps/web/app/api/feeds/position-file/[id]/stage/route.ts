import { NextRequest, NextResponse } from 'next/server';
import { listBatches, stageImportInstance } from '@/lib/feeds/load-batches';
import { canPromoteLoads, feedClientId, requireFeedUser } from '@/lib/feeds/require-user';
import type { ColumnAssignment } from '@/lib/feeds/suggest';
import type { EntityResolutionDecision } from '@tapestrai/mcp-server/src/feeds/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** The batches of this file, newest first, and whether this person may promote one. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  const { id } = await context.params;
  try {
    const [batches, canPromote] = await Promise.all([listBatches(clientId, id), canPromoteLoads(clientId)]);
    return NextResponse.json({ batches, canPromote });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The batches could not be read' }, { status: 400 });
  }
}

/** Stage the file: keep what a load would do, and check it. Writes nothing to live records. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const outcome = await stageImportInstance(id, clientId, {
      columnMappings: Array.isArray(body.columnMappings) ? body.columnMappings as ColumnAssignment[] : undefined,
      asOfDate: body.asOfDate ? String(body.asOfDate) : undefined,
      decisions: Array.isArray(body.resolutions) ? body.resolutions as EntityResolutionDecision[] : undefined,
      userId: user.id,
    });
    return NextResponse.json({ ...outcome, canPromote: await canPromoteLoads(clientId) });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be staged' }, { status: 400 });
  }
}
