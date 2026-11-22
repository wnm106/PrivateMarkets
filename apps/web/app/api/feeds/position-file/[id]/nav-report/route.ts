import { NextRequest, NextResponse } from 'next/server';
import { readNavReport } from '@tapestrai/mcp-server/src/feeds/nav-report';
import { feedClientId, requireFeedUser } from '@/lib/feeds/require-user';

export const dynamic = 'force-dynamic';

/**
 * What a stored financial report holds and how it maps onto its fund's NAV
 * statement, with a trial load that writes nothing and the reasons it needs a
 * person. The fund is fundId when given, else the first of entityIds, else the
 * fund the report names. The Check a filed report stage reads this.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to open the file' }, { status: 401 });
  const clientId = await feedClientId();
  if (!clientId) return NextResponse.json({ error: 'Choose a client first' }, { status: 400 });
  const { id } = await context.params;
  const params = request.nextUrl.searchParams;
  try {
    return NextResponse.json(await readNavReport(id, clientId, {
      fundId: params.get('fundId') || null,
      entityIds: (params.get('entityIds') || '').split(',').map((value) => value.trim()).filter(Boolean),
      periodEnd: params.get('periodEnd') || null,
      trial: params.get('trial') !== 'false',
    }));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The report could not be read' }, { status: 400 });
  }
}
