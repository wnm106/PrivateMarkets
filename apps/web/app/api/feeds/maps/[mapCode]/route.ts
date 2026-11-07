import { NextRequest, NextResponse } from 'next/server';
import { assignmentsFromMap, getReusableMap } from '@/lib/feeds/import-instances';
import { requireFeedUser } from '@/lib/feeds/require-user';
import { feedMapFromAssignments } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ mapCode: string }> }) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to read an import map.' }, { status: 401 });
  const { mapCode } = await context.params;
  try {
    const map = await getReusableMap(decodeURIComponent(mapCode));
    if (!map) return NextResponse.json({ error: `Map ${mapCode} was not found.` }, { status: 404 });
    const feed = feedMapFromAssignments(assignmentsFromMap(map), {
      mapCode: map.mapCode,
      name: map.name,
      description: map.description,
    });
    return NextResponse.json({
      ...map,
      load: {
        sourceCode: feed.sourceCode,
        asOfHintColumn: feed.asOfHintColumn || null,
        domains: feed.domains,
      },
      loadUrl: `/api/feeds/maps/${encodeURIComponent(map.mapCode)}/load`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'The import map could not be read.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
