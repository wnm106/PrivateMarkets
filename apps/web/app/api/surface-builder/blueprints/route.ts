import { NextRequest, NextResponse } from 'next/server';
import { callerClientId } from '@/lib/agent-audit';
import { requireTenantAdmin } from '@/lib/surface-builder/admin-auth';
import {
  BLUEPRINT_LIST_COLUMNS,
  MISSING_TABLE_TEXT,
  blueprintWrite,
  missingTable,
  savedFromRow,
  summaryFromRow,
} from '@/lib/surface-builder/records';

/** Saved Surface Builder blueprints, newest first. */
export async function GET(request: NextRequest) {
  const auth = await requireTenantAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { data, error } = await auth.supabase
    .from('surface_blueprints')
    .select(BLUEPRINT_LIST_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) {
    if (missingTable(error.message)) return NextResponse.json({ blueprints: [], unavailable: MISSING_TABLE_TEXT });
    return NextResponse.json({ error: `Saved blueprints could not be read: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ blueprints: (data || []).map(summaryFromRow) });
}

/**
 * Save a blueprint. Without an id it creates one; with an id it replaces that
 * blueprint's request, prototype and analysis and bumps its revision.
 */
export async function POST(request: NextRequest) {
  const auth = await requireTenantAdmin(request);
  if (auth instanceof NextResponse) return auth;
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'The request could not be read.' }, { status: 400 });
  }
  const write = blueprintWrite(body);
  if (typeof write === 'string') return NextResponse.json({ error: write }, { status: 400 });

  const id = typeof body?.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : null;
  if (id) {
    const { data: current, error: readError } = await auth.supabase
      .from('surface_blueprints')
      .select('revision')
      .eq('id', id)
      .maybeSingle();
    if (readError) {
      if (missingTable(readError.message)) return NextResponse.json({ error: MISSING_TABLE_TEXT }, { status: 503 });
      return NextResponse.json({ error: `The blueprint could not be read: ${readError.message}` }, { status: 500 });
    }
    if (!current) return NextResponse.json({ error: 'That blueprint no longer exists. Save it as new.' }, { status: 404 });
    const { data, error } = await auth.supabase
      .from('surface_blueprints')
      .update({ ...write, revision: (Number(current.revision) || 1) + 1, updated_by: auth.userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) return NextResponse.json({ error: `The blueprint could not be saved: ${error.message}` }, { status: 500 });
    return NextResponse.json({ blueprint: savedFromRow(data) });
  }

  const clientId = await callerClientId(auth.supabase).catch(() => null);
  const { data, error } = await auth.supabase
    .from('surface_blueprints')
    .insert({ ...write, client_id: clientId, created_by: auth.userId, updated_by: auth.userId })
    .select('*')
    .single();
  if (error) {
    if (missingTable(error.message)) return NextResponse.json({ error: MISSING_TABLE_TEXT }, { status: 503 });
    return NextResponse.json({ error: `The blueprint could not be saved: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ blueprint: savedFromRow(data) }, { status: 201 });
}
