import { NextRequest, NextResponse } from 'next/server';
import { createImportInstance, listImportInstances, listMappingCatalog, listReferenceLists } from '@/lib/feeds/import-instances';
import { requireFeedUser } from '@/lib/feeds/require-user';
import { mappingTargets } from '@/lib/feeds/suggest';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
  try {
    const [catalog, instances, lists] = await Promise.all([listMappingCatalog(), listImportInstances(), listReferenceLists()]);
    return NextResponse.json({
      sourceCode: 'IMPORT',
      name: 'Load data',
      description: 'Upload a tabular file. Columns are discovered, confirmed, and saved as a map for the next file with the same columns.',
      targets: mappingTargets(catalog.attributes, catalog.domains),
      lists,
      instances,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'The import queue could not be loaded' }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const user = await requireFeedUser();
  if (!user) return NextResponse.json({ error: 'Sign in to load a file' }, { status: 401 });
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
