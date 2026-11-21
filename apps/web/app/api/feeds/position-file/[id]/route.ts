import { NextRequest, NextResponse } from 'next/server';
import { getImportInstance, saveImportInstance, setImportSource } from '@/lib/feeds/import-instances';
import { feedClientId, requireFeedUser, requireFeedWriter } from '@/lib/feeds/require-user';
import type { ColumnAssignment } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client before loading the file' }, { status: 400 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await getImportInstance(id, clientId));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Import instance not found' }, { status: 404 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const who = await requireFeedWriter();
  if ('error' in who) return who.error;
  const { clientId } = who;
  const { id } = await context.params;
  const body = await request.json();
  if ('sourceCode' in body && !Array.isArray(body.columnMappings)) {
    try {
      return NextResponse.json(await setImportSource(id, clientId, body.sourceCode ? String(body.sourceCode) : null));
    } catch (error: any) {
      return NextResponse.json({ error: error?.message || 'The source could not be saved' }, { status: 400 });
    }
  }
  const columnMappings = body.columnMappings as ColumnAssignment[];
  const asOfDate = body.asOfDate ? String(body.asOfDate) : null;
  if (!Array.isArray(columnMappings)) return NextResponse.json({ error: 'Mapping list is required' }, { status: 400 });
  try {
    return NextResponse.json(await saveImportInstance(id, columnMappings, asOfDate, clientId));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The mapping could not be saved' }, { status: 400 });
  }
}
