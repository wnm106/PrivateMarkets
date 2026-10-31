import { NextRequest, NextResponse } from 'next/server';
import { processImportInstance } from '@/lib/feeds/import-instances';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';
import type { ColumnAssignment } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  try {
    const instance = await processImportInstance(
      id,
      Array.isArray(body.columnMappings) ? body.columnMappings as ColumnAssignment[] : undefined,
      body.asOfDate ? String(body.asOfDate) : undefined,
      undefined,
      clientId
    );
    return NextResponse.json(instance);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The instance could not be processed' }, { status: 400 });
  }
}
