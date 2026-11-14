import { NextRequest, NextResponse } from 'next/server';
import { previewImportInstance } from '@/lib/feeds/import-instances';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';
import type { ColumnAssignment } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Dry run: what a load would do right now. Writes nothing. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const result = await previewImportInstance(
      id,
      clientId,
      Array.isArray(body.columnMappings) ? body.columnMappings as ColumnAssignment[] : undefined,
      body.asOfDate ? String(body.asOfDate) : undefined,
    );
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The preview could not be run' }, { status: 400 });
  }
}
