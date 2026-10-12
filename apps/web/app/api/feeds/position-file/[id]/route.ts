import { NextRequest, NextResponse } from 'next/server';
import { getImportInstance, saveImportInstance } from '@/lib/feeds/import-instances';
import { requireFeedUser } from '@/lib/feeds/require-user';
import type { ColumnAssignment } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a position file' }, { status: 401 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await getImportInstance(id));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Import instance not found' }, { status: 404 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a position file' }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json();
  const columnMappings = body.columnMappings as ColumnAssignment[];
  const asOfDate = body.asOfDate ? String(body.asOfDate) : null;
  if (!Array.isArray(columnMappings)) return NextResponse.json({ error: 'Mapping list is required' }, { status: 400 });
  try {
    return NextResponse.json(await saveImportInstance(id, columnMappings, asOfDate));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The mapping could not be saved' }, { status: 400 });
  }
}
