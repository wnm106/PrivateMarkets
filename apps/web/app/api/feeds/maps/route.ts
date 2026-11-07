import { NextResponse } from 'next/server';
import { assignmentsFromMap, listReusableMaps } from '@/lib/feeds/import-instances';
import { requireFeedUser } from '@/lib/feeds/require-user';
import { feedMapFromAssignments } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to read import maps.' }, { status: 401 });
  try {
    const maps = await listReusableMaps();
    return NextResponse.json({
      maps: maps.map((map) => ({
        mapCode: map.mapCode,
        kind: map.kind,
        name: map.name,
        description: map.description,
        headers: map.headers,
        coreHeaders: map.coreHeaders,
        columnCount: map.assignments.length,
        domains: feedMapFromAssignments(assignmentsFromMap(map), { mapCode: map.mapCode }).domains.map((domain) => domain.domainCode),
        loadUrl: `/api/feeds/maps/${encodeURIComponent(map.mapCode)}/load`,
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Import maps could not be listed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
