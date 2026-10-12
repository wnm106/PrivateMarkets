import { NextRequest, NextResponse } from 'next/server';
import { executeFeed, positionFileMap, previewFeed } from '@/lib/feeds/feed-loader';
import { dependencyLoadWaves } from '@/lib/feeds/load-order';
import { supabaseServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

async function requireUser() {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a position file' }, { status: 401 });
  const map = positionFileMap();
  return NextResponse.json({
    mapCode: map.mapCode,
    sourceCode: map.sourceCode,
    name: map.name,
    description: map.description,
    loadWaves: dependencyLoadWaves(map.domains),
    domains: map.domains.map((domain) => ({
      domainCode: domain.domainCode,
      templateCode: domain.templateCode,
      identityColumn: domain.identityColumn,
      nameColumn: domain.nameColumn,
      attributes: domain.attributes,
      parents: domain.parents,
    })),
  });
}

export async function POST(request: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a position file' }, { status: 401 });

  const form = await request.formData();
  const file = form.get('file');
  const mode = String(form.get('mode') || 'preview');
  const asOfDate = String(form.get('asOfDate') || '');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Choose a CSV or Excel file' }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const map = positionFileMap();

  try {
    if (mode === 'load') {
      if (!asOfDate) return NextResponse.json({ error: 'Choose today or a specific as-of date' }, { status: 400 });
      const result = await executeFeed(map, file.name, bytes, asOfDate);
      return NextResponse.json(result);
    }
    const preview = await previewFeed(map, file.name, bytes);
    return NextResponse.json(preview);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The position file could not be read' }, { status: 400 });
  }
}
