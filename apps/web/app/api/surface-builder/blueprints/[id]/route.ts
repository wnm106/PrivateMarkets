import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAdmin } from '@/lib/surface-builder/admin-auth';
import { MISSING_TABLE_TEXT, missingTable, savedFromRow } from '@/lib/surface-builder/records';

const UUID = /^[0-9a-f-]{36}$/i;

/** One saved blueprint, with its prototype and analysis. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTenantAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such blueprint.' }, { status: 404 });
  const { data, error } = await auth.supabase.from('surface_blueprints').select('*').eq('id', id).maybeSingle();
  if (error) {
    if (missingTable(error.message)) return NextResponse.json({ error: MISSING_TABLE_TEXT }, { status: 503 });
    return NextResponse.json({ error: `The blueprint could not be read: ${error.message}` }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'No such blueprint.' }, { status: 404 });
  return NextResponse.json({ blueprint: savedFromRow(data) });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTenantAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'No such blueprint.' }, { status: 404 });
  const { data, error } = await auth.supabase.from('surface_blueprints').delete().eq('id', id).select('id');
  if (error) return NextResponse.json({ error: `The blueprint could not be deleted: ${error.message}` }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ error: 'No such blueprint.' }, { status: 404 });
  return NextResponse.json({ deleted: id });
}
