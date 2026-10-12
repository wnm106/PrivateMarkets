import { NextRequest, NextResponse } from 'next/server';
import { createImportInstance, listImportInstances, listMappingCatalog } from '@/lib/feeds/import-instances';
import { POSITION_FILE_MAP } from '@/lib/feeds/position-file-map';
import { requireFeedUser } from '@/lib/feeds/require-user';
import { mappingTargets } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a position file' }, { status: 401 });
  try {
    const [catalog, instances] = await Promise.all([listMappingCatalog(), listImportInstances()]);
    return NextResponse.json({
      sourceCode: POSITION_FILE_MAP.sourceCode,
      name: POSITION_FILE_MAP.name,
      description: POSITION_FILE_MAP.description,
      targets: mappingTargets(catalog.attributes, catalog.domains),
      instances,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The import queue could not be loaded' }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a position file' }, { status: 401 });
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a CSV or Excel file' }, { status: 400 });
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const instance = await createImportInstance(file.name, file.type || 'application/octet-stream', bytes);
    return NextResponse.json(instance);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The file could not be stored' }, { status: 400 });
  }
}
