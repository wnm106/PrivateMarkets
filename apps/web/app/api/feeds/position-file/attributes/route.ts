import { NextRequest, NextResponse } from 'next/server';
import { trackImportAttribute } from '@/lib/feeds/import-instances';
import { canChangeSchema, requireFeedWriter } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

/** Add a field to the catalog for a column that has nowhere to live. */
export async function POST(request: NextRequest) {
  const who = await requireFeedWriter();
  if ('error' in who) return who.error;
  const { clientId } = who;
  if (!(await canChangeSchema(clientId))) {
    return NextResponse.json({ error: 'Adding a field needs permission to change records for this client.' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    const created = await trackImportAttribute({
      domainCode: String(body.domainCode || ''),
      attributeName: String(body.attributeName || ''),
      dataType: body.dataType ? String(body.dataType) : undefined,
      column: body.column ? String(body.column) : undefined,
    }, clientId);
    return NextResponse.json(created);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The field could not be added' }, { status: 400 });
  }
}
