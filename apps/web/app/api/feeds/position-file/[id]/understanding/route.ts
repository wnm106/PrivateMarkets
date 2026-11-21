import { NextRequest, NextResponse } from 'next/server';
import { confirmImportUnderstanding, understandImportFile } from '@tapestrai/mcp-server/src/feeds/import-document';
import { feedClientId, requireFeedUser, requireFeedWriter } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

async function caller() {
  const user = await requireFeedUser();
  if (!user) return { error: NextResponse.json({ error: 'Sign in to open the file' }, { status: 401 }) } as const;
  const clientId = await feedClientId();
  if (!clientId) return { error: NextResponse.json({ error: 'Choose a client first' }, { status: 400 }) } as const;
  return { clientId } as const;
}

/** What a stored file is and what was found in it. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await caller();
  if ('error' in who) return who.error;
  const { id } = await context.params;
  try {
    return NextResponse.json(await understandImportFile(id, who.clientId));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be read' }, { status: 400 });
  }
}

/** Records the kind of document a person confirmed the file is, and the stored record it is about. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedWriter('Sign in to open the file');
  if ('error' in who) return who.error;
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json(await confirmImportUnderstanding(id, who.clientId, {
      documentTypeCode: body.documentTypeCode ? String(body.documentTypeCode) : null,
      entityId: body.entityId ? String(body.entityId) : null,
      role: body.role ? String(body.role) : null,
    }));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'That could not be saved' }, { status: 400 });
  }
}
