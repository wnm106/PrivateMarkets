import { NextRequest, NextResponse } from 'next/server';
import { processImportInstance } from '@/lib/feeds/import-instances';
import { requireFeedUser } from '@/lib/feeds/require-user';
import type { ColumnAssignment } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a position file' }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  try {
    const instance = await processImportInstance(
      id,
      Array.isArray(body.columnMappings) ? body.columnMappings as ColumnAssignment[] : undefined,
      body.asOfDate ? String(body.asOfDate) : undefined
    );
    return NextResponse.json(instance);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The instance could not be processed' }, { status: 400 });
  }
}
