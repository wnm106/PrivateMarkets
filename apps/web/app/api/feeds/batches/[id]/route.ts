import { NextRequest, NextResponse } from 'next/server';
import { discardBatch, editStagedValue, getBatch, promoteBatch, revertBatch } from '@/lib/feeds/load-batches';
import { canPromoteLoads, canWriteLoads, feedClientId, feedWriteClientId, requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function caller() {
  const user = await requireFeedUser();
  if (!user) return { error: NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 }) } as const;
  const clientId = await feedClientId();
  if (!clientId) return { error: NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 }) } as const;
  return { user, clientId } as const;
}

/** One batch, with its checks when it is still staged. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await caller();
  if ('error' in who) return who.error;
  const { id } = await context.params;
  try {
    const [batch, canPromote] = await Promise.all([getBatch(id, who.clientId), canPromoteLoads(who.clientId)]);
    return NextResponse.json({ batch, canPromote });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The batch could not be read' }, { status: 400 });
  }
}

/**
 * Act on a batch: { action: 'edit', valueId, value, reason }, { action: 'promote', overrideReason },
 * { action: 'revert' } or { action: 'discard' }. Promote and revert change live records and need load.promote.
 * Correcting and discarding change the staged batch and need permission to edit records (entity.write).
 * The batch code writes with the service role, so each is checked first with the caller's own session.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const client = await feedWriteClientId();
  if ('error' in client) return client.error;
  const who = { user, clientId: client.clientId };
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || '');
  try {
    const [canPromote, canWrite] = await Promise.all([canPromoteLoads(who.clientId), canWriteLoads(who.clientId)]);
    if ((action === 'promote' || action === 'revert') && !canPromote) {
      return NextResponse.json({ error: 'You need the load.promote permission to do that. Ask a client admin.' }, { status: 403 });
    }
    if ((action === 'edit' || action === 'discard') && !canWrite) {
      return NextResponse.json({ error: 'Correcting or discarding a batch needs permission to edit records for this client (entity.write). Ask a client admin.' }, { status: 403 });
    }
    let batch;
    if (action === 'edit') {
      batch = await editStagedValue(id, String(body.valueId || ''), who.clientId, {
        value: String(body.value ?? ''),
        reason: body.reason ? String(body.reason) : null,
        userId: who.user.id,
      });
    } else if (action === 'promote') {
      batch = await promoteBatch(id, who.clientId, { userId: who.user.id, overrideReason: body.overrideReason ? String(body.overrideReason) : null });
    } else if (action === 'revert') {
      batch = await revertBatch(id, who.clientId, who.user.id);
    } else if (action === 'discard') {
      batch = await discardBatch(id, who.clientId);
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    return NextResponse.json({ batch, canPromote });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'That could not be done' }, { status: 400 });
  }
}
